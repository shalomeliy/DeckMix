import { EQ_CUT_DB, EQ_DB } from '@/core/constants'
import type { CrossfaderCurve } from '@/core/fx'

/**
 * Mixing with the EQ, the way a DJ does (v0.9.18, the owner, 05/10): "a DJ doesn't mix with the fader. He brings the new song in with its
 * vocal low, brings up its drums and instruments with the outgoing song, takes the outgoing song's drums and instruments down during the mix,
 * and at the end takes all its volume down — or moves the crossfader to the incoming side".
 *
 * What every source the research read agrees on (`docs/research/eq-mix-dj.md`), and what this file encodes:
 * - **Never two basslines at once.** Two basses sit on the same frequencies, rarely agree in pitch, and turn to mud. So B comes in with its
 *   LOW killed, and the lows are swapped — A's shut, B's opened — on a downbeat at the start of a phrase: the bass swap.
 * - An EQ is not stems: the kick and the bass both live in LOW, so before the swap B is heard by its hats, percussion and instruments only;
 *   its kick arrives together with its bass. A DJ on any mixer is held to the same.
 * - After the swap the rest of A goes: its MID (already v0.9.16's swap), then its HIGH, and last its volume — here the crossfader.
 *
 * Before v0.9.18 the vocal handoff left LOW and HIGH alone: for the whole runway (up to 8 bars) both kicks and both basses played together,
 * which is the first thing this list forbids; a plain transition (an energy point) touched no EQ at all.
 *
 * The crossfader stays the volume control, not the channel faders: B reaches the middle early and A leaves at the end, so nothing is left
 * down after the transition (a channel fader at zero would greet the next song on that deck with silence).
 *
 * Every frame is a function of one position on one axis — A's play position for a handoff (so it stays on A's voice end whatever the tempo
 * does), elapsed seconds for a plain transition — so the caller can drive it from any clock. Pure.
 */

export type EqBand = 'low' | 'mid' | 'high'
export interface EqBands {
  low: number
  mid: number
  high: number
}

/**
 * The bass swap's shape, the owner's choice (05/10): `instant` — on the yellow line A's bass shuts and B's opens in the same moment (the
 * default: what Techno and House DJs do, and the moment the room feels the new song arrive); `gradual` — over one bar, both at half power
 * halfway (equal power, see `swapCurve`).
 */
export type BassSwapStyle = 'instant' | 'gradual' | 'together'

/**
 * `together` (v0.9.33, the owner's choice on 07/10, after the first ear test: "I miss the part where the two basses play together in perfect
 * harmony before the transition is done"): both LOWs fully open for `MIX_TOGETHER_BARS`, the swap line in their middle — B's opens a bar
 * before it (or at the join, if that is later), A's shuts a bar after it. This breaks the "never two basslines" rule above on purpose, and
 * the price was said to him before he chose: two basses at full add up (+1.9 dB in the room model while both play, against +0.6 for
 * `instant`) and turn to mud when the two songs' basslines do not agree. The limiter catches the peaks; the mud is his ear's call.
 */
export const MIX_TOGETHER_BARS = 2

/**
 * The crossfader curve every automatic EQ mix runs on (v0.9.33): `full-middle`, each deck at full level from its side up to the middle —
 * the curve the vocal swap has used since v0.9.31, for the same reason. In this mix each deck is EQ'd down to the part of a song the other
 * one lacks (B without its bass under A, then A without its bass under B), so the two only add up to one whole song when the crossfader
 * turns neither of them down. On the hand crossfader's `power` curve both sat at −3 dB from the rise to the fade: measured on the owner's own
 * songs (`scripts/measure-mix-loudness.mjs`, 07/10), the plain mix and the handoff ran 2–2.6 dB under the two songs on average and more than
 * 2 dB under for half their length — the drop he heard. The hand crossfader keeps `power`: two full songs, where −3 dB each is right.
 */
export const AUTO_MIX_CROSSFADER_CURVE: CrossfaderCurve = 'full-middle'

/** A knob all the way down: −70 dB on this mixer (`EQ_CUT_DB`). */
export const EQ_KILL = -1
/**
 * B's MID while it plays under A, and A's after the swap (v0.9.16's `HANDOFF_MID_CUT`, unchanged): since the isolator (v0.9.33) about
 * −26 dB in the middle of the 250 Hz–3 kHz band, less towards the crossovers (−6 dB at each); before it, −28 at 1 kHz only. Short
 * of the kill on purpose: the MID is where the voice sits, but also the synths and the body of every instrument, and a full kill leaves a
 * hole a listener notices. Chosen, not measured.
 */
