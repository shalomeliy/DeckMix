import { BEATS_PER_BAR, nextBarLineSec } from '@/core/beatgrid'
import { EQ_DB } from '@/core/constants'
import type { CrossfaderCurve } from '@/core/fx'
import { EQ_KILL, swapCurve, type EqBands, type EqMixFrame } from '@/core/eq-mix'
import { barLineAtOrAfterSec, barLineAtOrBeforeSec } from '@/core/sound/vocal-manual'
import { VOCAL_CELL_SEC, voiceRuns } from '@/core/sound/vocal-timeline'
import { PHRASE_BARS, enoughSongAfterMix, quietStretches, type HandoffSide } from '@/core/vocal-handoff'

/**
 * The vocal swap (the owner, 05/10, his order): "in the outgoing song we take the vocal down, then the instruments, and keep the bass; with
 * that bass we bring in only the vocal of the incoming song; then we bring up its instruments and its bass and take the outgoing bass
 * down. The whole mix 5–10 seconds." In bars, on A's own seconds (A = outgoing, B = incoming), from S:
 *
 * | from S + | A                                   | B (from its voice line, LOW killed)   | crossfader (`full-middle`)     |
 * | 0        | MID goes down (its voice)           | its voice comes in as A's goes out    | to the middle over 1 bar       |
 * | 1        | HIGH goes down                      | its voice over A's bass               | middle: both decks at full     |
 * | 2        | LOW only — its bass + kick          | its voice over A's bass               | middle: both decks at full     |
 * | 3        | LOW killed (the swap)               | LOW back — the whole song             | to B, 1 beat; A out            |
 *
 * 3 bars and a beat: 5.6 s at 140 BPM, 6.1 at 128, 7.8 at 100.
 *
 * **v0.9.31, the owner (06/10), on v0.9.28:** "you take the volume to 0, nothing is heard, and only after 3–4 seconds I hear the incoming
 * song, muffled, for 2 seconds, and then its volume rises — that is not how a professional auto-DJ works". He was right, and it was by
 * design: v0.9.28 stripped A down to its bass for two bars with B still silent behind the crossfader (on most speakers A's bass alone is
 * near silence), and only then let in B's MID band alone (no highs: muffled), at the crossfader's middle. Three rules now, each one of those:
 * - **B is heard from S**, its voice line on S, coming up while A's MID goes down — the two cross in the same bar. There is never a stretch
 *   where neither song carries the room.
 * - **B keeps its HIGH**: only its LOW is killed (the one thing two songs must never share). A voice's air and consonants live above 6 kHz;
 *   B's MID alone was what "muffled" was.
 * - **Both decks at full level in the middle** (`SWAP_CROSSFADER_CURVE`). Each one is EQ'd down to the half of a song the other lacks — A
 *   to its bass, B to everything but — so together they make one whole song only when the crossfader turns neither of them down. The
 *   mixer's usual curve holds each at −3 dB in the middle: two bars at −3 dB, then a jump back up on the swap. That is what a club DJ's
 *   sharp crossfader curve (or both channel faders up and the crossfader out of the way) is for. Pinned by a loudness test: the whole mix,
 *   frame by frame, never drops more than 1 dB below one full song.
 * - **Every knob moves on an equal-power curve** (`swapCurve`), not straight in dB: the knob is linear in dB, so a straight turn sits at
 *   −35 dB halfway — the band is gone for most of its bar, a hole a listener hears as "the volume dropped".
 *
 * **What this is not.** Nothing here separates a voice from a song: the app has no stems (`docs/research/stems-and-sound-understanding.md`).
 * A's "voice down" is its MID knob, so A's synths go with it; B's "voice" is everything of B but its bass, so its hats and synths come with
 * it; A's "bass only" is A's LOW, so A's kick stays with its bass (the owner's choice, 05/10: the drums stay with the bass, so the beat
 * never stops under B's voice). The research the owner read before this was built says all of it (`docs/research/vocal-swap-mix.md`).
 * Fading separated channels one by one is what US 11,347,475 claims; turning a mixer's EQ knobs is not separation, and this file stays on
 * that side, like `core/vocal-handoff.ts`.
 *
 * **Where.** S is the yellow line where A's voice ends (the owner's choice, 05/10: the singer finishes the line, never cut mid-word), or a
 * whole phrase later while A is still quiet — the same starting points `planHandoff` uses. A stays quiet until the swap is over, so its
 * voice never comes back under B's. B starts on the yellow line its voice starts on (his marks): its intro is skipped on purpose (an
 * "acapella in").
 *
 * The bass swap is always instant here, whatever the `bassSwap` setting says for the EQ mix: the swap is the moment the new song lands. Pure.
 */

