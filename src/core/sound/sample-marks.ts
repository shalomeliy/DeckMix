/**
 * Sample marking experiment (v0.9.30 stage 1, 11/10): the owner listens to a song and marks the stretches he would keep as a sample — a `loop`
 * (a groove that repeats cleanly, snapped to the yellow bar lines) or a `hit` (one sound: a stab, a riser, an effect, not snapped). Next to his
 * marks the app draws its own candidates, so the two can be compared afterwards on the same songs (docs/research/sampler-finder.md).
 * Pure: no storage, no clock, no audio device.
 *
 * The candidate score is the one the design-around chose: a block of N bars is compared with the WHOLE NEXT block of N bars (13 log-spaced
 * frequency bands, one value per sixteenth note, one correlation over all of it). It never compares the first beat of a block with its last
 * beat — that is the claim of an active third-party patent (US10460763), see the research doc. Do not "simplify" it into that.
 */
import { barLineAtOrAfterSec, barLineAtOrBeforeSec } from '@/core/sound/vocal-manual'
import { createFft } from '@/core/sound/fft'
import type { BeatGrid } from '@/core/types'

export type SampleKind = 'loop' | 'hit'

export interface SampleRegion {
  fromSec: number
  toSec: number
  kind: SampleKind
}

/** What the app showed him for this song when he finished it, so a later comparison needs no audio. */
export interface ShownCandidate {
  bars: number
  fromSec: number
  toSec: number
  score: number
}

export interface SampleMarkTag {
  schema: 1
  contentHash: string
  trackId: string
  name: string
  genre?: string
  regions: SampleRegion[]
  /** True once he said "I listened to the whole song": everything outside the regions is then "not worth keeping". */
  finished: boolean
  gridBpm?: number
  gridOffsetSec?: number
  shown?: ShownCandidate[]
  updatedAt: number
}

/** A loop shorter than this is a mis-click; a hit can be very short, but not a double click. */
export const MIN_LOOP_SEC = 0.5
export const MIN_HIT_SEC = 0.1

export type AddSampleResult = { ok: true; regions: SampleRegion[] } | { ok: false; reason: 'too-short' | 'bad-time' }

function usable(grid: BeatGrid | null): grid is BeatGrid {
  return !!grid && Number.isFinite(grid.bpm) && grid.bpm > 0 && Number.isFinite(grid.offsetSec)
}

/**
 * The mark two presses make. A loop goes out to the yellow lines (start back to the line before the first press, end forward to the line after
 * the second — the same rule the vocal marks use) so it can be looped as it is; with no grid it keeps the presses. A hit keeps the presses.
 * The too-short check is on the PRESSES, before snapping, so two accidental presses never become a whole bar.
 */
export function addSampleRegion(
  regions: readonly SampleRegion[],
  kind: SampleKind,
  pressA: number,
  pressB: number,
  durationSec: number,
  grid: BeatGrid | null,
): AddSampleResult {
  if (![pressA, pressB, durationSec].every(Number.isFinite) || durationSec <= 0) return { ok: false, reason: 'bad-time' }
  const lo = Math.min(pressA, pressB)
  const hi = Math.max(pressA, pressB)
  if (hi - lo < (kind === 'loop' ? MIN_LOOP_SEC : MIN_HIT_SEC)) return { ok: false, reason: 'too-short' }
  let from = lo
  let to = hi
  if (kind === 'loop' && usable(grid)) {
    from = barLineAtOrBeforeSec(lo, grid)
    to = barLineAtOrAfterSec(hi, grid)
  }
  from = Math.max(0, from)
  to = Math.min(durationSec, to)
  if (to - from < MIN_HIT_SEC) return { ok: false, reason: 'too-short' }
  return { ok: true, regions: [...regions, { fromSec: from, toSec: to, kind }] }
}

export function removeLastSample(regions: readonly SampleRegion[]): SampleRegion[] {
  return regions.slice(0, -1)
}

// ───────────────────────── the app's candidates ─────────────────────────

