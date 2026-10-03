import type { PcmData } from '@/core/ports/analyzer'
import type { VocalResult } from '@/core/sound/vocal-timeline'

export interface VocalStripRequest {
  id: number
  pcm: PcmData
  genre: string
}

export type VocalStripResponse = { id: number; ok: true; result: VocalResult } | { id: number; ok: false; error: string }
