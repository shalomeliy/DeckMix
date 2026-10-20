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
 * **v0.12.13, the owner again (19/10): waiting for A's quiet is no longer a rule for any mix, and this one goes back to B under A's last lines — but
 * with B's voice landing exactly where A's transition ends** (`planHandoff`'s own comment).
 *
 * "Only drums" is done first by WHERE B enters — in a stretch of B that has no voice — and not by separated channels: the app has no
 * stems, and fading separated channels one by one is the method the patent in ROADMAP.md v0.9.15 covers. Choosing the moment by the voice
 * timeline is a different method, and this file stays on that side. On top of that the mixer's own EQ does what a DJ's hands do on any
 * mixer (v0.9.16 MID, v0.9.18 the whole bass swap): `core/eq-mix.ts`, driven along this file's plan.
 *
 * Everything is counted in bars. With SYNC on, B's beats follow A's, so N bars of A and N bars of B take the same time, whatever the two
 * BPMs are; each side converts bars to its own track seconds with its own grid. That holds only when SYNC plays B straight: since v0.8.36 it
 * plays B half- or double-time when straight is out of the fader's reach, and then B runs through 2 (or ½) of its bars per bar of A. The
 * caller does not plan in that case and says why (`HANDOFF_NEEDS_STRAIGHT_SYNC`). Since v0.12.13 B's drums play under A's last lines on
 * purpose; what stays clean by construction is B's quiet until its voice line, which is where A's transition ends.
 *
 * Voice is read as the countdown reads it (`voiceRuns`): `unsure` counts as voice and a gap of 2 s or less is still voice (`COUNTDOWN_MERGE_GAP_SEC`: too short to bring another singer in),
 * so a plan never promises a quiet stretch the strip only drew dashed. Pure.
 */

/** Shown instead of handoff rows when SYNC would play the incoming deck half- or double-time (see the doc comment above). */
export const HANDOFF_NEEDS_STRAIGHT_SYNC = 'מסירת שירה: הדקים יסונכרנו בחצי או בכפול קצב — המסירה מחושבת רק לקצב ישר'

/** The fewest bars B plays with no voice before it sings — less is not a run-in, it is a cut. Half a phrase. Chosen, not measured. */
export const MIN_RUNWAY_BARS = 4
/** A is taken down over this many bars after B's voice comes in — "slowly" (his word). Chosen, not measured. */
export const MIN_FADE_BARS = 4

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
  /** A track seconds, a yellow line on A: B starts playing here, under A's last bars of singing (v0.12.13). */
  joinSec: number
  /** B track seconds, a yellow line on B: where B starts — `runwayBars` before its voice, inside a stretch of B with no voice. */
  entrySec: number
  /** A track seconds: the end of A's transition — B's voice comes in and the bass swaps here (`core/eq-mix.ts`'s `swapSec`). */
  handoffSec: number
  /** B track seconds: the yellow line B's voice starts on (at or just before the voice itself). B is there when A is at `fadeEndSec`. */
  bVoiceSec: number
  /** A track seconds: A is fully out, `MIN_FADE_BARS` after `handoffSec` — the transition is finished. */
  fadeEndSec: number
  /** Bars from the join to B's voice: A's transition plus the bars B plays under A's last singing (v0.12.13). */
  runwayBars: number
  /** True when the join is at the end of one of A's voices; false when A was already quiet there and the join is later in that quiet. */
  onVoiceEnd: boolean
  /** v0.12.13: A track seconds, the yellow line A's last line of this handoff ends on — B has been playing under it for a few bars. */
  aVoiceEndSec: number
  /** v0.12.13: bars of A's transition, from `aVoiceEndSec` to B's voice (`handoffSec`). */
  transitionBars: number
  /** v0.12.13: B track seconds where A is out — `MIN_FADE_BARS` after B's voice line. */
  bMixEndSec: number
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

/** Where a handoff is over, in B's own seconds: since v0.12.13 A goes down after B's voice comes in, so `MIN_FADE_BARS` of B later. */
export function handoffEndInB(plan: Pick<HandoffPlan, 'bMixEndSec'>): number {
  return plan.bMixEndSec
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
 * v0.12.13, the owner (19/10), replacing v0.9.63's order for this mix only: "only when you join a voice of the outgoing song to a voice of
 * the incoming one must there be a separation — the outgoing song's last line ends, a transition plays, and right as the transition ends the
 * incoming song comes in, sitting perfectly on the beats". His steps: (1) A plays with its voice and bass; (2) B comes in, drums only — its
 * bass killed (his card, 19/10) — while A still sings; (3) A's voice ends and A's transition plays; (4) B's voice starts the moment that
 * transition ends; (5) A's voice band goes, then its sound and bass (`core/eq-mix.ts`, with the swap on B's voice line).
 *
 * A's transition: the quiet after one of A's voices, up to one phrase (`PHRASE_BARS`) — or less when A sings again sooner. B plays under
 * A's last bars of singing for `UNDER_A_BARS`, at least `MIN_UNDER_A_BARS`. Measured on his marks before building
 * (`/mnt/project-files/research/handoff-transition-2026-10-19/results.md`): with 4 bars under A, 64% of same-genre pairs had any such
 * moment (failed the rule set beforehand); with 2, 75% (passed). So 4 when B's quiet allows it, 2 at the least.
 */
export const UNDER_A_BARS = 4
export const MIN_UNDER_A_BARS = 2

/**
 * The earliest such handoff into B's voice at `bVoice`, with A at `aPositionSec` now: the first voice end of A still ahead whose transition
 * B's quiet can cover with at least `MIN_UNDER_A_BARS` to spare, and which leaves A `MIN_FADE_BARS` after it to go down in. Null when none
 * is left — the caller says so in words.
 */
export function planHandoff(a: HandoffSide, aPositionSec: number, b: HandoffSide, bVoice: BVoiceStart): HandoffPlan | null {
  const barA = barSec(a.grid)
  const barB = barSec(b.grid)
  // B needs a beat of A to join on: the next yellow line still ahead (a join exactly on the playhead would already be behind it by the next frame).
  const firstJoin = nextBarLineSec(aPositionSec + EPS, a.grid)
  const runs = voiceRuns(a.timeline, a.durationSec)
  for (let i = 0; i < runs.length; i++) {
    const voiceEnd = barLineAtOrAfterSec(runs[i].to, a.grid)
    const nextVoice = i + 1 < runs.length ? runs[i + 1].from : a.durationSec
    // One bar of quiet is kept after the transition when A sings again: B's voice comes in on the transition's end and A's voice band goes
    // over that bar (`eqMixFrame`'s MID swap), so A's next line starts with its MIDs already cut — never at full over B's first line.
    const quietBars = Math.floor((nextVoice - voiceEnd) / barA + EPS)
    const transitionBars = Math.min(PHRASE_BARS, i + 1 < runs.length ? quietBars - 1 : quietBars)
    if (transitionBars < 1) continue
    const transitionEnd = voiceEnd + transitionBars * barA
    if (transitionEnd + MIN_FADE_BARS * barA > a.durationSec + EPS) continue
    // Bars B can play under A's singing: what its quiet leaves after the transition, and what is still ahead of the playhead.
    const roomInB = bVoice.quietBars - transitionBars
    const roomInA = Math.floor((voiceEnd - firstJoin) / barA + EPS)
    // B comes in while A sings (his step 2), not before a short line of A starts.
    const sung = Math.floor((voiceEnd - barLineAtOrAfterSec(runs[i].from, a.grid)) / barA + EPS)
    const under = Math.min(UNDER_A_BARS, roomInB, roomInA, sung)
    if (under < MIN_UNDER_A_BARS) continue
    const runwayBars = transitionBars + under
    return {
      joinSec: voiceEnd - under * barA,
      entrySec: bVoice.voiceSec - runwayBars * barB,
      // The bass swap on B's voice line: A's mids (its voice band) go over the next bar, then its highs, then the crossfader (`eqMixFrame`).
      handoffSec: transitionEnd,
      bVoiceSec: bVoice.voiceSec,
      fadeEndSec: transitionEnd + MIN_FADE_BARS * barA,
      runwayBars,
      onVoiceEnd: true, // kept for the plan's shape; always the end of a voice since v0.12.13
      aVoiceEndSec: voiceEnd,
      transitionBars,
      bMixEndSec: bVoice.voiceSec + MIN_FADE_BARS * barB,
    }
  }
  return null
}

/**
 * Not used by the app since v0.12.13 (plain mixes join on A's next phrase start again, `ctl.deckPhraseJoin`); kept, with its tests, as the
 * rule the owner may want back. v0.9.63: where a plain transition (an energy point, a "Mix in" pad, an excellent pair moved off A's voice) joins — the first yellow line
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
