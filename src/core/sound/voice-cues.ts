/**
 * Three more cues for "is someone singing" (v0.12.15), from the literature on singing-voice detection
 * (docs/research/stems-and-sound-understanding.md §5.6), computed on the same magnitude spectrogram as the
 * first four cues — no new FFT:
 *  - pitch instability (a "fluctogram" in spirit): the strongest spectral peaks of a frame, matched to the
 *    previous frame's, and how far they moved in cents. A voice glides and wobbles a little; a synth line holds
 *    its pitch and a drum hit has no peak that survives to the next frame. Reported together with the share of
 *    peaks that WERE matched, because "moved 0 cents" means opposite things for a held note and for noise.
 *  - spectral flatness of the vocal band: a voiced sound is peaky (low), a hat or a rumble flat (high).
 *  - five mel-cepstral coefficients (2–6): timbre, whose movement over about a second is larger for speech
 *    and song than for a loop.
 * Pure arithmetic over arrays; the mix of the cues into a decision is the classifier's job, not this file's.
 */
const PEAK_LO_HZ = 200
const PEAK_HI_HZ = 2000
const FLAT_LO_HZ = 200
const FLAT_HI_HZ = 4000
const PEAKS = 6
/** Two peaks closer than this (cents) in consecutive frames are the same partial. */
const MATCH_CENTS = 80
const MEL_BANDS = 20
export const MFCC_COUNT = 5

export interface VoiceCues {
  /** Mean |pitch movement| of the matched peaks since the previous frame, in cents (0 when none matched). */
  fluct: Float32Array
  /** Share of this frame's peaks that matched a peak in the previous frame, 0–1. */
  consist: Float32Array
  /** Geometric over arithmetic mean of the magnitudes in 200–4000 Hz, 0–1. */
  flat: Float32Array
  /** `frames × MFCC_COUNT`: cepstral coefficients 2–6, row per frame. */
  mfcc: Float32Array
}

const mel = (hz: number): number => 2595 * Math.log10(1 + hz / 700)
const unmel = (m: number): number => 700 * (Math.pow(10, m / 2595) - 1)

/** `mag` is `frames × B`, bin `j` being FFT bin `kLo + j`, `hz` Hz per bin. */
export function voiceCues(mag: Float32Array, frames: number, B: number, kLo: number, hz: number): VoiceCues {
  const fluct = new Float32Array(frames)
  const consist = new Float32Array(frames)
  const flat = new Float32Array(frames)
  const mfcc = new Float32Array(frames * MFCC_COUNT)

  const pLo = Math.max(1, Math.round(PEAK_LO_HZ / hz) - kLo)
  const pHi = Math.min(B - 2, Math.round(PEAK_HI_HZ / hz) - kLo)
  const fLo = Math.max(0, Math.round(FLAT_LO_HZ / hz) - kLo)
  const fHi = Math.min(B - 1, Math.round(FLAT_HI_HZ / hz) - kLo)

  // Triangular mel filters over the analysed band (kLo … kLo+B-1 bins).
  const lo = kLo * hz
  const hi = (kLo + B - 1) * hz
  const edges = Array.from({ length: MEL_BANDS + 2 }, (_, i) => unmel(mel(lo) + ((mel(hi) - mel(lo)) * i) / (MEL_BANDS + 1)))
  const weights = Array.from({ length: MEL_BANDS }, (_, b) => {
    const w = new Float32Array(B)
    for (let j = 0; j < B; j++) {
      const f = (kLo + j) * hz
      if (f > edges[b] && f < edges[b + 2]) w[j] = f <= edges[b + 1] ? (f - edges[b]) / (edges[b + 1] - edges[b]) : (edges[b + 2] - f) / (edges[b + 2] - edges[b + 1])
    }
    return w
  })
  const dct = Array.from({ length: MFCC_COUNT }, (_, c) => Float32Array.from({ length: MEL_BANDS }, (_, b) => Math.cos((Math.PI * (c + 1) * (b + 0.5)) / MEL_BANDS)))
  const logMel = new Float32Array(MEL_BANDS)

  let prevF = new Float64Array(PEAKS)
  let prevN = 0
  let curF = new Float64Array(PEAKS)
  const curM = new Float64Array(PEAKS)
  for (let t = 0; t < frames; t++) {
    const o = t * B
    // The PEAKS strongest local maxima, refined to a fractional bin by a parabola through the three bins around each.
    let n = 0
    for (let j = pLo; j <= pHi; j++) {
      const m = mag[o + j]
      if (m > mag[o + j - 1] && m >= mag[o + j + 1]) {
        let slot = n < PEAKS ? n : -1
        if (slot < 0) {
          let weakest = 0
          for (let s = 1; s < PEAKS; s++) if (curM[s] < curM[weakest]) weakest = s
          if (curM[weakest] < m) slot = weakest
        } else n++
        if (slot >= 0) {
          const a = mag[o + j - 1]
          const c = mag[o + j + 1]
          const den = a - 2 * m + c
          const delta = den < -1e-18 ? (0.5 * (a - c)) / den : 0
          curF[slot] = (kLo + j + delta) * hz
          curM[slot] = m
        }
      }
    }
    let matched = 0
    let moved = 0
    for (let i = 0; i < n; i++) {
      let best = Infinity
      for (let k = 0; k < prevN; k++) {
        const cents = Math.abs(1200 * Math.log2(curF[i] / prevF[k]))
        if (cents < best) best = cents
      }
      if (best < MATCH_CENTS) {
        matched++
        moved += best
      }
    }
    fluct[t] = matched ? moved / matched : 0
    consist[t] = n ? matched / n : 0
    ;[prevF, curF] = [curF, prevF]
    prevN = n

    let logSum = 0
    let sum = 0
    for (let j = fLo; j <= fHi; j++) {
      logSum += Math.log(mag[o + j] + 1e-9)
      sum += mag[o + j]
    }
    const cnt = Math.max(1, fHi - fLo + 1)
    flat[t] = Math.min(1, Math.exp(logSum / cnt) / (sum / cnt + 1e-9))

    for (let b = 0; b < MEL_BANDS; b++) {
      let e = 0
      const w = weights[b]
      for (let j = 0; j < B; j++) if (w[j] > 0) e += w[j] * mag[o + j] * mag[o + j]
      logMel[b] = Math.log(e + 1e-10)
    }
    for (let c = 0; c < MFCC_COUNT; c++) {
      let s = 0
      for (let b = 0; b < MEL_BANDS; b++) s += dct[c][b] * logMel[b]
      mfcc[t * MFCC_COUNT + c] = s
    }
  }
  return { fluct, consist, flat, mfcc }
}
