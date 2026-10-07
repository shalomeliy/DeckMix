import { BEATS_PER_BAR, nextBarLineSec } from '@/core/beatgrid'
import { barLineAtOrAfterSec, barLineAtOrBeforeSec, effectiveTimeline, type VocalManualTag } from '@/core/sound/vocal-manual'
import { vocalStateText, voiceRuns, type VocalResult, type VocalTimeline } from '@/core/sound/vocal-timeline'
import type { BeatGrid } from '@/core/types'
import { KICK_LOCK_PLAIN_SHIFT_BARS } from '@/core/kick-lock'

/**
 * Mix Assist by sound (v0.9.15): the "vocal handoff" the owner describes as a good mix (24/09, his words roughly): song A plays; B comes in
 * under it with only its drums; the moment A's voice ends, B's voice comes in; then A goes down slowly. The rule: **a voice never over a
 * voice; drums together are fine.**
 *
 * "Only drums" is done first by WHERE B enters — in a stretch of B that has no voice — and not by separated channels: the app has no
 * stems, and fading separated channels one by one is the method the patent in ROADMAP.md v0.9.15 covers. Choosing the moment by the voice
 * timeline is a different method, and this file stays on that side. On top of that the mixer's own EQ does what a DJ's hands do on any
 * mixer (v0.9.16 MID, v0.9.18 the whole bass swap): `core/eq-mix.ts`, driven along this file's plan.
 *
 * Everything is counted in bars. With SYNC on, B's beats follow A's, so N bars of A and N bars of B take the same time, whatever the two
 * BPMs are; each side converts bars to its own track seconds with its own grid. That holds only when SYNC plays B straight: since v0.8.36 it
 * plays B half- or double-time when straight is out of the fader's reach, and then B runs through 2 (or ½) of its bars per bar of A. The
 * caller does not plan in that case and says why (`HANDOFF_NEEDS_STRAIGHT_SYNC`). The plan is clean by construction: before the handoff B is
 * in a stretch with no voice; after it A is in a stretch with no voice until it is fully out.
 *
 * Voice is read as the countdown reads it (`voiceRuns`): `unsure` counts as voice and a gap of 2 s or less is still voice (`COUNTDOWN_MERGE_GAP_SEC`: too short to bring another singer in),
 * so a plan never promises a quiet stretch the strip only drew dashed. Pure.
 */

/** Shown instead of handoff rows when SYNC would play the incoming deck half- or double-time (see the doc comment above). */
export const HANDOFF_NEEDS_STRAIGHT_SYNC = 'מסירת שירה: הדקים יסונכרנו בחצי או בכפול קצב — המסירה מחושבת רק לקצב ישר'

/** The fewest bars B plays under A before the handoff — less is not "coming in with the drums", it is a cut. Half a phrase (v0.9.17: the
 * runway is a whole `PHRASE_BARS`, or this when B has less quiet than that). Chosen, not measured. */
export const MIN_RUNWAY_BARS = 4
/** A is taken down over at least this many bars — "slowly" (his word) — and only inside A's own quiet stretch. Chosen, not measured. */
export const MIN_FADE_BARS = 4
/** …and at most this many: a longer quiet stretch is not a reason to keep A in the mix longer. */
export const MAX_FADE_BARS = 8

export interface HandoffSide {
  timeline: VocalTimeline
  grid: BeatGrid
  durationSec: number
}

export interface HandoffPlan {
  /** A track seconds, a yellow line on A: B starts playing here. */
  joinSec: number
  /** B track seconds, a yellow line on B: where B starts — inside a stretch of B with no voice. */
  entrySec: number
  /** A track seconds: A's voice is over (or A is already quiet) and B's voice comes in. A starts going down here. */
  handoffSec: number
  /** B track seconds of the same moment: the yellow line B's voice starts on (at or just before the voice itself). */
  bVoiceSec: number
  /** A track seconds: A is fully out, and the transition is finished. */
  fadeEndSec: number
  runwayBars: number
  fadeBars: number
  /** True when the handoff is at the end of one of A's voices; false when A was already quiet there and the handoff is later in that quiet. */
  onVoiceEnd: boolean
}

/**
 * One deck's side of a handoff, from what the deck already has: his marks over the computer's strip, exactly what the vocal strip's timers
 * read (`effectiveTimeline`). When something is missing the answer is the reason in words, never a side with an empty timeline — an empty
 * timeline would read as "no voice" and promise a clean mix nothing was measured for.
 */
