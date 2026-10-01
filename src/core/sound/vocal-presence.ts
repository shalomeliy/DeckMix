/**
 * Where the voice is (v0.9.10): a half-second timeline from classical DSP —
 * no training, no weights, no separation. Pure; runs in a Worker
 * (`platform/vocal-timeline`) but knows nothing about one.
 *
 * Cues (docs/research/stems-and-sound-understanding.md §5.2, §5.4, §5.6):
 *  - harmonic dominance: HPSS by median filters splits the spectrum into what
 *    holds still in time (harmonic) and what holds still in frequency
 *    (percussive); a voice lives in the first.
 *  - centre-panned share of that harmonic energy in the vocal band. Dance
 *    music centres its kick and bass too, so this only means something *after*
 *    the harmonic filter — and a mono file has none of it (stated, not hidden).
 *  - syllabic motion: the harmonic level moves at 3–8 Hz when someone sings or
 *    raps; a pad or a synth line does not.
 * Each is turned into a score by constants fitted on the owner's *training*
 * clips only (the sealed ones were not opened — see docs/handoff/v0.9.10.md).
 * A cell where the evidence is weak or the cues disagree is `unsure`, not `none`.
 */
import { createFft } from '@/core/sound/fft'
import {
  CELL_NONE,
  CELL_UNSURE,
  CELL_VOCAL,
  VOCAL_CELL_SEC,
  VOCAL_MIN_SEC,
  stateOfTimeline,
  type VocalResult,
} from '@/core/sound/vocal-timeline'
import type { PcmData } from '@/core/ports/analyzer'
import { voiceCues, type VoiceCues } from '@/core/sound/voice-cues'

const TARGET_SR = 22050
const FRAME = 2048
const HOP = 1024
/** Median-filter widths of HPSS: ~0.8 s along time, ~170 Hz along frequency. */
const MEDIAN_TIME = 17
const MEDIAN_FREQ = 17
const BAND_LO_HZ = 100
const BAND_HI_HZ = 5000
const VOCAL_LO_HZ = 200
const VOCAL_HI_HZ = 4000
const BRIGHT_LO_HZ = 500
const BRIGHT_HI_HZ = 3500
/** Peak below this (full scale 1.0) over the whole file is silence. */
const SILENT_PEAK = 1e-3
/** Mean |L−R| over mean |L|+|R| below this: the two channels are the same signal. */
const MONO_RATIO = 0.01

export interface VocalFeatures {
  frameSec: number
  frames: number
  stereo: boolean
  /** Harmonic share of the energy in the vocal band, 0–1. */
  harmonic: Float32Array
  /** Centre-panned share of the harmonic vocal-band energy, 0–1. All zero when mono. */
  centre: Float32Array
  /** Share of harmonic energy that sits in the bright (formant) region 500–3500 Hz. */
  bright: Float32Array
  /** RMS of the 3–8 Hz movement of the harmonic level over ~1 s, in log units. */
  motion: Float32Array
  /** Log of the harmonic vocal-band energy — whether anything is there at all. */
  level: Float32Array
  /** v0.12.15: pitch instability, flatness and mel-cepstral coefficients (voice-cues.ts). Not part of the score yet. */
  cues: VoiceCues
}

export type FeaturesOrState = { features: VocalFeatures } | { result: VocalResult }

function isMono(pcm: PcmData): boolean {
  if (pcm.channels.length < 2) return true
  const l = pcm.channels[0]
  const r = pcm.channels[1]
  const step = Math.max(1, Math.floor(l.length / 200000))
  let diff = 0
  let sum = 0
  for (let i = 0; i < l.length; i += step) {
    diff += Math.abs(l[i] - r[i])
    sum += Math.abs(l[i]) + Math.abs(r[i])
  }
  return sum === 0 || diff / sum < MONO_RATIO
}

function insertionMedian(buf: Float32Array, n: number): number {
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

function movingMean(x: Float32Array, radius: number): Float32Array {
  const n = x.length
  const out = new Float32Array(n)
  const pre = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i]
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius)
    const b = Math.min(n, i + radius + 1)
    out[i] = (pre[b] - pre[a]) / (b - a)
  }
  return out
}

