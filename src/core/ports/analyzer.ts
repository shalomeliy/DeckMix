/**
 * Track analysis. v0.4.0: decode stays main-thread (a spike found neither
 * `OfflineAudioContext` nor `AudioBuffer` exists inside a Worker in this app's
 * target Chromium — see `workshop-output/PLAN.md`), so `Analyzer.analyze`
 * takes already-decoded PCM, not raw file bytes. `platform/analyzer-worker`
 * dispatches the numeric work (peaks/bands/beatgrid) to a Web Worker where
 * supported, falling back to the main thread via `capabilities.webWorker`.
 * WASM/WebGPU or a remote service can still replace this without any caller
 * changing, since none of them care how `analyze` gets its answer either.
 */
import type { BeatGrid } from '@/core/types'
import type { DetectedKey } from '@/core/key-detect'

/** One `Float32Array` per channel, all the same length — a decoded track's samples. */
export interface PcmData {
  channels: Float32Array[]
  sampleRate: number
}

export interface WaveformData {
  /** interleaved [min, max] per bucket */
  peaks: Float32Array
  /** low/mid/high RMS per bucket */
  bands: Float32Array
}

export interface TrackAnalysis extends WaveformData {
  bpm: number | null
  durationSec: number
  /** `null` only when the track is too short for autocorrelation to say anything at all. */
  beatGrid: BeatGrid | null
  /** whether `beatGrid` looks like a real periodicity, not a guess — see `core/beatgrid.ts`. */
  beatGridConfirmed: boolean
  /** From the audio itself (v0.8.27, `core/key-detect.ts`). `null` = the chroma picked nothing (silence, noise) — shown as no key, never a guess. */
  key: DetectedKey | null
}

export interface Analyzer {
  analyze(pcm: PcmData, opts?: { minBpm?: number; maxBpm?: number; hintBpm?: number | null }): Promise<TrackAnalysis>
}

/** Analysis is expensive and deterministic — v0.4.0 keys this by file content hash. */
export interface AnalysisCache {
  get(key: string): Promise<TrackAnalysis | null>
  put(key: string, value: TrackAnalysis): Promise<void>
}