export function handoffSide(
  vocal: VocalResult | undefined,
  tag: Pick<VocalManualTag, 'regions' | 'finished'> | undefined,
  grid: BeatGrid | null,
  durationSec: number,
): HandoffSide | { missing: string } {
  if (!grid || !(grid.bpm > 0)) return { missing: 'אין גריד' }
  if (!(durationSec > 0)) return { missing: 'השיר עוד נטען' }
  const timeline = effectiveTimeline(vocal?.timeline ?? null, tag, durationSec)
  if (!timeline) {
    if (!vocal) return { missing: 'שירה: לא נותח עדיין' }
    return { missing: vocalStateText(vocal.state, vocal.note) ?? 'שירה: אין ניתוח' }
  }
  return { timeline, grid, durationSec }
}

const barSec = (grid: Pick<BeatGrid, 'bpm'>) => (60 / grid.bpm) * BEATS_PER_BAR

/**
 * v0.9.23: how much of the incoming song must still be left once a Mix Assist transition is over. The owner (05/10, a screenshot): a
 * handoff row offered a 2:24 song's last voice, at 2:18 — B came in, took over, and was over before A had even finished going down. The
 * row was "clean" by every rule here; none asked whether B would still be playing. 24 bars is the next mix's own room (a whole runway and
 * the longest fade, 8 + 8) and 8 more to hear the song on its own. Chosen, not measured.
 */
export const MIN_BARS_AFTER_MIX = 24
/** The bar length assumed when the incoming song has no grid yet: 120 BPM, a common floor for this library's dance music. */
const FALLBACK_BAR_SEC = 2

/** The incoming song still has `MIN_BARS_AFTER_MIX` of its own bars after `mixEndSec` (its own track seconds). */
export function enoughSongAfterMix(durationSec: number, grid: Pick<BeatGrid, 'bpm'> | null, mixEndSec: number): boolean {
  const bar = grid && grid.bpm > 0 ? barSec(grid) : FALLBACK_BAR_SEC
  return durationSec - mixEndSec >= MIN_BARS_AFTER_MIX * bar - EPS
}

/**
 * Where a plain (energy-point) transition is over, in B's own seconds, when B enters at `entrySec` with a `crossfadeSec` fade. The fade is
 * seconds of the room's time, not of B's: with SYNC, B covers more of its own seconds when it is sped up, and the entry moves up to half a
 * bar to land on a bar line. Half again of the fade and one bar of B cover both; the 24-bar margin is the real rule. v0.9.26: one function
 * for the panel's energy points, a saved "Mix in" pad and an excellent pair — the last two skipped the check until then.
 */
export function plainMixEndInB(entrySec: number, grid: Pick<BeatGrid, 'bpm'> | null, crossfadeSec: number): number {
  // One bar more since v0.9.33: the kick lock may start the mix up to `KICK_LOCK_PLAIN_SHIFT_BARS` late, while B already plays (silent).
  return entrySec + crossfadeSec * 1.5 + (1 + KICK_LOCK_PLAIN_SHIFT_BARS) * (grid && grid.bpm > 0 ? barSec(grid) : FALLBACK_BAR_SEC)
}

/** Where a handoff is over, in B's own seconds: B's voice comes in on the handoff, and A goes down over `fadeBars` bars after it. */
export function handoffEndInB(plan: HandoffPlan, bGrid: BeatGrid): number {
  return plan.bVoiceSec + plan.fadeBars * barSec(bGrid)
}
const EPS = 1e-6

/** A's stretches with no voice that are not over yet at `fromSec`, each as [from, to) in A seconds. Also the vocal swap's (`core/vocal-swap-mix.ts`). */
export function quietStretches(side: HandoffSide, fromSec: number): { from: number; to: number; afterVoice: boolean }[] {
  const runs = voiceRuns(side.timeline, side.durationSec)
  const out: { from: number; to: number; afterVoice: boolean }[] = []
  let prev = 0
  let afterVoice = false
  for (const r of runs) {
    if (r.from > prev) out.push({ from: prev, to: r.from, afterVoice })
    prev = r.to
    afterVoice = true
  }
  if (side.durationSec > prev) out.push({ from: prev, to: side.durationSec, afterVoice })
  return out.filter((q) => q.to > fromSec)
}