/** A's MID (its voice) goes down — and B comes in — over this many bars from S. */
export const SWAP_VOICE_DOWN_BARS = 1
/** Then A's HIGH (its instruments' top) over this many. */
export const SWAP_INSTRUMENTS_DOWN_BARS = 1
/** B's voice over A's bass alone, before the swap. Chosen, not measured. */
export const SWAP_VOICE_ALONE_BARS = 1
/** The crossfader curve this mix runs on (see the header): each deck at full level in the middle. */
export const SWAP_CROSSFADER_CURVE: CrossfaderCurve = 'full-middle'
/** The crossfader's move to B on the swap takes one beat: a jump would click. */
const XFADE_BEATS = 1

/** S to the swap, in bars. */
export const SWAP_BARS = SWAP_VOICE_DOWN_BARS + SWAP_INSTRUMENTS_DOWN_BARS + SWAP_VOICE_ALONE_BARS
/** B must keep singing at least this long from its line: from S to the swap it is the voice the room hears over A's bass. */
const MIN_VOICE_BARS = SWAP_BARS

/**
 * The owner, 08/10, on a swap near the end of the outgoing song: B came in on a near-acapella voice, A's drums went at the swap, and B's bass
 * had not started — "suddenly the song sounds with no drums". The rule he gave: when A has no voice from the mix to its end, A's bass keeps
 * playing exactly until B's bass comes in, and only then goes down, slowly. `BASS_HOLD_FADE_BARS` is that "slowly": chosen, not measured.
 */
export const BASS_HOLD_FADE_BARS = 2
/** B's bass has started when its LOW band reaches this share of the song's own bass level (the 80th percentile of its LOW buckets)... */
export const BASS_ENTRY_LEVEL = 0.5
/** ...and stays there this long, so a single kick under an acapella is not taken for the bass line. */
export const BASS_ENTRY_HOLD_SEC = 1

const EPS = 1e-6
const barSec = (bpm: number) => (60 / bpm) * BEATS_PER_BAR

/** One of B's voices this mix can come in on: the yellow line it starts on, in B seconds. */
export interface SwapEntry {
  voiceSec: number
}

export interface VocalSwapPlan {
  /** A seconds, a yellow line (S): A's MID starts down, and B starts on its voice line. */
  joinSec: number
  /** B seconds: where B starts — its voice line. */
  entrySec: number
  /** B seconds: the yellow line B's voice starts on. */
  bVoiceSec: number
  /** A seconds: B's voice comes in — S itself since v0.9.31 (kept as its own field: the cancel button names it). */
  voiceSec: number
  /** A seconds: the bass swap. */
  swapSec: number
  /** A seconds: A is out and the mix is over. */
  endSec: number
  /** True when S is where A's voice ends; false when A was already quiet and S is a phrase later. */
  onVoiceEnd: boolean
  /**
   * True when `swapSec` was moved later, to where B's bass starts (`bassEntrySec`): A's bass is held until then and goes down over
   * `BASS_HOLD_FADE_BARS` bars, ending at `endSec`. False is the mix of the table above.
   */
  bassHold: boolean
  /** Why the 08/10 bass hold was not kept although A has no voice to its end (shown on the panel row); null otherwise. */
  holdSkipped: string | null
}

/**
 * Where B's bass starts at or after `fromSec` (B seconds, on a yellow line), read from its LOW band; null when the song has no bands or its
 * bass never starts. The level is the song's own (80th percentile), so a quiet master and a loud one read alike. Pure.
 */
