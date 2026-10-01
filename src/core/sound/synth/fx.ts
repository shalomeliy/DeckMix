/**
 * Effects that make the laid-on voice sound like a mixed one (v0.12.15, round 3). Round 2 showed that a
 * classifier trained on dry voices over dry music scores 95% on those and about chance on the owner's real
 * dance songs. A real vocal is high-passed, sits in a reverb, is often doubled or widened, and the whole mix
 * goes through a bus compressor — all missing before. Textbook Schroeder reverb (parallel combs into series
 * all-passes, Schroeder 1962); nothing here is sampled from a recording or a plug-in.
 */
const TWO_PI = Math.PI * 2

export function highpass(x: Float32Array, sr: number, fc: number): Float32Array {
  const a = 1 - Math.exp((-TWO_PI * fc) / sr)
  const out = new Float32Array(x.length)
  let lp = 0
  for (let i = 0; i < x.length; i++) {
    lp += a * (x[i] - lp)
    out[i] = x[i] - lp
  }
  return out
}

const COMB_MS = [
  [29.7, 37.1, 41.1, 43.7],
  [31.1, 35.3, 42.9, 45.3],
]
const ALLPASS_MS = [5, 1.7]

/** Wet-only stereo reverb of `x`: length `x.length + tail`. `decay` ~0.7 (small room) … 0.88 (hall). */
export function reverb(x: Float32Array, sr: number, decay: number): [Float32Array, Float32Array] {
  const tail = Math.round(1.4 * sr)
  const n = x.length + tail
  return COMB_MS.map((side) => {
    const out = new Float32Array(n)
    for (const ms of side) {
      const d = Math.max(1, Math.round((ms * sr) / 1000))
      const buf = new Float32Array(d)
      let idx = 0
      let damp = 0
      for (let i = 0; i < n; i++) {
        const y = buf[idx]
        damp = y * 0.6 + damp * 0.4 // darker with every trip round the loop, like air and walls
        buf[idx] = (i < x.length ? x[i] : 0) + damp * decay
        out[i] += y * 0.25
        idx = (idx + 1) % d
      }
    }
    for (const ms of ALLPASS_MS) {
      const d = Math.max(1, Math.round((ms * sr) / 1000))
      const buf = new Float32Array(d)
      let idx = 0
      for (let i = 0; i < n; i++) {
        const y = buf[idx]
        const v = out[i] + 0.5 * y
        buf[idx] = v
        out[i] = y - 0.5 * v
        idx = (idx + 1) % d
      }
    }
    return out
  }) as [Float32Array, Float32Array]
}

/**
 * Bus-compressor gain curve for a stereo mix: one gain per sample, to be applied to the mixture AND to every
 * stem (a time-varying gain keeps "stems sum to the mixture" true). Threshold sits at the 60th percentile of
 * the 10 ms block levels, so about the louder 40% of the song is squeezed; ratio 4, attack ~20 ms, release ~150 ms.
 * Why it exists: without it a voice laid on top raises the level, and the classifier learned "louder = vocal".
 */
export function compressorGain(l: Float32Array, r: Float32Array, sr: number, ratio = 4): Float32Array {
  const block = Math.max(1, Math.round(0.01 * sr))
  const nb = Math.ceil(l.length / block)
  const rms = new Float32Array(nb)
  for (let b = 0; b < nb; b++) {
    let s = 0
    const a = b * block
    const z = Math.min(l.length, a + block)
    for (let i = a; i < z; i++) s += l[i] * l[i] + r[i] * r[i]
    rms[b] = Math.sqrt(s / (2 * (z - a)))
  }
  const sorted = Float32Array.from(rms).sort()
  const thr = Math.max(1e-6, sorted[Math.floor(nb * 0.6)])
  const gains = new Float32Array(nb)
  let g = 1
  for (let b = 0; b < nb; b++) {
    const target = rms[b] > thr ? Math.pow(thr / rms[b], 1 - 1 / ratio) : 1
    g += (target - g) * (target < g ? 0.39 : 0.065) // attack faster than release
    gains[b] = g
  }
  const out = new Float32Array(l.length)
  for (let i = 0; i < l.length; i++) {
    const p = i / block
    const b0 = Math.min(nb - 1, Math.floor(p))
    const b1 = Math.min(nb - 1, b0 + 1)
    out[i] = gains[b0] + (gains[b1] - gains[b0]) * (p - b0)
  }
  return out
}
