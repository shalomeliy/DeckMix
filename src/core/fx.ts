/**
 * Pure FX math (v0.7.0) — beat-synced timing and the wet/dry blend curve. No
 * React, no DOM, no AudioContext: the same "extracted for real unit tests"
 * move `padmodes.ts`/`beatgrid.ts` already made. `platform/audio-webaudio/
 * fx.ts` owns the actual AudioNode graph; this file only computes the
 * numbers that feed it.
 */

/**
 * The 8 effects in the FX rack, in the order `ROADMAP.md` lists them.
 * `bitcrusher`/`roll`/`flanger`/`phaser` were added in v0.8.13 (planned as
 * v0.7.1) — appended at the end, never inserted, because `fx-idb/store.ts`
 * persists the active effect as a raw index into this array.
 */
export const FX_EFFECTS = [
  'delay',
  'echo',
  'reverb',
  'filter',
  'bitcrusher',
  'roll',
  'flanger',
  'phaser',
] as const
export type FxEffect = (typeof FX_EFFECTS)[number]

/** Beat-synced time steps, in beats — the roadmap's own "1/4…4 beats" range. */
export const FX_TIME_STEPS = [0.25, 0.5, 1, 2, 4] as const

/**
 * A beat fraction, at a given BPM, in seconds — the one formula every
 * beat-synced FX parameter (Delay/Echo's delay time, Filter's sweep period)
 * is computed from. `null`/non-positive BPM falls back to a fixed half
 * second rather than 0 or `Infinity`: a `DelayNode.delayTime` of 0 would
 * read as "no delay at all" rather than "BPM unknown", the exact silent
 * substitution this project's central rule forbids — a fixed, audibly
 * wrong value is a better bug report than a value that looks like a
 * different, valid choice.
 */
export function beatFractionToSeconds(bpm: number | null, fraction: number): number {
  if (!bpm || bpm <= 0) return 0.5
  return (60 / bpm) * fraction
}

/**
 * Equal-power crossfade weights for a 0..1 mix knob (0 = fully dry, 1 =
 * fully wet). Same curve `engine.ts`'s `setCrossfader` already uses for the
 * A/B crossfader — factored out here so the FX wet/dry blend and the
 * crossfader can never drift into two different-sounding curves by
 * accident. `setCrossfader` calls this instead of computing inline.
 */
export function equalPowerMix(t: number): { dry: number; wet: number } {
  const c = Math.max(0, Math.min(1, t))
  return {
    dry: Math.cos((c * Math.PI) / 2),
    wet: Math.cos(((1 - c) * Math.PI) / 2),
  }
}

/**
 * The crossfader's two curves (v0.9.31). `power` is `equalPowerMix`, what the owner's hand has always moved: −3 dB on each deck in the
 * middle, right for two full songs. `full-middle` is a club mixer's sharp curve — each deck at full level from the far side up to the
 * middle — and only the vocal swap uses it: there each deck is EQ'd down to the part of the song the other one lacks (A's bass, B's
 * everything else), so the two halves add up to one whole song only when NEITHER is turned down. On the power curve the same mix sat at
 * −3 dB for two bars and jumped back up on the swap; the owner heard that as "the volume goes to 0" (06/10).
 */
export type CrossfaderCurve = 'power' | 'full-middle'

/** Each deck's gain at crossfader `t` (0 = A only, 1 = B only). */
export function crossfaderGains(t: number, curve: CrossfaderCurve = 'power'): { a: number; b: number } {
  if (curve === 'power') {
    const { dry, wet } = equalPowerMix(t)
    return { a: dry, b: wet }
  }
  const c = Math.max(0, Math.min(1, t))
  // Still a quarter turn on each half, so a deck fades in or out on the power curve, not on a straight line that sounds late.
  return { a: Math.sin((Math.min(1, 2 * (1 - c)) * Math.PI) / 2), b: Math.sin((Math.min(1, 2 * c) * Math.PI) / 2) }
}

/** Bit Crusher's bit depth — fixed, not user-adjustable, same "fixed DSP constant" role as Delay/Echo's `FEEDBACK_GAIN` in `platform/audio-webaudio/fx.ts`. 4 bits reads as clearly "crushed"/digital without going fully unmusical (1-bit territory). */
export const BIT_CRUSH_BITS = 4

/**
 * Bit Crusher's fixed downsample target, in Hz — what actually gives the
 * effect its dramatic, obviously-digital character. Measured live (2026-09-22,
 * Shalom): bit-depth quantization alone, on real music, reads as a subtle
 * loudness/grain change, not the "crunchy" sound this effect promises — real
 * bitcrushers get most of their audible character from sample-rate reduction
 * (the aliasing/stair-step artifacts downsampling produces), which
 * `BIT_CRUSH_BITS` alone does not supply. Fixed rather than beat-synced —
 * see `fx-processor.ts`'s header comment for why an earlier beat-synced
 * version of this same knob was a magnitude error, not a style choice.
 */
export const BIT_CRUSH_HOLD_HZ = 2000

/**
 * Quantize a -1..1 sample to `2^bits` discrete levels — the per-sample math
 * behind Bit Crusher, pure and AudioContext-free (same "extracted for real
 * unit tests" move as `equalPowerMix`). `platform/audio-webaudio/
 * fx-processor.ts`'s worklet calls this once per held sample; the real-time
 * sample-and-hold timing itself is not extractable, it needs the live audio
 * thread.
 */
export function crushSample(sample: number, bits: number): number {
  const step = 2 / 2 ** bits
  return Math.round(sample / step) * step
}
