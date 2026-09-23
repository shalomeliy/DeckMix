/**
 * The pure feature-extraction step behind `platform/embed-classical/index.ts`
 * (v0.8.5). Kept separate from the Worker wrapper so the math itself is
 * unit-tested with synthetic PCM, no Worker or IndexedDB involved — same
 * split as `analyzer-js/analyze.ts` vs `analyzer-worker/`.
 *
 * `meyda` (MIT — checked before adopting it, after `essentia.js` turned out
 * to be AGPL-3.0 and had to be reverted; see `workshop-output/PLAN.md`)
 * extracts MFCC/chroma per fixed-size frame, not per track — `Meyda.extract`
 * takes one buffer of exactly `Meyda.bufferSize` samples. A whole track is
 * many overlapping frames; this averages MFCC and chroma across all of them
 * into one fixed-length vector, the simplest defensible track-level summary
 * and the one to measure before trying anything fancier.
 *
 * Channels are downmixed into each frame in place (`mixFrame`), not by
 * flattening the whole track to mono first — `analyzer-js/analyze.ts`'s
 * `WaveformAnalysis` doc comment already measured what that costs on a long
 * stereo track (tens of MB) and avoided it for the same reason.
 */
import Meyda from 'meyda'
import type { PcmData } from '@/core/ports/analyzer'

const FRAME_SIZE = 2048
const HOP_SIZE = 1024
const MFCC_COEFFICIENTS = 13
const CHROMA_BANDS = 12
export const CLASSICAL_EMBEDDING_LENGTH = MFCC_COEFFICIENTS + CHROMA_BANDS

interface MeydaFrameFeatures {
  mfcc: number[]
  chroma: number[]
}

function mixFrame(chans: Float32Array[], start: number, size: number, out: Float32Array): void {
  const invCh = 1 / chans.length
  for (let i = 0; i < size; i++) {
    let v = 0
    for (let c = 0; c < chans.length; c++) v += chans[c][start + i]
    out[i] = v * invCh
  }
}

/** Throws on a track too short for even one frame — the caller (the embedding cache path) treats that as a failure, same as any other analysis error. */
export async function computeClassicalEmbedding(pcm: PcmData): Promise<Float32Array> {
  const length = pcm.channels[0].length
  if (length < FRAME_SIZE) {
    throw new Error(`computeClassicalEmbedding: track too short (${length} samples, need at least ${FRAME_SIZE})`)
  }

  // Meyda's parameters live on its default-exported singleton, not a
  // per-call option (its own docs call this out as an API wart) — safe here
  // because this Worker processes one track at a time, never concurrently.
  Meyda.bufferSize = FRAME_SIZE
  Meyda.sampleRate = pcm.sampleRate
  Meyda.numberOfMFCCCoefficients = MFCC_COEFFICIENTS
  Meyda.chromaBands = CHROMA_BANDS

  const mfccSum = new Float64Array(MFCC_COEFFICIENTS)
  const chromaSum = new Float64Array(CHROMA_BANDS)
  const frame = new Float32Array(FRAME_SIZE)
  let frameCount = 0

  for (let start = 0; start + FRAME_SIZE <= length; start += HOP_SIZE) {
    mixFrame(pcm.channels, start, FRAME_SIZE, frame)
    const features = Meyda.extract(['mfcc', 'chroma'], frame) as MeydaFrameFeatures | null
    if (!features) continue
    for (let i = 0; i < MFCC_COEFFICIENTS; i++) mfccSum[i] += features.mfcc[i]
    for (let i = 0; i < CHROMA_BANDS; i++) chromaSum[i] += features.chroma[i]
    frameCount++
  }

  if (frameCount === 0) {
    throw new Error('computeClassicalEmbedding: no frames extracted')
  }

  const vector = new Float32Array(CLASSICAL_EMBEDDING_LENGTH)
  for (let i = 0; i < MFCC_COEFFICIENTS; i++) vector[i] = mfccSum[i] / frameCount
  for (let i = 0; i < CHROMA_BANDS; i++) vector[MFCC_COEFFICIENTS + i] = chromaSum[i] / frameCount
  // An all-zero or non-finite vector is not a fingerprint. Cosine on it is
  // NaN, and every comparison silently becomes "no answer". Silent PCM is
  // what a detached AudioBuffer reads as (see `pcmCopyFromAudioBuffer`), so
  // it fails loudly here and the track shows as a failed embedding, not a
  // "done" one that matches nothing.
  if (vector.every((v) => v === 0) || vector.some((v) => !Number.isFinite(v))) {
    throw new Error('computeClassicalEmbedding: no usable signal (silent or unreadable audio)')
  }
  return vector
}
