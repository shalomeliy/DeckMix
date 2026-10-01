/**
 * In-place radix-2 complex FFT (v0.9.10). `core/` had none — the embedder's
 * lives inside meyda, in a Worker — and the vocal timeline needs its own so it
 * stays pure. Twiddles and the bit-reversal table are built once per size:
 * recomputing them per frame was the 7 s → 0.6 s difference the research
 * measured (docs/research/stems-and-sound-understanding.md §5.8).
 */
export interface Fft {
  readonly size: number
  /** Transforms `re`/`im` (length `size`) in place. */
  forward(re: Float64Array, im: Float64Array): void
}

export function createFft(size: number): Fft {
  if (size < 2 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${size}`)
  const levels = Math.log2(size)
  const cos = new Float64Array(size / 2)
  const sin = new Float64Array(size / 2)
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / size)
    sin[i] = Math.sin((2 * Math.PI * i) / size)
  }
  const rev = new Uint32Array(size)
  for (let i = 0; i < size; i++) {
    let r = 0
    for (let b = 0; b < levels; b++) r |= ((i >>> b) & 1) << (levels - 1 - b)
    rev[i] = r
  }
  return {
    size,
    forward(re, im) {
      for (let i = 0; i < size; i++) {
        const j = rev[i]
        if (j > i) {
          const tr = re[i]
          re[i] = re[j]
          re[j] = tr
          const ti = im[i]
          im[i] = im[j]
          im[j] = ti
        }
      }
      for (let half = 1; half < size; half <<= 1) {
        const step = size / (half * 2)
        for (let start = 0; start < size; start += half * 2) {
          for (let k = 0; k < half; k++) {
            const wr = cos[k * step]
            const wi = -sin[k * step]
            const a = start + k
            const b = a + half
            const xr = re[b] * wr - im[b] * wi
            const xi = re[b] * wi + im[b] * wr
            re[b] = re[a] - xr
            im[b] = im[a] - xi
            re[a] += xr
            im[a] += xi
          }
        }
      }
    },
  }
}
