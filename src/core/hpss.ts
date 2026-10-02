import type { Spectrogram } from '@/core/spectrogram'

/**
 * Harmonic / percussive / residual split by median filtering (Fitzgerald 2010;
 * residual from Driedger, Müller & Disch 2014 — see
 * `docs/research/stems-and-sound-understanding.md` §5.1). Written from the
 * papers, no code or weights taken from anywhere.
 *
 * It returns per-frame *energy fractions*, not masked spectrograms: a 5-minute
 * track at hop 1024 is ~6,500 frames x 1,025 bins, and three full masks would
 * be ~80MB for a number the UI only ever reads per second.
 *
 * The residual is not "unknown, ignore it": it is where vocal consonants,
 * breaths and reverb tails land, so step A's vocal cue reads it. A frame that
 * lands in none of the three (silence) reports all zeros and `silent: true` —
 * never a made-up 100% harmonic.
 */
export interface HpssFrames {
  harmonic: Float32Array
  percussive: Float32Array
  residual: Float32Array
  /** True where the frame carried no energy at all, so the fractions above mean nothing. */
  silent: Uint8Array
}

export interface HpssOptions {
  /** Median half-window along time, in seconds (~0.2 s total in the paper). */
  timeHalfSec?: number
  /** Median half-window along frequency, in Hz (~500 Hz total in the paper). */
  freqHalfHz?: number
  /** Separation factor: a bin goes to a side only when it beats the other by this ratio. */
  beta?: number
}

const EPS = 1e-9
const SILENCE_ENERGY = 1e-10

/** Median of `buf[0..n)` — insertion sort, because n is ~17 and Array.sort measured 10x slower (research §5.8). */
function median(buf: Float32Array, n: number): number {
  for (let i = 1; i < n; i++) {
    const v = buf[i]
    let j = i - 1
    while (j >= 0 && buf[j] > v) {
      buf[j + 1] = buf[j]
      j--
    }
    buf[j + 1] = v
  }
  return buf[n >> 1]
}

export function hpssFrames(spec: Spectrogram, opts: HpssOptions = {}): HpssFrames {
  const { frames, hop, sampleRate, frameSize } = spec
  const nFrames = frames.length
  const bins = frameSize / 2 + 1
  const timeHalf = Math.max(1, Math.round(((opts.timeHalfSec ?? 0.1) * sampleRate) / hop))
  const binHz = sampleRate / frameSize
  const freqHalf = Math.max(1, Math.round((opts.freqHalfHz ?? 250) / binHz))
  const beta = opts.beta ?? 2

  const harmonic = new Float32Array(nFrames)
  const percussive = new Float32Array(nFrames)
  const residual = new Float32Array(nFrames)
  const silent = new Uint8Array(nFrames)
  const timeBuf = new Float32Array(2 * timeHalf + 1)
  const freqBuf = new Float32Array(2 * freqHalf + 1)

  for (let t = 0; t < nFrames; t++) {
    const cur = frames[t]
    let h = 0
    let p = 0
    let r = 0
    for (let f = 0; f < bins; f++) {
      let n = 0
      for (let dt = -timeHalf; dt <= timeHalf; dt++) {
        const tt = t + dt
        if (tt >= 0 && tt < nFrames) timeBuf[n++] = frames[tt][f]
      }
      const hMed = median(timeBuf, n)
      n = 0
      for (let df = -freqHalf; df <= freqHalf; df++) {
        const ff = f + df
        if (ff >= 0 && ff < bins) freqBuf[n++] = cur[ff]
      }
      const pMed = median(freqBuf, n)
      const e = cur[f] * cur[f]
      if (hMed / (pMed + EPS) > beta) h += e
      else if (pMed / (hMed + EPS) >= beta) p += e
      else r += e
    }
    const total = h + p + r
    if (total < SILENCE_ENERGY) {
      silent[t] = 1
      continue
    }
    harmonic[t] = h / total
    percussive[t] = p / total
    residual[t] = r / total
  }
  return { harmonic, percussive, residual, silent }
}