/** 13 bands by design; at 8192 points a couple of the lowest are narrower than one FFT bin and stay empty (a constant, which the correlation ignores). */
export const SAMPLE_BINS = 13
/** One analysis frame every 50 ms: finer than a sixteenth note at any tempo the app plays, so a grid found later can still be laid over it. */
export const FRAME_HOP_SEC = 0.05
const FRAME_SIZE = 8192
const SAMPLE_EDGES_HZ = (() => {
  const e: number[] = []
  for (let i = 0; i <= 8; i++) e.push(35 * Math.pow(160 / 35, i / 8))
  for (let i = 1; i <= 4; i++) e.push(160 * Math.pow(10, i / 4))
  e.push(5000)
  return e
})()

export interface BandFrames {
  sampleRate: number
  hopSec: number
  /** frames × SAMPLE_BINS mean power per band (linear), frame i is centred at `i * hopSec + FRAME_SIZE / 2 / sampleRate`. */
  power: Float32Array
  frames: number
}

export function bandFrameCount(sampleCount: number, sampleRate: number): number {
  const hop = Math.round(FRAME_HOP_SEC * sampleRate)
  return sampleCount < FRAME_SIZE ? 0 : Math.floor((sampleCount - FRAME_SIZE) / hop) + 1
}

export function createBandFrames(sampleCount: number, sampleRate: number): BandFrames {
  const frames = bandFrameCount(sampleCount, sampleRate)
  return { sampleRate, hopSec: Math.round(FRAME_HOP_SEC * sampleRate) / sampleRate, power: new Float32Array(frames * SAMPLE_BINS), frames }
}

let fftCache: ReturnType<typeof createFft> | null = null
let windowCache: Float64Array | null = null

/** Fills frames [from, to) of `out` from `mono`. Chunked so the caller can yield between chunks; the FFT tables are built once. */
export function fillBandFrames(mono: Float32Array, out: BandFrames, from: number, to: number): void {
  const fft = (fftCache ??= createFft(FRAME_SIZE))
  const win =
    windowCache ??
    (windowCache = Float64Array.from({ length: FRAME_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_SIZE - 1))))
  const hop = Math.round(out.hopSec * out.sampleRate)
  const re = new Float64Array(FRAME_SIZE)
  const im = new Float64Array(FRAME_SIZE)
  const binHz = out.sampleRate / FRAME_SIZE
  const first = SAMPLE_EDGES_HZ.map((hz) => Math.ceil(hz / binHz))
  for (let f = from; f < Math.min(to, out.frames); f++) {
    const at = f * hop
    for (let i = 0; i < FRAME_SIZE; i++) {
      re[i] = mono[at + i] * win[i]
      im[i] = 0
    }
    fft.forward(re, im)
    for (let b = 0; b < SAMPLE_BINS; b++) {
      let sum = 0
      for (let k = first[b]; k < first[b + 1]; k++) sum += re[k] * re[k] + im[k] * im[k]
      out.power[f * SAMPLE_BINS + b] = sum / (FRAME_SIZE * FRAME_SIZE)
    }
  }
}

/** Band energy per sixteenth note of [startSec, startSec + sixteenths × step): log of the mean power of the frames whose centre falls inside it. */
function contour(frames: BandFrames, startSec: number, stepSec: number, sixteenths: number): Float64Array {
  const out = new Float64Array(sixteenths * SAMPLE_BINS)
  const centre = FRAME_SIZE / 2 / frames.sampleRate
  for (let s = 0; s < sixteenths; s++) {
    const a = startSec + s * stepSec
    let f0 = Math.max(0, Math.ceil((a - centre) / frames.hopSec))
    let f1 = Math.min(frames.frames, Math.ceil((a + stepSec - centre) / frames.hopSec))
    // The first and last sixteenths of a song lie outside every frame's centre (a frame is 0.37 s long): they take the nearest frame, never silence,
    // or the first block of every song would score as if its opening were empty.
    if (f1 <= f0) {
      f0 = Math.min(frames.frames - 1, Math.max(0, Math.round((a + stepSec / 2 - centre) / frames.hopSec)))
      f1 = f0 + 1
    }
    for (let b = 0; b < SAMPLE_BINS; b++) {
      let sum = 0
      for (let f = f0; f < f1; f++) sum += frames.power[f * SAMPLE_BINS + b]
      out[s * SAMPLE_BINS + b] = Math.log(1e-10 + sum / (f1 - f0))
    }
  }
  return out
}

