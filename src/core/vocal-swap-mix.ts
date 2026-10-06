import { BEATS_PER_BAR, nextBarLineSec } from '@/core/beatgrid'
import { EQ_KILL, type EqBands, type EqMixFrame } from '@/core/eq-mix'
import { barLineAtOrAfterSec, barLineAtOrBeforeSec } from '@/core/sound/vocal-manual'
import { VOCAL_CELL_SEC, voiceRuns } from '@/core/sound/vocal-timeline'
import { PHRASE_BARS, enoughSongAfterMix, quietStretches, type HandoffSide } from '@/core/vocal-handoff'

/**
 * The vocal swap (the owner, 05/10, his order): "in the outgoing song we take the vocal down, then the instruments, and keep the bass; with
 * that bass we bring in only the vocal of the incoming song; then we bring up its instruments and its bass and take the outgoing bass
 * down. The whole mix 5–10 seconds." In bars, on A's own seconds (A = outgoing, B = incoming):
 *
 * | from S + | A                          | B                                        | crossfader           |
 * | 0        | MID goes down (its voice)  | playing, silent: the crossfader is on A  | on A                 |
 * | 1        | HIGH goes down             | silent                                   | on A                 |
 * | 2        | LOW only — its bass + kick | its own voice line: LOW and HIGH killed   | to the middle, 1 beat |
 * | 4        | LOW killed (the swap)      | LOW and HIGH back — the whole song       | to B, 1 beat; A out  |
 *
 * 4 bars and a beat: 7.0 s at 140 BPM, 8.0 at 128, 10.2 at 100.
 *
 * **What this is not.** Nothing here separates a voice from a song: the app has no stems (`docs/research/stems-and-sound-understanding.md`).
 * A's "voice down" is its MID knob, so A's synths go with it; B's "voice only" is B's MID band alone, so B's synths and snare body come
 * with its voice; A's "bass only" is A's LOW, so A's kick stays with its bass (the owner's choice, 05/10: the drums stay with the bass, so
 * the beat never stops under B's voice). The research the owner read before this was built says all of it
 * (`docs/research/vocal-swap-mix.md`). Real separation is the next version, and only if it sounds worth it.
 * Fading separated channels one by one is also what US 11,347,475 claims; turning a mixer's EQ knobs is not separation, and this file stays
 * on that side, like `core/vocal-handoff.ts`.
 *
 * **Where.** S is the yellow line where A's voice ends (the owner's choice, 05/10: the singer finishes the line, never cut mid-word), or a
 * whole phrase later while A is still quiet — the same starting points `planHandoff` uses. A must stay quiet until the swap is over: its MID
 * is not fully down until S + 1, and an A voice that comes back under B's voice would be the voice over a voice every Mix Assist mix exists
 * to avoid. B starts on the yellow line its voice starts on (his marks), two bars of B earlier so it is already playing — and phase-locked
 * by SYNC — when the crossfader opens; its intro is skipped on purpose (an "acapella in").
 *
 * The bass swap is always instant here, whatever the `bassSwap` setting says for the EQ mix: a gradual swap takes another bar and pushes
 * the mix past the 10 seconds he asked for at House tempo. Pure.
 */

/** A's MID (its voice) goes down over this many bars from S. */
export const SWAP_VOICE_DOWN_BARS = 1
/** Then A's HIGH (its instruments' top) over this many. */
export const SWAP_INSTRUMENTS_DOWN_BARS = 1
/** B's voice over A's bass alone, before the swap. Two bars: one line of a vocal, long enough to be heard as "the new singer". Chosen, not measured. */
export const SWAP_VOICE_ALONE_BARS = 2
/** The crossfader's moves — to the middle when B's voice comes in, to B on the swap — take one beat: a jump would click. */
const XFADE_BEATS = 1

/** S to the swap, in bars. */
export const SWAP_BARS = SWAP_VOICE_DOWN_BARS + SWAP_INSTRUMENTS_DOWN_BARS + SWAP_VOICE_ALONE_BARS

const EPS = 1e-6
const barSec = (bpm: number) => (60 / bpm) * BEATS_PER_BAR

/** One of B's voices this mix can come in on: the yellow line it starts on, in B seconds. */
export interface SwapEntry {
  voiceSec: number
}

export interface VocalSwapPlan {
  /** A seconds, a yellow line (S): A's MID starts down, and B starts playing silently. */
  joinSec: number
  /** B seconds: where B starts — two bars before its voice. */
  entrySec: number
  /** B seconds: the yellow line B's voice starts on. */
  bVoiceSec: number
  /** A seconds: B's voice comes in, over A's bass. */
  voiceSec: number
  /** A seconds: the bass swap. */
  swapSec: number
  /** A seconds: A is out and the mix is over. */
  endSec: number
  /** True when S is where A's voice ends; false when A was already quiet and S is a phrase later. */
  onVoiceEnd: boolean
}

/**
 * B's voices this mix can enter on, and how many it cannot, with the reason counted. The panel shows none of the counts (the owner,
 * 06/10: points left out are simply not shown); they stay here for the tests that pin each reason.
 * - `short`: the voice lasts less than `SWAP_VOICE_ALONE_BARS` from its yellow line — the two bars alone would run out of voice.
 * - `early`: the voice starts within the song's first two bars, so B cannot already be playing before it.
 * - `late`: B ends less than `MIN_BARS_AFTER_MIX` bars after the mix (v0.9.23's rule, same as every Mix Assist row).
 */
