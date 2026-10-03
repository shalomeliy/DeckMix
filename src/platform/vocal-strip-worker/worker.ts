/**
 * The vocal strip's analysis (v0.9.10b) in its own Worker, apart from the BPM/key one: it costs 3–6 s per track (v0.9.10 measured a median 2.8 s,
 * worst 6.3 s on 5 minutes) and must never queue behind, or hold up, the analysis the library rows are waiting on. `self` is typed through the DOM
 * `Worker` interface for the reason given in analyzer-worker/worker.ts.
 */
import modelJson from '@/core/sound/vocal-model.json'
import { parseVocalModel } from '@/core/sound/vocal-model'
import { detectVocalStrip } from '@/core/sound/vocal-strip'
import type { VocalStripRequest, VocalStripResponse } from '@/platform/vocal-strip-worker/protocol'

declare const self: Worker

const model = parseVocalModel(modelJson)

self.onmessage = (e: MessageEvent<VocalStripRequest>) => {
  const { id, pcm, genre } = e.data
  let response: VocalStripResponse
  let transfer: Transferable[] = []
  try {
    const result = detectVocalStrip(pcm, genre, model)
    response = { id, ok: true, result }
    if (result.timeline) transfer = [result.timeline.cells.buffer]
  } catch (err) {
    response = { id, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  self.postMessage(response, transfer)
}