/** Where B's voices start, each with the stretch of no voice before it (B seconds), on yellow lines. */
export interface BVoiceStart {
  /** The yellow line at or before the voice: what the handoff lines up with. */
  voiceSec: number
  /** Whole bars of B with no voice before `voiceSec`. */
  quietBars: number
}

export function bVoiceStarts(side: HandoffSide): BVoiceStart[] {
  const runs = voiceRuns(side.timeline, side.durationSec)
  const bar = barSec(side.grid)
  const out: BVoiceStart[] = []
  let prevEnd = 0
  for (const r of runs) {
    const voiceSec = barLineAtOrBeforeSec(r.from + EPS, side.grid)
    // The runway must lie wholly in the quiet before this voice and inside the song: the first yellow line at or after both.
    const earliest = barLineAtOrAfterSec(Math.max(prevEnd, 0), side.grid)
    const quietBars = Math.floor((voiceSec - earliest) / bar + EPS)
    if (quietBars >= MIN_RUNWAY_BARS) out.push({ voiceSec, quietBars })
    prevEnd = r.to
  }
  return out
}

/**
 * v0.9.17, the owner (05/10): "the moment I clicked one of the Mix Assist options you mixed right away instead of waiting for the right
 * moment … you are supposed to know when to come in by where the verses start". Electronic music moves in phrases of 8 bars; a DJ brings the
 * new song in where a new phrase of the playing song starts, never on just any bar. Until v0.9.16 the energy points joined on A's NEXT
 * yellow line (v0.8.14), and the handoff shortened its runway — or slid the handoff into A's quiet — until the join fit "now".
 */
export const PHRASE_BARS = 8

/**
 * Where a new phrase of A starts, after `positionSec`. The phrase lines are counted from where A's voice starts or stops — his own marks,
 * which sit on yellow lines and are where the verses really start — not from the grid's first line: the grid only knows bars, and an
 * intro of 6 bars would put every count from it two bars off. Counted from the last voice change at or before the playhead (or, still in
 * the intro, back from the first one ahead); the next voice change itself is also a phrase start, since a verse need not be a multiple of
 * 8 bars. With no voice at all, the count runs from the grid's first yellow line, and `by` says so; with no phrase start left before A's
 * last `MIN_FADE_BARS`, the next yellow line (`by: 'end'`).
 */
export function nextPhraseStartSec(
  grid: BeatGrid,
  timeline: VocalTimeline | null,
  durationSec: number,
  positionSec: number,
): { sec: number; by: 'voice' | 'grid' | 'end' } {
  const bar = barSec(grid)
  const phrase = PHRASE_BARS * bar
  const after = positionSec + EPS
  const changes: number[] = []
  if (timeline) {
    for (const r of voiceRuns(timeline, durationSec)) {
      changes.push(barLineAtOrBeforeSec(r.from + EPS, grid), barLineAtOrAfterSec(r.to, grid))
    }
  }
  // Sorted: a voice end goes forward to its line and the next start back to its own, and under a bar apart the two can cross.
  changes.sort((x, y) => x - y)
  const anchor = [...changes].reverse().find((c) => c <= after) ?? changes[0]
  const by = anchor == null ? 'grid' : 'voice'
  const from = anchor ?? grid.offsetSec
  let sec = from + Math.floor((after - from) / phrase + 1) * phrase
  if (sec <= after) sec += phrase
  const nextChange = changes.find((c) => c > after)
  if (nextChange != null && nextChange < sec - EPS) sec = nextChange
  // No phrase start left with A still playing long enough to be faded out (review, 05/10): a click in A's last bars would otherwise wait
  // past the song's end — A stops, B never starts, the room goes silent. The next bar instead, as before v0.9.17, and `by` says so.
  if (sec > durationSec - MIN_FADE_BARS * bar) return { sec: nextBarLineSec(after, grid), by: 'end' }
  return { sec, by }
}

/**
 * The earliest clean handoff into B's voice at `bVoice`, with A at `aPositionSec` now. Null when none is left in A — the caller says so in
 * words, and the plain transition stays available.
 *
 * v0.9.17: the runway is a whole phrase (`PHRASE_BARS`), or half of one when B has fewer quiet bars than that, and it is never cut short to
 * fit the playhead; the handoff is at A's voice end, or a whole phrase after it while A is still quiet. When that is already too close, the
 * plan waits for A's next voice end — the join lands where a new phrase of A starts, never on just the next bar.
 */
