/**
 * Magnitude spectrogram (STFT) in plain TypeScript — v0.9.10, step A of "sound
 * understanding". Pure on purpose: `core/` may not touch `AudioContext` or the
 * DOM, and a Tauri build has no browser to lean on. The caller hands in samples
 * it already decoded; this file never decodes anything.
 */

export interface Spectrogram {
  /** One magnitude array per frame, each `frameSize / 2 + 1` bins long. */
  frames: Float32Array[]
  frameSize: number
  hop: number
  sampleRate: number
}

export const DEFAULT_FRAME_SIZE = 2048

const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array }>()

function twiddles(n: number) {
  let t = twiddleCache.get(n)
  if (!t) {
    const cos = new Float64Array(n / 2)
    const sin = new Float64Array(n / 2)
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n)
      sin[i] = -Math.sin((2 * Math.PI * i) / n)
    }
    t = { cos, sin }
    twiddleCache.set(n, t)
  }
  return t
}

/** In-place radix-2 FFT. `re.length` must be a power of two — a non-power throws, it never pads quietly. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  if (n < 2 || (n & (n - 1)) !== 0) throw new RangeError(`fft size must be a power of two, got ${n}`)
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  const { cos, sin } = twiddles(n)
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const step = n / len
    for (let start = 0; start < n; start += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step]
        const wi = sin[k * step]
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
}

export function stftMagnitude(
  samples: Float32Array,
  sampleRate: number,
  frameSize = DEFAULT_FRAME_SIZE,
  hop = frameSize / 2,
): Spectrogram {
  const window = new Float64Array(frameSize)
  for (let i = 0; i < frameSize; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frameSize)
  const frames: Float32Array[] = []
  const re = new Float64Array(frameSize)
  const im = new Float64Array(frameSize)
  const bins = frameSize / 2 + 1
  for (let start = 0; start + frameSize <= samples.length; start += hop) {
    for (let i = 0; i < frameSize; i++) {
      re[i] = samples[start + i] * window[i]
      im[i] = 0
    }
    fft(re, im)
    const mag = new Float32Array(bins)
    for (let k = 0; k < bins; k++) mag[k] = Math.hypot(re[k], im[k])
    frames.push(mag)
  }
  return { frames, frameSize, hop, sampleRate }
}
