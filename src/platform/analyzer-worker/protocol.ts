/**
 * The message shape crossing the main-thread/Worker boundary. Kept in its own
 * file so `worker.ts` (runs inside the Worker) and `index.ts` (runs on the
 * main thread, owns the `Worker` instance) agree on it without either
 * importing the other.
 */
import type { PcmData, TrackAnalysis } from '@/core/ports/analyzer'

export interface AnalyzeRequest {
  id: number
  pcm: PcmData
  opts?: { minBpm?: number; maxBpm?: number; hintBpm?: number | null }
}

export type AnalyzeResponse =
  | { id: number; ok: true; analysis: TrackAnalysis }
  | { id: number; ok: false; error: string }