/** The costly front half: decimate, STFT, HPSS and the per-frame features. Never throws on degenerate input — returns the named state instead. */
export function vocalFeatures(pcm: PcmData): FeaturesOrState {
  const sr = pcm.sampleRate
  const chans = pcm.channels
  if (chans.length === 0 || !(sr > 0)) return { result: { state: 'failed', timeline: null, note: 'no audio' } }
  const length = chans[0].length
  if (length / sr < VOCAL_MIN_SEC) return { result: { state: 'too-short', timeline: null } }
  let peak = 0
  const peakStep = Math.max(1, Math.floor(length / 400000))
  for (let c = 0; c < Math.min(2, chans.length); c++) {
    for (let i = 0; i < length; i += peakStep) peak = Math.max(peak, Math.abs(chans[c][i]))
  }
  if (!(peak > SILENT_PEAK)) return { result: { state: 'silent', timeline: null } }

  const stereo = !isMono(pcm)
  const left = chans[0]
  const right = stereo ? chans[1] : chans[0]
  const d = Math.max(1, Math.round(sr / TARGET_SR))
  const sr2 = sr / d
  const hopSrc = HOP * d
  const frames = Math.floor((length - FRAME * d) / hopSrc) + 1
  if (frames < MEDIAN_TIME * 2) return { result: { state: 'too-short', timeline: null } }
  const hz = sr2 / FRAME
  const kLo = Math.max(1, Math.round(BAND_LO_HZ / hz))
  const kHi = Math.min(FRAME / 2 - 1, Math.round(BAND_HI_HZ / hz))
  const B = kHi - kLo + 1
  const vLo = Math.round(VOCAL_LO_HZ / hz) - kLo
  const vHi = Math.round(VOCAL_HI_HZ / hz) - kLo
  const bLo = Math.round(BRIGHT_LO_HZ / hz) - kLo
  const bHi = Math.round(BRIGHT_HI_HZ / hz) - kLo

  const fft = createFft(FRAME)
  const hann = new Float64Array(FRAME)
  for (let i = 0; i < FRAME; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME)
  const re = new Float64Array(FRAME)
  const im = new Float64Array(FRAME)
  const mag = new Float32Array(frames * B)
  const psi = stereo ? new Uint8Array(frames * B) : null

  for (let t = 0; t < frames; t++) {
    const base = t * hopSrc
    for (let i = 0; i < FRAME; i++) {
      let a = 0
      let b = 0
      const s = base + i * d
      for (let j = 0; j < d; j++) {
        a += left[s + j]
        b += right[s + j]
      }
      re[i] = (hann[i] * a) / d
      im[i] = (hann[i] * b) / d
    }
    fft.forward(re, im)
    for (let k = kLo; k <= kHi; k++) {
      const a = re[k]
      const b = im[k]
      const c = re[FRAME - k]
      const dd = im[FRAME - k]
      // one complex FFT of (left + i·right): split it back into the two spectra
      const lr = (a + c) / 2
      const li = (b - dd) / 2
      const rr = (b + dd) / 2
      const ri = (c - a) / 2
      const o = t * B + (k - kLo)
      mag[o] = Math.hypot(lr + rr, li + ri) / 2
      if (psi) {
        const cr = lr * rr + li * ri
        const ci = li * rr - lr * ri
        const den = lr * lr + li * li + rr * rr + ri * ri
        psi[o] = den > 1e-18 ? Math.round((255 * 2 * Math.hypot(cr, ci)) / den) : 0
      }
    }
  }

  // HPSS: the median along time keeps what is steady (harmonic), along frequency what is a click (percussive)
  const harm = new Float32Array(frames * B)
  const perc = new Float32Array(frames * B)
  const win = new Float32Array(Math.max(MEDIAN_TIME, MEDIAN_FREQ))
  const ht = MEDIAN_TIME >> 1
  for (let k = 0; k < B; k++) {
    for (let t = 0; t < frames; t++) {
      let n = 0
      for (let u = Math.max(0, t - ht); u <= Math.min(frames - 1, t + ht); u++) win[n++] = mag[u * B + k]
      harm[t * B + k] = insertionMedian(win, n)
    }
  }
  const hf = MEDIAN_FREQ >> 1
  for (let t = 0; t < frames; t++) {
    for (let k = 0; k < B; k++) {
      let n = 0
      for (let u = Math.max(0, k - hf); u <= Math.min(B - 1, k + hf); u++) win[n++] = mag[t * B + u]
      perc[t * B + k] = insertionMedian(win, n)
    }
  }

  const harmonic = new Float32Array(frames)
  const centre = new Float32Array(frames)
  const bright = new Float32Array(frames)
  const level = new Float32Array(frames)
  for (let t = 0; t < frames; t++) {
    let eAll = 0
    let eH = 0
    let eCentre = 0
    let eBright = 0
    for (let k = vLo; k <= vHi; k++) {
      const o = t * B + k
      const m2 = mag[o] * mag[o]
      const h2 = harm[o] * harm[o]
      const p2 = perc[o] * perc[o]
      const mask = h2 / (h2 + p2 + 1e-18)
      const eh = mask * m2
      eAll += m2
      eH += eh
      if (psi && psi[o] > 204) eCentre += eh // psi > 0.8: centre-panned
      if (k >= bLo && k <= bHi) eBright += eh
    }
    harmonic[t] = eAll > 1e-18 ? eH / eAll : 0
    centre[t] = eH > 1e-18 ? eCentre / eH : 0
    bright[t] = eH > 1e-18 ? eBright / eH : 0
    level[t] = Math.log(eH + 1e-12)
  }

  // motion: the harmonic level moving at syllable rate — a fast mean minus a slow mean, as RMS over ~1 s
  const fast = movingMean(level, 2)
  const slow = movingMean(level, 9)
  const band = new Float32Array(frames)
  for (let t = 0; t < frames; t++) band[t] = fast[t] - slow[t]
  const motion = new Float32Array(frames)
  const w = 11
  for (let t = 0; t < frames; t++) {
    let s = 0
    let n = 0
    for (let u = Math.max(0, t - w); u <= Math.min(frames - 1, t + w); u++) {
      s += band[u] * band[u]
      n++
    }
    motion[t] = Math.sqrt(s / n)
  }

  const cues = voiceCues(mag, frames, B, kLo, hz)
  return { features: { frameSec: HOP / sr2, frames, stereo, harmonic, centre, bright, motion, level, cues } }
}

