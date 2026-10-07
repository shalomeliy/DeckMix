import type { PcmData } from '@/core/ports/analyzer'
import type { OffMainFormat } from '@/platform/decode-worker/decode'

export interface DecodeRequest {
  id: number
  bytes: ArrayBuffer
  format: OffMainFormat
  targetRate: number
}

export type DecodeResponse = { id: number; ok: true; pcm: PcmData } | { id: number; ok: false; error: string }
