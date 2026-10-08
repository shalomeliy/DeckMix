import { BEATS_PER_BAR, nextBarLineSec } from '@/core/beatgrid'
import { barLineAtOrAfterSec, barLineAtOrBeforeSec, effectiveTimeline, type VocalManualTag } from '@/core/sound/vocal-manual'
import { vocalStateText, voiceRuns, type VocalResult, type VocalTimeline } from '@/core/sound/vocal-timeline'
import type { BeatGrid } from '@/core/types'
import { KICK_LOCK_PLAIN_SHIFT_BARS } from '@/core/kick-lock'

/**
 * Mix Assist by sound (v0.9.15): the "vocal handoff". Until v0.9.63 it was the mix the owner described on 24/09: B comes in under A with only
 * its drums, B's voice comes in the moment A's ends, then A goes down. **v0.9.63, the owner (07/10): "the suggestions have to come after the
 * singing in the outgoing song is over, and only then the incoming song joins — you bring me into the mix in the middle of the outgoing
 * song's singing and it sounds bad."** Measured on his own marks (93 songs, `docs/research/vocal-entry-timing.md`): 84% of the old plans
 * put B's drums under A's last lines, a median 13 s. He chose, on a card, the same rule for the handoff as for every other way in: B starts on
 * the yellow line where A's voice is over, plays a run-in of N bars with no voice while A goes down, and sings when A is gone. N is the
 * longest of `RUN_IN_BARS` that fits both quiets (the research: 16 bars in house and techno, 8 when there is no room, 4 at least).
 *
 * "Only drums" is done first by WHERE B enters — in a stretch of B that has no voice — and not by separated channels: the app has no
 * stems, and fading separated channels one by one is the method the patent in ROADMAP.md v0.9.15 covers. Choosing the moment by the voice
 * timeline is a different method, and this file stays on that side. On top of that the mixer's own EQ does what a DJ's hands do on any
 * mixer (v0.9.16 MID, v0.9.18 the whole bass swap): `core/eq-mix.ts`, driven along this file's plan.
 *
 * Everything is counted in bars. With SYNC on, B's beats follow A's, so N bars of A and N bars of B take the same time, whatever the two
 * BPMs are; each side converts bars to its own track seconds with its own grid. That holds only when SYNC plays B straight: since v0.8.36 it
 * plays B half- or double-time when straight is out of the fader's reach, and then B runs through 2 (or ½) of its bars per bar of A. The
 * caller does not plan in that case and says why (`HANDOFF_NEEDS_STRAIGHT_SYNC`). The plan is clean by construction: from the join until A is
 * fully out, A is in a stretch with no voice, and B is in one until its voice line — which is where A is out.
 *
 * Voice is read as the countdown reads it (`voiceRuns`): `unsure` counts as voice and a gap of 2 s or less is still voice (`COUNTDOWN_MERGE_GAP_SEC`: too short to bring another singer in),
 * so a plan never promises a quiet stretch the strip only drew dashed. Pure.
 */

/** Shown instead of handoff rows when SYNC would play the incoming deck half- or double-time (see the doc comment above). */
export const HANDOFF_NEEDS_STRAIGHT_SYNC = 'מסירת שירה: הדקים יסונכרנו בחצי או בכפול קצב — המסירה מחושבת רק לקצב ישר'

/** The fewest bars B plays with no voice before it sings — less is not a run-in, it is a cut. Half a phrase. Chosen, not measured. */
export const MIN_RUNWAY_BARS = 4
/** A is taken down over at least this many bars — "slowly" (his word) — and only inside A's own quiet stretch. Chosen, not measured. */
export const MIN_FADE_BARS = 4
/**
 * v0.9.63: the run-ins a handoff picks from, longest first — B's bars with no voice between A's voice end and B's voice line, A going down
 * over all of them. 16 is what DJs use in house and techno, 8 when there is no room, 4 the least (`docs/research/vocal-entry-timing.md`:
 * transitions in 1,557 real sets pile up on multiples of 8 bars). On his songs (07/10) Mizrahi mostly fits only 4; which of the three sounds
 * best is his ear's call, not this file's.
 */
export const RUN_IN_BARS = [16, 8, MIN_RUNWAY_BARS] as const

export interface HandoffSide {
  timeline: VocalTimeline
  grid: BeatGrid
  durationSec: number
  /**
   * The deck's per-bucket low/mid/high energy (`Deck.bands`, 3 per bucket), when the song has been analysed. Only the vocal swap reads it,
   * to find where an incoming song's bass starts (`bassEntrySec`); without it that mix behaves as it did before.
   */
  bands?: Float32Array | null
}