export function bassEntrySec(b: HandoffSide, fromSec: number): number | null {
  const bands = b.bands
  if (!bands || b.durationSec <= 0) return null
  const n = Math.floor(bands.length / 3)
  if (n < 2) return null
  const low = new Float32Array(n)
  for (let i = 0; i < n; i++) low[i] = bands[i * 3]
  const ref = [...low].sort((x, y) => x - y)[Math.floor(n * 0.8)]
  if (!(ref > 0)) return null
  const level = ref * BASS_ENTRY_LEVEL
  const bucketSec = b.durationSec / n
  const need = Math.max(1, Math.round(BASS_ENTRY_HOLD_SEC / bucketSec))
  for (let i = Math.max(0, Math.ceil(fromSec / bucketSec)); i + need <= n; i++) {
    let ok = true
    for (let k = 0; k < need; k++) if (!(low[i + k] >= level)) { ok = false; break }
    if (!ok) continue
    // The bass starts somewhere in its first bucket: the line at or before the bucket's end, as `swapEntries` reads a voice.
    return Math.max(fromSec, barLineAtOrBeforeSec((i + 1) * bucketSec - EPS, b.grid))
  }
  return null
}

/**
 * Where A's bass ends (A seconds, on a yellow line at or before it): the end of the last stretch whose LOW band is at the song's own bass
 * level (`BASS_ENTRY_LEVEL`), or the song's end when its bass plays to the last second, or when it has no bands. Pure.
 */
export function bassEndSec(a: HandoffSide): number {
  const bands = a.bands
  const n = bands ? Math.floor(bands.length / 3) : 0
  if (!bands || n < 2 || a.durationSec <= 0) return a.durationSec
  const low = new Float32Array(n)
  for (let i = 0; i < n; i++) low[i] = bands[i * 3]
  const ref = [...low].sort((x, y) => x - y)[Math.floor(n * 0.8)]
  if (!(ref > 0)) return a.durationSec
  const bucketSec = a.durationSec / n
  let last = n - 1
  while (last > 0 && !(low[last] >= ref * BASS_ENTRY_LEVEL)) last--
  // The last buckets of a song are often its fade-out: a bass that is there up to the final second counts as playing to the end.
  if ((n - 1 - last) * bucketSec <= BASS_ENTRY_HOLD_SEC) return a.durationSec
  return barLineAtOrBeforeSec((last + 1) * bucketSec, a.grid)
}

/**
 * B's voices this mix can enter on, and how many it cannot, with the reason counted. The panel shows none of the counts (the owner,
 * 06/10: points left out are simply not shown); they stay here for the tests that pin each reason.
 * - `short`: the voice lasts less than `MIN_VOICE_BARS` from its yellow line — it would run out before the swap.
 * - `late`: B ends less than `MIN_BARS_AFTER_MIX` bars after the mix (v0.9.23's rule, same as every Mix Assist row).
 */
export function swapEntries(b: HandoffSide): { entries: SwapEntry[]; short: number; late: number } {
  const bar = barSec(b.grid.bpm)
  const entries: SwapEntry[] = []
  let short = 0
  let late = 0
  for (const r of voiceRuns(b.timeline, b.durationSec)) {
    // His marks sit on yellow lines, but the timeline is half-second cells: a voice marked from a line at 58.16 s reads from the cell at
    // 58.0, and the line at or before THAT is a whole bar early — B would come in over a bar of nothing (found on his marks, 05/10:
    // 5–15% clean before this). The voice began somewhere in its first cell, so the line at or before the cell's end is the one.
    let voiceSec = barLineAtOrBeforeSec(r.from + VOCAL_CELL_SEC - EPS, b.grid)
    // A voice from the song's first half second, on a grid whose first line is later than that, reads a line before 0 — B would be told
    // to start at a negative second and land a bar off (independent review, 06/10). The song's first line is the earliest it can be.
    if (voiceSec < 0) voiceSec += bar
    if (r.to - voiceSec < MIN_VOICE_BARS * bar - EPS) short++
    else if (!enoughSongAfterMix(b.durationSec, b.grid, voiceSec + (SWAP_BARS + XFADE_BEATS / BEATS_PER_BAR) * bar)) late++
    else entries.push({ voiceSec })
  }
  return { entries, short, late }
}