export function planHandoff(a: HandoffSide, aPositionSec: number, b: HandoffSide, bVoice: BVoiceStart): HandoffPlan | null {
  const barA = barSec(a.grid)
  const barB = barSec(b.grid)
  // B needs a beat of A to join on: the next yellow line still ahead (a join exactly on the playhead would already be behind it by the next frame).
  const firstJoin = nextBarLineSec(aPositionSec + EPS, a.grid)
  const runway = bVoice.quietBars >= PHRASE_BARS ? PHRASE_BARS : MIN_RUNWAY_BARS
  if (bVoice.quietBars < runway) return null
  for (const q of quietStretches(a, aPositionSec)) {
    // A's voice ends mid-bar more often than not: the handoff waits for the yellow line after it, so A is quiet from there on.
    const voiceEnd = barLineAtOrAfterSec(q.from, a.grid)
    for (let handoffSec = voiceEnd; ; handoffSec += PHRASE_BARS * barA) {
      const fadeBars = Math.min(MAX_FADE_BARS, Math.floor((q.to - handoffSec) / barA + EPS))
      if (fadeBars < MIN_FADE_BARS) break
      if (handoffSec - runway * barA < firstJoin - EPS) continue
      return {
        joinSec: handoffSec - runway * barA,
        entrySec: bVoice.voiceSec - runway * barB,
        handoffSec,
        bVoiceSec: bVoice.voiceSec,
        // Clamped: the floor above allows a hair past the quiet's end, and when that end is the song's end the engine's position is clamped
        // to the duration and would never reach a fade end beyond it — the transition would hang just short of finishing.
        fadeEndSec: Math.min(q.to, handoffSec + fadeBars * barA),
        runwayBars: runway,
        fadeBars,
        onVoiceEnd: q.afterVoice && handoffSec === voiceEnd,
      }
    }
  }
  return null
}

/**
 * The second signal next to each energy point (v0.9.15, the spec: "drums similar · voices clash" as SEPARATE marks, never one merged score):
 * would the plain transition — B from `entrySec`, starting at `joinSec` (A's next yellow line when not given), `fadeSec` of crossfade — put a voice over a voice? Returns
 * the first A second where both sing, or null when it is clean. B's seconds advance by beats, as with SYNC on; `syncMult` is SYNC's own
 * half/double reading (`syncMultiplier`: B counts as `b.bpm × syncMult`).
 *
 * Careful on purpose, because "clean" is a promise: the real entry moves up to half a bar to land yellow on yellow (`phaseAlignedEntrySec`),
 * and the fade is wall-clock seconds, not A's, once A's tempo is off its original — so B's voices are widened by half a bar of B each side
 * and the window by half a bar of A at the end. A false "clash" costs a look; a false "clean" costs a voice over a voice.
 */
export function plainTransitionClashSec(
  a: HandoffSide,
  aPositionSec: number,
  b: HandoffSide,
  entrySec: number,
  fadeSec: number,
  syncMult: number = 1,
  /** v0.9.17: where B really joins — A's next phrase start (`nextPhraseStartSec`). Without it, A's next yellow line (the join until then). */
  joinSec: number | null = null,
): number | null {
  const join = joinSec ?? nextBarLineSec(aPositionSec + EPS, a.grid)
  const ratio = a.grid.bpm / (b.grid.bpm * syncMult)
  const halfBarB = barSec(b.grid) / 2
  // v0.9.33: a plain transition may start up to `KICK_LOCK_PLAIN_SHIFT_BARS` late, held until B's kicks sit on A's — both still audible after.
  const end = join + fadeSec + barSec(a.grid) / 2 + KICK_LOCK_PLAIN_SHIFT_BARS * barSec(a.grid)
  const aRuns = voiceRuns(a.timeline, a.durationSec)
  const bRuns = voiceRuns(b.timeline, b.durationSec)
  const toA = (bSec: number) => join + (bSec - entrySec) / ratio
  let first: number | null = null
  for (const ra of aRuns) {
    const lo = Math.max(ra.from, join)
    const hi = Math.min(ra.to, end)
    if (hi <= lo) continue
    for (const rb of bRuns) {
      const blo = Math.max(lo, toA(rb.from - halfBarB))
      const bhi = Math.min(hi, toA(rb.to + halfBarB))
      if (bhi > blo && (first === null || blo < first)) first = blo
    }
  }
  return first
}