/** The constants of the score. Fitted on the training clips; see the file comment. */
export interface VocalParams {
  wHarmonic: number
  wCentre: number
  wBright: number
  wMotion: number
  /** `score >= hi` is vocal, `score <= lo` is none, between is unsure. */
  hi: number
  lo: number
  /** Mono: the centre cue is missing, so the score is held this close to 0.5 and never reaches the confident ends. */
  monoCap: number
}

export const VOCAL_PARAMS: VocalParams = {
  wHarmonic: 1,
  wCentre: 1,
  wBright: 1,
  wMotion: 1,
  hi: 0.6,
  lo: 0.4,
  monoCap: 0.1,
}

/** Features → one score per frame, roughly 0–1. Exposed so the fit can be done offline on the same code. */
export function frameScores(f: VocalFeatures, p: VocalParams): Float32Array {
  const out = new Float32Array(f.frames)
  const wSum = p.wHarmonic + p.wBright + p.wMotion + (f.stereo ? p.wCentre : 0)
  for (let t = 0; t < f.frames; t++) {
    const motion = Math.min(1, f.motion[t] / 0.5)
    const s =
      p.wHarmonic * f.harmonic[t] + p.wBright * f.bright[t] + p.wMotion * motion + (f.stereo ? p.wCentre * f.centre[t] : 0)
    out[t] = s / (wSum || 1)
  }
  return out
}

/** Frame scores → half-second cells: mean per cell, 3-cell median, two thresholds. Silence is none; weak evidence is unsure. */
export function classifyCells(f: VocalFeatures, p: VocalParams, durationSec: number): Uint8Array {
  const scores = frameScores(f, p)
  const nCells = Math.max(1, Math.ceil(durationSec / VOCAL_CELL_SEC))
  const raw = new Float32Array(nCells)
  const quiet = new Uint8Array(nCells)
  let maxLevel = -Infinity
  for (let t = 0; t < f.frames; t++) maxLevel = Math.max(maxLevel, f.level[t])
  for (let c = 0; c < nCells; c++) {
    const t0 = Math.min(f.frames - 1, Math.floor((c * VOCAL_CELL_SEC) / f.frameSec))
    const t1 = Math.min(f.frames, Math.max(t0 + 1, Math.floor(((c + 1) * VOCAL_CELL_SEC) / f.frameSec)))
    let s = 0
    let lv = 0
    for (let t = t0; t < t1; t++) {
      s += scores[t]
      lv += f.level[t]
    }
    raw[c] = s / (t1 - t0)
    // far below the loudest part of the track in the vocal band: no voice there
    quiet[c] = lv / (t1 - t0) < maxLevel - 9 ? 1 : 0
  }
  const sm = new Float32Array(nCells)
  const buf = new Float32Array(3)
  for (let c = 0; c < nCells; c++) {
    buf[0] = raw[Math.max(0, c - 1)]
    buf[1] = raw[c]
    buf[2] = raw[Math.min(nCells - 1, c + 1)]
    sm[c] = insertionMedian(buf, 3)
  }
  const cells = new Uint8Array(nCells)
  for (let c = 0; c < nCells; c++) {
    if (quiet[c]) {
      cells[c] = CELL_NONE
      continue
    }
    let s = sm[c]
    if (!f.stereo) s = Math.min(Math.max(s, 0.5 - p.monoCap), 0.5 + p.monoCap)
    cells[c] = s >= p.hi ? CELL_VOCAL : s <= p.lo ? CELL_NONE : CELL_UNSURE
  }
  return cells
}

export function detectVocalTimeline(pcm: PcmData, params: VocalParams = VOCAL_PARAMS): VocalResult {
  try {
    const r = vocalFeatures(pcm)
    if ('result' in r) return r.result
    const durationSec = pcm.channels[0].length / pcm.sampleRate
    const timeline = { cells: classifyCells(r.features, params, durationSec), stereo: r.features.stereo }
    return { state: stateOfTimeline(timeline), timeline }
  } catch (err) {
    return { state: 'failed', timeline: null, note: err instanceof Error ? err.message : String(err) }
  }
}