export interface HandoffPlan {
  /** A track seconds, a yellow line on A: A's voice is over (or A is already quiet), and B starts playing here. */
  joinSec: number
  /** B track seconds, a yellow line on B: where B starts — `runwayBars` before its voice, inside a stretch of B with no voice. */
  entrySec: number
  /** A track seconds: the bass swap, halfway through the run-in (`core/eq-mix.ts`'s `swapSec`). */
  handoffSec: number
  /** B track seconds: the yellow line B's voice starts on (at or just before the voice itself). B is there when A is at `fadeEndSec`. */
  bVoiceSec: number
  /** A track seconds: A is fully out and B's voice comes in — the transition is finished. */
  fadeEndSec: number
  /** Bars from the join to B's voice: one of `RUN_IN_BARS`. A goes down over all of them. */
  runwayBars: number
  /** True when the join is at the end of one of A's voices; false when A was already quiet there and the join is later in that quiet. */
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

/** Where a handoff is over, in B's own seconds: since v0.9.63 A is out when B's voice comes in. */
export function handoffEndInB(plan: Pick<HandoffPlan, 'bVoiceSec'>): number {
  return plan.bVoiceSec
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
 * words.
 *
 * v0.9.63: B joins where A's voice is over — the yellow line after it, or a whole phrase later while A is still quiet (v0.9.17's phrase rule,
 * never on just the next bar) — and sings `runwayBars` later, with A gone by then. The run-in is the longest of `RUN_IN_BARS` that fits A's
 * quiet from the join and B's quiet before its voice; when none fits here, the next phrase line in the same quiet is tried (it can only have
 * less room), then A's next voice end.
 */
export function planHandoff(a: HandoffSide, aPositionSec: number, b: HandoffSide, bVoice: BVoiceStart): HandoffPlan | null {
  const barA = barSec(a.grid)
  const barB = barSec(b.grid)
  // B needs a beat of A to join on: the next yellow line still ahead (a join exactly on the playhead would already be behind it by the next frame).
  const firstJoin = nextBarLineSec(aPositionSec + EPS, a.grid)
  if (bVoice.quietBars < MIN_RUNWAY_BARS) return null
  for (const q of quietStretches(a, aPositionSec)) {
    // A's voice ends mid-bar more often than not: the join waits for the yellow line after it, so A is quiet from there on.
    const voiceEnd = quietPhraseStart(a, q)
    for (let joinSec = voiceEnd; ; joinSec += PHRASE_BARS * barA) {
      const aQuietBars = Math.floor((q.to - joinSec) / barA + EPS)
      const runway = RUN_IN_BARS.find((n) => n <= aQuietBars && n <= bVoice.quietBars)
      if (runway == null) break
      if (joinSec < firstJoin - EPS) continue
      return {
        joinSec,
        entrySec: bVoice.voiceSec - runway * barB,
        // On a yellow line: every run-in is an even number of bars.
        handoffSec: joinSec + (runway / 2) * barA,
        bVoiceSec: bVoice.voiceSec,
        // Clamped: the floor above allows a hair past the quiet's end, and when that end is the song's end the engine's position is clamped
        // to the duration and would never reach a fade end beyond it — the transition would hang just short of finishing.
        fadeEndSec: Math.min(q.to, joinSec + runway * barA),
        runwayBars: runway,
        onVoiceEnd: q.afterVoice && joinSec === voiceEnd,
      }
    }
  }
  return null
}

/**
 * v0.9.63: where a plain transition (an energy point, a "Mix in" pad, an excellent pair moved off A's voice) joins — the first yellow line
 * from `positionSec` on where A is not singing and stays so for `needSec` of A (the whole mix), and A plays on for at least `MIN_FADE_BARS`
 * after it. Like `planHandoff`'s join: at the end of A's voice, or whole phrases after it while A is still quiet — never on just any bar.
 * Null when A has no such moment left; the caller then says, in words, that the mix will run over A's voice.
 */
export function quietJoinSec(a: HandoffSide, positionSec: number, needSec: number): { sec: number; onVoiceEnd: boolean } | null {
  const bar = barSec(a.grid)
  const firstJoin = nextBarLineSec(positionSec + EPS, a.grid)
  const lastJoin = a.durationSec - MIN_FADE_BARS * bar
  for (const q of quietStretches(a, positionSec)) {
    const voiceEnd = quietPhraseStart(a, q)
    for (let sec = voiceEnd; sec + needSec <= q.to + EPS && sec <= lastJoin + EPS; sec += PHRASE_BARS * bar) {
      if (sec >= firstJoin - EPS) return { sec, onVoiceEnd: q.afterVoice && sec === voiceEnd }
    }
  }
  return null
}

/**
 * The first phrase line of one of A's quiet stretches: the yellow line after A's voice ends. In A's intro there is no voice end, so the
 * phrases are counted back from the line A's first voice starts on — as `nextPhraseStartSec` counts them — not forward from the song's
 * first line: an intro of 6 bars would otherwise put the two counts 2 bars apart (independent review, 07/10). A song with no voice at all
 * counts from its first line, as `nextPhraseStartSec` does.
 */
function quietPhraseStart(a: HandoffSide, q: { from: number; to: number; afterVoice: boolean }): number {
  const first = barLineAtOrAfterSec(q.from, a.grid)
  if (q.afterVoice || q.to >= a.durationSec - EPS) return first
  const phrase = PHRASE_BARS * barSec(a.grid)
  const voiceLine = barLineAtOrBeforeSec(q.to + EPS, a.grid)
  return voiceLine - Math.floor((voiceLine - first) / phrase + EPS) * phrase
}

/** v0.9.63: the first A second in [`fromSec`, `toSec`) where A sings, or null. The check behind every "voice: clean" since A's voice counts too. */
export function firstVoiceInSec(a: HandoffSide, fromSec: number, toSec: number): number | null {
  for (const r of voiceRuns(a.timeline, a.durationSec)) {
    const lo = Math.max(r.from, fromSec)
    // EPS: a yellow line computed from the grid can land a float hair before the voice end it was snapped to (170.99999999999892 against a
    // voice to 171, on one of his House songs) — not a voice in the window.
    if (Math.min(r.to, toSec) > lo + EPS) return lo
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
