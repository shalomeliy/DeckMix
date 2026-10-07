/**
 * The deck's 3-band EQ as a club mixer's isolator (v0.9.33). Pure: the numbers here are what `platform/audio-webaudio/deck.ts` builds
 * its nodes from, what `tests/core/isolator.test.ts` checks, and what `scripts/measure-mix-loudness.mjs` runs real songs through.
 *
 * **Why not the old shelf/peak EQ.** Until v0.9.33 the three knobs were a low shelf at 100 Hz, a peaking filter at 1 kHz (Q 0.9) and a high
 * shelf at 6 kHz, each cutting up to −70 dB. That is a tone control, not three separate bands, and at a kill it reaches far outside its
 * own band (Web Audio's own formulas, measured 07/10):
 * - MID killed: −16 dB at 100 Hz and −17 dB at 8 kHz — the "kill the voice" knob took most of the bass and the hats with it. The vocal swap
 *   leaves A on its bass with its MID killed, so A all but vanished;
 * - LOW killed: −16 dB at 300 Hz and −8 at 500 — B "without its bass" lost the body of its kick and of its voice too.
 * Two halves that should add up to one song left a hole between them. On the owner's own songs (6 pairs, `measure-mix-loudness.mjs`) the
 * Mix Assist mixes sat 2–3 dB under the two songs for half their length, down to −12 dB at the worst moment. He heard it (07/10): "during
 * the mix the volume drops, and it must not".
 *
 * **What an isolator is.** The signal is split by crossovers into three bands that add back up to the original exactly (flat), and each
 * knob is a plain volume on its own band: a kill removes that band and nothing else. Linkwitz–Riley 4th order (two Butterworth sections in
 * a row, 24 dB/octave): the low and high outputs are each −6 dB at the crossover and in phase, so their sum is flat. The low band also gets
 * the upper crossover's all-pass, so its phase matches the other two and the three still sum flat (without it there is a dip around 3 kHz).
 *
 * **The crossover points.** 250 Hz and 3 kHz: the bass and kick below 250 (what the bass swap moves), the voice and the body of the
 * instruments between, the hats and air above 3 kHz. Hardware isolators sit in the same range — switchable 100/200/400 Hz and 1.5/2/3 kHz on
 * one, "400 Hz and 4 kHz seem to be popular" in an isolator design note (sources in `docs/research/mix-loudness.md`). Chosen, not measured
 * by ear.
 */

export type BiquadKind = 'lowpass' | 'highpass' | 'allpass' | 'lowshelf' | 'highshelf' | 'peaking'

/** Low / mid crossover, Hz. */
export const ISO_LOW_MID_HZ = 250
/** Mid / high crossover, Hz. */
export const ISO_MID_HIGH_HZ = 3000

/** A Butterworth section's Q (linear). */
const BUTTERWORTH_Q = Math.SQRT1_2

/**
 * One biquad as `BiquadFilterNode` takes it. `q` is the value for the node's `Q` AudioParam — and the spec reads that in **dB** for lowpass
 * and highpass but as a plain number for allpass: a Butterworth section is Q = 0.707 on an allpass and −3.01 dB on a lowpass. Passing 0.707
 * to a lowpass gives a 0.707 dB resonance, not a Butterworth, and the bands no longer sum flat (`isolator.test.ts` catches it).
 */
export interface BiquadSpec {
  type: BiquadKind
  freq: number
  q: number
}

const qParam = (type: BiquadKind, linearQ: number) => (type === 'lowpass' || type === 'highpass' ? 20 * Math.log10(linearQ) : linearQ)
const section = (type: BiquadKind, freq: number): BiquadSpec => ({ type, freq, q: qParam(type, BUTTERWORTH_Q) })
const lr4 = (type: 'lowpass' | 'highpass', freq: number) => [section(type, freq), section(type, freq)]

/** The filters on each band's path, in order; each path then goes through its knob's gain, and the three are summed. */
export const ISOLATOR_PATHS: Record<'low' | 'mid' | 'high', BiquadSpec[]> = {
  low: [...lr4('lowpass', ISO_LOW_MID_HZ), section('allpass', ISO_MID_HIGH_HZ)],
  mid: [...lr4('highpass', ISO_LOW_MID_HZ), ...lr4('lowpass', ISO_MID_HIGH_HZ)],
  high: [...lr4('highpass', ISO_LOW_MID_HZ), ...lr4('highpass', ISO_MID_HIGH_HZ)],
}