/** Correlation of two contours after taking each band's own mean off (all bands at once, one number). 0 when either is flat. */
export function contourCorrelation(a: Float64Array, b: Float64Array, bins = SAMPLE_BINS): number {
  const n = Math.min(a.length, b.length) / bins
  if (n < 1) return 0
  const x = new Float64Array(n * bins)
  const y = new Float64Array(n * bins)
  for (let band = 0; band < bins; band++) {
    let ma = 0
    let mb = 0
    for (let i = 0; i < n; i++) {
      ma += a[i * bins + band]
      mb += b[i * bins + band]
    }
    ma /= n
    mb /= n
    for (let i = 0; i < n; i++) {
      x[i * bins + band] = a[i * bins + band] - ma
      y[i * bins + band] = b[i * bins + band] - mb
    }
  }
  let xy = 0
  let xx = 0
  let yy = 0
  for (let i = 0; i < x.length; i++) {
    xy += x[i] * y[i]
    xx += x[i] * x[i]
    yy += y[i] * y[i]
  }
  const d = Math.sqrt(xx * yy)
  return d > 1e-9 ? xy / d : 0
}

export interface SampleCandidate {
  bars: number
  fromSec: number
  toSec: number
  /** −1…1; 1 = the next block repeats this one exactly. */
  score: number
}

/**
 * Every window of `bars` bars that starts on a yellow line and has a whole next block after it, scored against that next block; then the best
 * `limit` that do not overlap each other (greedy by score). A song with no usable grid has no candidates — the caller says so on screen.
 */
export function rankCandidates(frames: BandFrames, grid: BeatGrid | null, durationSec: number, bars: number, limit = 6): SampleCandidate[] {
  if (!usable(grid) || frames.frames === 0 || !(durationSec > 0) || bars < 1) return []
  const barSec = (60 / grid.bpm) * 4
  const stepSec = barSec / 16
  const blockSec = bars * barSec
  const all: SampleCandidate[] = []
  const firstBar = Math.max(0, Math.ceil((0 - grid.offsetSec) / barSec - 1e-9))
  for (let k = firstBar; ; k++) {
    const from = grid.offsetSec + k * barSec
    if (from + 2 * blockSec > durationSec + 1e-6) break
    const score = contourCorrelation(contour(frames, from, stepSec, bars * 16), contour(frames, from + blockSec, stepSec, bars * 16))
    all.push({ bars, fromSec: from, toSec: from + blockSec, score })
  }
  all.sort((p, q) => q.score - p.score)
  const picked: SampleCandidate[] = []
  for (const c of all) {
    if (picked.length >= limit) break
    if (picked.every((p) => c.toSec <= p.fromSec + 1e-6 || c.fromSec >= p.toSec - 1e-6)) picked.push(c)
  }
  return picked.sort((p, q) => p.fromSec - q.fromSec)
}

/** True when `candidate` overlaps at least `minShare` of one of his marks' length (or of its own length, whichever is shorter). */
export function overlapsMark(candidate: { fromSec: number; toSec: number }, regions: readonly SampleRegion[], minShare = 0.5): boolean {
  return regions.some((r) => {
    const common = Math.min(candidate.toSec, r.toSec) - Math.max(candidate.fromSec, r.fromSec)
    return common > 0 && common >= minShare * Math.min(candidate.toSec - candidate.fromSec, r.toSec - r.fromSec)
  })
}

// ───────────────────────── the file ─────────────────────────

export const SAMPLE_MARKS_KIND = 'sample-marks'

export function sampleMarksExportText(tags: readonly SampleMarkTag[], exportedAt: number): string {
  return JSON.stringify({ app: 'DeckMix', kind: SAMPLE_MARKS_KIND, schema: 1, exportedAt, marks: tags }, null, 2)
}