export const MIX_MID_CUT = -0.4
/** B rises to the middle of the crossfader over this many bars from the join (or half the way to the swap, if that is shorter). */
export const MIX_RISE_BARS = 2
/** The MID swap at the bass swap takes one bar — a turn of the knob, not a cut on one beat. */
export const MIX_MID_SWAP_BARS = 1
/** The `gradual` bass swap takes one bar. */
export const MIX_GRADUAL_SWAP_BARS = 1

/**
 * One transition, on one axis. `joinSec`: B starts (crossfader still fully on A). `swapSec`: the bass swap — for a handoff the plan's
 * `handoffSec`, halfway through the run-in since v0.9.63. `fadeEndSec`: A is gone (for a handoff, where B's voice comes in).
 */
export interface EqMixPlan {
  joinSec: number
  swapSec: number
  fadeEndSec: number
}

export interface EqMixFrame {
  /** Crossfader, 0 = only A … 1 = only B — on `AUTO_MIX_CROSSFADER_CURVE` for the EQ mix, `SWAP_CROSSFADER_CURVE` for the vocal swap. */
  progress: number
  a: EqBands
  b: EqBands
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/** B's knobs while it plays under A, from the join to the swap: LOW killed, MID cut, HIGH as the owner had it. */
export function incomingUnderA(own: EqBands): EqBands {
  return { low: EQ_KILL, mid: Math.min(own.mid, MIX_MID_CUT), high: own.high }
}

/**
 * A knob on its way from `own` to the kill (`down`) or back (`up`), `t` 0..1, keeping the summed POWER of the two swapped bands constant:
 * the amplitude follows cos/sin of a quarter turn, so halfway each side is at −3 dB — "both at half power", what the setting promises. A
 * straight line on the knob would not do that: the knob is linear in dB, so its midpoint is −35 dB on both and the bass would vanish for
 * half a bar.
 *
 * Worked in real dB on both sides of 0, because the knob's two halves have different scales (`deck.ts`: the cut side `EQ_CUT_DB` per unit,
 * the boost side the owner's `eqDb` setting). Counting a boosted knob in cut units put each side at only −1.1 dB halfway from +0.5 — 1.55×
 * the power of one bass, the mud this swap exists to prevent (independent review, 05/10).
 */
export function swapCurve(own: number, t: number, dir: 'down' | 'up', boostDb: number): number {
  const amp = dir === 'down' ? Math.cos((clamp01(t) * Math.PI) / 2) : Math.sin((clamp01(t) * Math.PI) / 2)
  if (amp >= 1) return own
  if (amp <= 0) return EQ_KILL
  const db = (own >= 0 ? own * boostDb : own * EQ_CUT_DB) + 20 * Math.log10(amp)
  const knob = db >= 0 ? db / boostDb : db / EQ_CUT_DB
  return Math.max(EQ_KILL, Math.min(own, knob))
}

/**
 * A knob on its way from `from` to `to`, `t` 0..1, with its band's POWER moving on a quarter sine (sin² of a quarter turn): two knobs
 * crossing — one `from` a to b, the other b to a — keep their summed power constant all the way, which is what a swap of the MIDs needs.
 * In real dB on both sides of 0, like `swapCurve`.
 */
export function turnByPower(from: number, to: number, t: number, boostDb: number): number {
  const s = Math.sin((clamp01(t) * Math.PI) / 2) ** 2
  if (s <= 0) return from
  if (s >= 1) return to
  const toDb = (k: number) => (k >= 0 ? k * boostDb : k * EQ_CUT_DB)
  const p = 10 ** (toDb(from) / 10) + (10 ** (toDb(to) / 10) - 10 ** (toDb(from) / 10)) * s
  const db = 10 * Math.log10(Math.max(p, 1e-12))
  const knob = db >= 0 ? db / boostDb : db / EQ_CUT_DB
  return Math.max(EQ_KILL, Math.min(Math.max(from, to), knob))
}

/**
 * Both decks' three knobs and the crossfader at `pos`. `own` is where the owner had each knob at the join; a knob he had already turned
 * lower than a cut is never turned UP by this (every cut is `min(own, cut)`), and after the transition each one goes back to `own` (the
 * caller does that for A, which is paused by then).
 *
 * The order, from the join:
 * 1. B: LOW killed, MID cut, HIGH as it was. The crossfader takes B to the middle over `MIX_RISE_BARS`.
 * 2. At `swapSec`: the lows swap (`style`); over the next bar the MIDs swap too (B's comes back, A's goes down).
 * 3. Then A's HIGH goes down, until halfway from the swap to the end.
 * 4. The second half: the crossfader moves to B's side, and A is out at `fadeEndSec`.
 */
export function eqMixFrame(
  plan: EqMixPlan,
  pos: number,
  barSec: number,
  own: { a: EqBands; b: EqBands },
  style: BassSwapStyle,
  /** dB at +1 on a knob — the owner's `eqDb` setting, which the engine uses on the boost side; only the gradual swap's curve needs it. */
  boostDb: number = EQ_DB,
): EqMixFrame {
  const { joinSec, swapSec, fadeEndSec } = plan
  const rise = Math.max(1e-6, Math.min(MIX_RISE_BARS * barSec, (swapSec - joinSec) / 2))
  const outStart = swapSec + (fadeEndSec - swapSec) / 2
  // On a short plain transition (8 s, a swap a few bars in) a bar after the swap can already be past the halfway point: the HIGH then starts
  // halfway between the swap and `outStart`, so it still finishes before the crossfader takes A out.
  const highStart = Math.min(swapSec + MIX_MID_SWAP_BARS * barSec, (swapSec + outStart) / 2)

  let progress: number
  if (pos <= joinSec) progress = 0
  else if (pos < joinSec + rise) progress = (0.5 * (pos - joinSec)) / rise
  else if (pos < outStart) progress = 0.5
  else if (pos < fadeEndSec) progress = 0.5 + (0.5 * (pos - outStart)) / Math.max(1e-6, fadeEndSec - outStart)
  else progress = 1

  const a = { ...own.a }
  const b = { ...own.b }
  const under = incomingUnderA(own.b)

  // LOW — the bass swap.
  if (style === 'together') {
    const half = (MIX_TOGETHER_BARS / 2) * barSec
    if (pos < Math.max(joinSec, swapSec - half)) b.low = under.low
    // Never later than `outStart`: on the 5 s plain mix a bar after the swap is past the point where the crossfader starts taking A out
    // (128 BPM), and under 96 BPM past the end of the mix itself — A's bass would never shut, and there would be no swap at all.
    if (pos >= Math.min(swapSec + half, outStart)) a.low = EQ_KILL
  } else if (pos < swapSec) {
    b.low = under.low
  } else if (style === 'instant') {
    a.low = EQ_KILL
  } else {
    const t = (pos - swapSec) / (MIX_GRADUAL_SWAP_BARS * barSec)
    a.low = swapCurve(own.a.low, t, 'down', boostDb)
    b.low = swapCurve(own.b.low, t, 'up', boostDb)
  }

  // MID — B's down while it plays under A, swapped over a bar from the bass swap. By power, not along the knob: the knob is linear in dB, so
  // a straight turn put both MIDs at −14 dB halfway and the room lost 1.3 dB for that beat (v0.9.33, the room test in eq-mix.test.ts).
  const aMidCut = Math.min(own.a.mid, MIX_MID_CUT)
  const bMidCut = under.mid
  const tm = pos < swapSec ? 0 : clamp01((pos - swapSec) / (MIX_MID_SWAP_BARS * barSec))
  a.mid = turnByPower(own.a.mid, aMidCut, tm, boostDb)
  b.mid = turnByPower(bMidCut, own.b.mid, tm, boostDb)

  // HIGH — A's hats leave before its volume does.
  if (pos > highStart) {
    const th = clamp01((pos - highStart) / Math.max(1e-6, outStart - highStart))
    a.high = own.a.high + (Math.min(own.a.high, EQ_KILL) - own.a.high) * th
  }

  return { progress, a, b }
}

/**
 * The plan for a plain transition (an energy point or a "Mix in" pad): a fixed `fadeSec` of wall clock from the join. The bass swap goes on
 * the last bar line at or before the middle (at least one bar in) — whole bars from the join, which itself lands on a yellow line — so the
 * same order fits inside the same seconds as before v0.9.18, and the "voice: clean" check next to each energy point (since v0.9.63 A's
 * quiet over that same window, `ctl.deckPhraseJoin`) still holds. Only a bar longer than the whole fade (under 30 BPM at 8 s) puts it
 * off a line, at the middle. `barSec` is one bar of A in wall seconds (its bar at its current tempo).
 */
export function plainEqMixPlan(fadeSec: number, barSec: number): EqMixPlan {
  const swapSec = Math.max(1, Math.floor(fadeSec / 2 / barSec + 1e-9)) * barSec
  return { joinSec: 0, swapSec: swapSec < fadeSec ? swapSec : fadeSec / 2, fadeEndSec: fadeSec }
}