/** A knob (−1..+1) in dB: the cut side `cutDb` per unit (−1 is the kill), the boost side the owner's `eqDb` setting. Same mapping as before v0.9.33. */
export function knobToDb(knob: number, boostDb: number, cutDb: number): number {
  return knob >= 0 ? knob * boostDb : knob * cutDb
}

/** A knob as the linear gain on its band. */
export function bandGain(knob: number, boostDb: number, cutDb: number): number {
  return 10 ** (knobToDb(knob, boostDb, cutDb) / 20)
}

/**
 * Normalised biquad coefficients `[b0, b1, b2, a1, a2]`, by the Web Audio spec's own formulas (Audio EQ Cookbook, with the spec's
 * reading of Q and S = 1 for the shelves). `q` is the AudioParam value, as in `BiquadSpec`; `gainDb` matters for shelves and peaking only.
 */
export function biquadCoeffs(type: BiquadKind, freq: number, sampleRate: number, q = 1, gainDb = 0): [number, number, number, number, number] {
  const A = 10 ** (gainDb / 40)
  const w0 = (2 * Math.PI * freq) / sampleRate
  const c = Math.cos(w0)
  const s = Math.sin(w0)
  let b: [number, number, number]
  let a: [number, number, number]
  if (type === 'lowpass' || type === 'highpass') {
    const al = s / (2 * 10 ** (q / 20))
    b = type === 'lowpass' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2]
    a = [1 + al, -2 * c, 1 - al]
  } else if (type === 'allpass') {
    const al = s / (2 * q)
    b = [1 - al, -2 * c, 1 + al]
    a = [1 + al, -2 * c, 1 - al]
  } else if (type === 'peaking') {
    const al = s / (2 * q)
    b = [1 + al * A, -2 * c, 1 - al * A]
    a = [1 + al / A, -2 * c, 1 - al / A]
  } else {
    const k = 2 * Math.sqrt(A) * (s / 2) * Math.SQRT2
    const sg = type === 'lowshelf' ? 1 : -1
    b = [A * (A + 1 - sg * (A - 1) * c + k), sg * 2 * A * (A - 1 - sg * (A + 1) * c), A * (A + 1 - sg * (A - 1) * c - k)]
    a = [A + 1 + sg * (A - 1) * c + k, -sg * 2 * (A - 1 + sg * (A + 1) * c), A + 1 + sg * (A - 1) * c - k]
  }
  return [b[0] / a[0], b[1] / a[0], b[2] / a[0], a[1] / a[0], a[2] / a[0]]
}

type Complex = [number, number]
const mul = (x: Complex, y: Complex): Complex => [x[0] * y[0] - x[1] * y[1], x[0] * y[1] + x[1] * y[0]]

function biquadAt(k: [number, number, number, number, number], w: number): Complex {
  const z1: Complex = [Math.cos(w), -Math.sin(w)]
  const z2: Complex = [Math.cos(2 * w), -Math.sin(2 * w)]
  const num: Complex = [k[0] + k[1] * z1[0] + k[2] * z2[0], k[1] * z1[1] + k[2] * z2[1]]
  const den: Complex = [1 + k[3] * z1[0] + k[4] * z2[0], k[3] * z1[1] + k[4] * z2[1]]
  const d = den[0] * den[0] + den[1] * den[1]
  return [(num[0] * den[0] + num[1] * den[1]) / d, (num[1] * den[0] - num[0] * den[1]) / d]
}

/** The whole isolator's gain at `freq`, in dB, with each band at the given linear gain. */
export function isolatorResponseDb(freq: number, sampleRate: number, gains: { low: number; mid: number; high: number }): number {
  const w = (2 * Math.PI * freq) / sampleRate
  let sum: Complex = [0, 0]
  for (const band of ['low', 'mid', 'high'] as const) {
    let h: Complex = [gains[band], 0]
    for (const f of ISOLATOR_PATHS[band]) h = mul(h, biquadAt(biquadCoeffs(f.type, f.freq, sampleRate, f.q), w))
    sum = [sum[0] + h[0], sum[1] + h[1]]
  }
  return 10 * Math.log10(sum[0] * sum[0] + sum[1] * sum[1])
}