export function swapEntries(b: HandoffSide): { entries: SwapEntry[]; short: number; early: number; late: number } {
  const bar = barSec(b.grid.bpm)
  const entries: SwapEntry[] = []
  let short = 0
  let early = 0
  let late = 0
  for (const r of voiceRuns(b.timeline, b.durationSec)) {
    // His marks sit on yellow lines, but the timeline is half-second cells: a voice marked from a line at 58.16 s reads from the cell at
    // 58.0, and the line at or before THAT is a whole bar early — B would "sing alone" over a bar of nothing (found on his marks, 05/10:
    // 5–15% clean before this). The voice began somewhere in its first cell, so the line at or before the cell's end is the one.
    const voiceSec = barLineAtOrBeforeSec(r.from + VOCAL_CELL_SEC - EPS, b.grid)
    if (r.to - voiceSec < SWAP_VOICE_ALONE_BARS * bar - EPS) short++
    else if (voiceSec - (SWAP_VOICE_DOWN_BARS + SWAP_INSTRUMENTS_DOWN_BARS) * bar < -EPS) early++
    else if (!enoughSongAfterMix(b.durationSec, b.grid, voiceSec + (SWAP_VOICE_ALONE_BARS + XFADE_BEATS / BEATS_PER_BAR) * bar)) late++
    else entries.push({ voiceSec })
  }
  return { entries, short, early, late }
}

/**
 * The earliest vocal swap into B's voice at `entry`, with A at `aPositionSec` now; null when A has no stretch left that stays quiet for the
 * whole mix. With SYNC playing B straight (the caller checks, as for the handoff), a bar of A and a bar of B take the same time.
 */
export function planVocalSwap(a: HandoffSide, aPositionSec: number, b: HandoffSide, entry: SwapEntry): VocalSwapPlan | null {
  const barA = barSec(a.grid.bpm)
  const barB = barSec(b.grid.bpm)
  const mixSec = SWAP_BARS * barA + (XFADE_BEATS * barA) / BEATS_PER_BAR
  const firstJoin = nextBarLineSec(aPositionSec + EPS, a.grid)
  for (const q of quietStretches(a, aPositionSec)) {
    const voiceEnd = barLineAtOrAfterSec(q.from, a.grid)
    for (let s = voiceEnd; s + mixSec <= q.to + EPS; s += PHRASE_BARS * barA) {
      if (s < firstJoin - EPS) continue
      const silentBars = SWAP_VOICE_DOWN_BARS + SWAP_INSTRUMENTS_DOWN_BARS
      return {
        joinSec: s,
        entrySec: entry.voiceSec - silentBars * barB,
        bVoiceSec: entry.voiceSec,
        voiceSec: s + silentBars * barA,
        swapSec: s + SWAP_BARS * barA,
        // Clamped like the handoff's fade end: the engine's position stops at the song's end and would never pass a later second.
        endSec: Math.min(q.to, s + mixSec),
        onVoiceEnd: q.afterVoice && s === voiceEnd,
      }
    }
  }
  return null
}

/** B's knobs from the moment it starts until the swap: only its MID band — its voice, as near as an EQ gets. */
export function swapIncoming(own: EqBands): EqBands {
  return { low: EQ_KILL, mid: own.mid, high: EQ_KILL }
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
/** A knob from `own` down to the kill, `t` 0..1, straight in dB — a hand turning it. Never turns a knob up. */
const down = (own: number, t: number) => own + (Math.min(own, EQ_KILL) - own) * clamp01(t)

/**
 * Both decks' knobs and the crossfader at A's position `pos` (see the table above). `own` is where the owner had each knob when the mix
 * started; after the swap B has its own back, and A's are put back by the caller once A is paused, as for the EQ mix.
 */
export function vocalSwapFrame(plan: VocalSwapPlan, pos: number, barSecA: number, own: { a: EqBands; b: EqBands }): EqMixFrame {
  const beat = barSecA / BEATS_PER_BAR
  const xf = XFADE_BEATS * beat
  const highFrom = plan.joinSec + SWAP_VOICE_DOWN_BARS * barSecA

  let progress = 0
  if (pos >= plan.swapSec) progress = 0.5 + 0.5 * clamp01((pos - plan.swapSec) / xf)
  else if (pos >= plan.voiceSec) progress = 0.5 * clamp01((pos - plan.voiceSec) / xf)
  // The end may be clamped to A's last second, inside the last beat: then the move finishes there.
  if (pos >= plan.endSec) progress = 1

  const a = { ...own.a }
  const b = pos < plan.swapSec ? swapIncoming(own.b) : { ...own.b }
  if (pos >= plan.joinSec) {
    a.mid = down(own.a.mid, (pos - plan.joinSec) / (SWAP_VOICE_DOWN_BARS * barSecA))
    a.high = down(own.a.high, (pos - highFrom) / (SWAP_INSTRUMENTS_DOWN_BARS * barSecA))
  }
  if (pos >= plan.swapSec) a.low = Math.min(own.a.low, EQ_KILL)
  return { progress, a, b }
}