/**
 * The earliest vocal swap into B's voice at `entry`, with A at `aPositionSec` now; null when A has no stretch left that stays quiet for the
 * whole mix. With SYNC playing B straight (the caller checks, as for the handoff), a bar of A and a bar of B take the same time.
 */
export function planVocalSwap(a: HandoffSide, aPositionSec: number, b: HandoffSide, entry: SwapEntry): VocalSwapPlan | null {
  const barA = barSec(a.grid.bpm)
  const mixSec = SWAP_BARS * barA + (XFADE_BEATS * barA) / BEATS_PER_BAR
  const firstJoin = nextBarLineSec(aPositionSec + EPS, a.grid)
  for (const q of quietStretches(a, aPositionSec)) {
    const voiceEnd = barLineAtOrAfterSec(q.from, a.grid)
    let s = voiceEnd
    while (s < firstJoin - EPS) s += PHRASE_BARS * barA
    if (s >= q.to) continue
    const base: VocalSwapPlan = {
      joinSec: s,
      entrySec: entry.voiceSec,
      bVoiceSec: entry.voiceSec,
      voiceSec: s,
      swapSec: s + SWAP_BARS * barA,
      // Clamped like the handoff's fade end: the engine's position stops at the song's end and would never pass a later second.
      endSec: Math.min(q.to, s + mixSec),
      onVoiceEnd: q.afterVoice && s === voiceEnd,
      bassHold: false,
      holdSkipped: null,
    }
    // The bass hold may fit where the plain mix does not (A is near its end): it is planned from the earliest start, and B comes in later in its voice.
    const held = withBassHold(base, a, b, entry)
    if (held.bassHold || s + mixSec <= q.to + EPS) return held
  }
  return null
}

/** A voice this short in A's last stretch is not a "significant" one (the owner, 08/10: more than 2 seconds is). */
const SIGNIFICANT_VOICE_SEC = 2
/** The fewest bars B plays before its bass starts in a bass-hold mix: A's MID and HIGH need a bar each to go down. Chosen, not measured. */
const MIN_HOLD_RUN_BARS = SWAP_VOICE_DOWN_BARS + SWAP_INSTRUMENTS_DOWN_BARS

/**
 * The 08/10 rule, as the owner finished it the same night: when A has no significant voice from the mix to the end of the song, B comes in
 * so that its bass starts exactly when A's bass ends. Backwards from A's bass end (`bassEndSec`): A's bass goes down over the last
 * `BASS_HOLD_FADE_BARS` bars, B's bass (`bassEntrySec`) starts where that fade starts, and B comes in on its voice line, however far before its
 * bass, and when A has less room than that it comes in later, inside its voice, so that the two basses still meet. There is no limit on how long the wait is. A's MID and HIGH go down at the start, as in every swap. The plan
 * stays as it was (with the reason in `holdSkipped`, shown on the row) when this cannot be kept: B's bass is not known or never starts, the
 * start would be before the earliest the plain mix can start, or B would be left with too little song.
 */
