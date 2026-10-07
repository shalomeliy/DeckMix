/**
 * Sample-rate conversion for the off-main-thread decoder (v0.9.57).
 *
 * The browser's `decodeAudioData` hands back audio at the AudioContext's rate (48 kHz on most Windows machines), whatever the file's own
 * rate. Everything learned from that audio — the vocal models trained on Shalom's marks, the similarity vectors, the cached analyses — saw
 * it at that rate, and the spectrogram's frequency bins depend on it. So the Worker decoder converts to the same rate before anything
 * else reads it, instead of feeding the analysis 44.1 kHz and quietly shifting every bin by 9%.
 *
 * Windowed-sinc (Blackman), 32 zero crossings each side, with the cutoff lowered when downsampling so nothing folds back.
 */
const ZERO_CROSSINGS = 32
/** Sub-sample positions the kernel is tabulated at; the rest is linear interpolation between them. */
const TABLE_RES = 512

export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input
  if (!(fromRate > 0) || !(toRate > 0)) throw new Error(`cannot resample from ${fromRate} Hz to ${toRate} Hz`)
  const ratio = toRate / fromRate
  // in units of the input Nyquist; downsampling stops a little short of the new Nyquist so the window's transition band does not fold back
  const cutoff = ratio < 1 ? ratio * 0.97 : 1
  const outLength = Math.round(input.length * ratio)
  const out = new Float32Array(outLength)
  const half = Math.ceil(ZERO_CROSSINGS / cutoff)
  // kernel(x) for x in input samples, x = i / TABLE_RES, 0 <= i <= half * TABLE_RES
  const table = new Float32Array(half * TABLE_RES + 2)
  for (let i = 0; i < table.length; i++) {
    const x = i / TABLE_RES
    if (x >= half) break
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x * cutoff) / (Math.PI * x * cutoff)
    const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / half) + 0.08 * Math.cos((2 * Math.PI * x) / half)
    table[i] = cutoff * sinc * w
  }
  // Polyphase for the usual pairs (44.1 -> 48 kHz is 160/147): every output sample falls on one of `up` sub-sample phases, so each
  // phase's taps are worked out once and the inner loop is a plain multiply-add. Measured 07/10: ~3x faster than looking the kernel up
  // per tap, which matters because this runs once per song for every song the library analyses.
  const g = gcd(fromRate, toRate)
  const up = toRate / g
  const down = fromRate / g
  if (up <= MAX_PHASES) {
    const taps = 2 * half
    const bank = new Float32Array(up * taps)
    for (let ph = 0; ph < up; ph++) {
      const frac = ph / up
      for (let j = 0; j < taps; j++) bank[ph * taps + j] = kernelAt(table, Math.abs(j - half + 1 - frac))
    }
    for (let n = 0; n < outLength; n++) {
      const num = n * down
      const center = Math.floor(num / up)
      const ph = num - center * up
      const base = ph * taps
      const first = center - half + 1
      let acc = 0
      if (first >= 0 && first + taps <= input.length) {
        for (let j = 0; j < taps; j++) acc += input[first + j] * bank[base + j]
      } else {
        for (let j = 0; j < taps; j++) {
          const k = first + j
          if (k >= 0 && k < input.length) acc += input[k] * bank[base + j]
        }
      }
      out[n] = acc
    }
    return out
  }
  const step = 1 / ratio
  for (let n = 0; n < outLength; n++) {
    const pos = n * step
    const center = Math.floor(pos)
    const frac = pos - center
    let acc = 0
    const lo = Math.max(0, center - half + 1)
    const hi = Math.min(input.length - 1, center + half)
    for (let k = lo; k <= hi; k++) {
      acc += input[k] * kernelAt(table, Math.abs(k - center - frac))
    }
    out[n] = acc
  }
  return out
}

/** Above this many phases a rate pair is treated as irrational and the kernel is looked up per tap instead. */
const MAX_PHASES = 2048

function kernelAt(table: Float32Array, x: number): number {
  const t = x * TABLE_RES
  const ti = t | 0
  if (ti >= table.length - 1) return 0
  return table[ti] + (table[ti + 1] - table[ti]) * (t - ti)
}

function gcd(a: number, b: number): number {
  a = Math.round(a)
  b = Math.round(b)
  while (b) [a, b] = [b, a % b]
  return a
}