function withBassHold(plan: VocalSwapPlan, a: HandoffSide, b: HandoffSide, entry: SwapEntry): VocalSwapPlan {
  // The rule is for the end of A's song only: any voice of more than 2 s from the mix to the song's end and the plan stays as it was.
  if (voiceRuns(a.timeline, a.durationSec).some((r) => r.to > plan.joinSec && r.to - r.from > SIGNIFICANT_VOICE_SEC)) return plan
  // From here the rule applies, so every way it cannot be kept is said on the row (never skipped silently).
  const skip = (holdSkipped: string): VocalSwapPlan => ({ ...plan, holdSkipped })
  if (!b.bands) return skip('הבס של השיר הנכנס עוד לא נותח')
  const bEntry = bassEntrySec(b, entry.voiceSec)
  if (bEntry == null) return skip('לא נמצאה כניסת בס בשיר הנכנס')
  const barA = barSec(a.grid.bpm)
  const barB = barSec(b.grid.bpm)
  const bassBars = Math.round((bEntry - entry.voiceSec) / barB)
  const endSec = bassEndSec(a)
  const swapSec = endSec - BASS_HOLD_FADE_BARS * barA
  // Bars from the earliest start to the swap. When B's voice line is further from its bass than that, B comes in later, inside its voice,
  // on the line that many bars before its bass (A is near its end: the owner's case); when closer, the mix starts later so the two meet.
  const room = Math.floor((swapSec - plan.joinSec) / barA + EPS)
  if (room < MIN_HOLD_RUN_BARS) return skip('אין מספיק מקום בשיר היוצא עד שהבס שלו נגמר')
  const runBars = Math.min(room, bassBars)
  const joinSec = swapSec - runBars * barA
  const bEnter = bEntry - runBars * barB
  if (!enoughSongAfterMix(b.durationSec, b.grid, bEntry + BASS_HOLD_FADE_BARS * barB)) return skip('לשיר הנכנס לא נשאר מספיק אחרי הכניסה של הבס')
  return { ...plan, joinSec, voiceSec: joinSec, entrySec: bEnter, bVoiceSec: bEnter, swapSec, endSec, bassHold: true, onVoiceEnd: plan.onVoiceEnd && joinSec === plan.joinSec }
}

/** B's knobs from the moment it starts until the swap: everything but its bass — its voice, as near as an EQ gets without muffling it. */
export function swapIncoming(own: EqBands): EqBands {
  return { low: EQ_KILL, mid: own.mid, high: own.high }
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/**
 * Both decks' knobs and the crossfader at A's position `pos` (see the table above). `own` is where the owner had each knob when the mix
 * started; after the swap B has its own back, and A's are put back by the caller once A is paused, as for the EQ mix. `boostDb` is the
 * owner's `eqDb` setting, which `swapCurve` needs for a knob he had above the middle.
 */
export function vocalSwapFrame(plan: VocalSwapPlan, pos: number, barSecA: number, own: { a: EqBands; b: EqBands }, boostDb: number = EQ_DB): EqMixFrame {
  const xf = (XFADE_BEATS * barSecA) / BEATS_PER_BAR
  const highFrom = plan.joinSec + SWAP_VOICE_DOWN_BARS * barSecA

  // The crossfader brings B up to the middle — on `full-middle`, to its full level — over the same bar A's MID goes down: one voice out as
  // the other comes in.
  // With the bass held, A is still playing after the swap (its bass going down slowly): the crossfader stays in the middle, both decks at
  // full level, until A's bass is out, and only then goes to B (A is silent by then, so the move is not heard).
  const holdSec = Math.max(EPS, plan.endSec - plan.swapSec)
  let progress = 0
  if (pos >= plan.swapSec) progress = plan.bassHold ? 0.5 : 0.5 + 0.5 * clamp01((pos - plan.swapSec) / xf)
  else if (pos >= plan.joinSec) progress = 0.5 * clamp01((pos - plan.joinSec) / (SWAP_VOICE_DOWN_BARS * barSecA))
  // The end may be clamped to A's last second, inside the last beat: then the move finishes there.
  if (pos >= plan.endSec) progress = 1

  const a = { ...own.a }
  const b = pos < plan.swapSec ? swapIncoming(own.b) : { ...own.b }
  if (pos >= plan.joinSec) {
    a.mid = swapCurve(own.a.mid, (pos - plan.joinSec) / (SWAP_VOICE_DOWN_BARS * barSecA), 'down', boostDb)
    a.high = swapCurve(own.a.high, (pos - highFrom) / (SWAP_INSTRUMENTS_DOWN_BARS * barSecA), 'down', boostDb)
  }
  if (pos >= plan.swapSec) a.low = plan.bassHold ? swapCurve(own.a.low, (pos - plan.swapSec) / holdSec, 'down', boostDb) : Math.min(own.a.low, EQ_KILL)
  return { progress, a, b }
}
