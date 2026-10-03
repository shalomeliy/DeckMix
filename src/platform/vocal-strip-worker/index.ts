/**
 * Runs `detectVocalStrip` in a Worker where `capabilities.webWorker` allows, on the main thread otherwise — same answer either way.
 * A Worker-level failure is returned as a named `failed` result for that track (shown on screen), never thrown into the queue and never retried silently.
 */
import modelJson from '@/core/sound/vocal-model.json'
import { parseVocalModel } from '@/core/sound/vocal-model'
import { detectVocalStrip } from '@/core/sound/vocal-strip'
import type { PcmData } from '@/core/ports/analyzer'
import type { VocalResult } from '@/core/sound/vocal-timeline'
import { detectCapabilities } from '@/platform/capabilities'
import type { VocalStripRequest, VocalStripResponse } from '@/platform/vocal-strip-worker/protocol'
// `?worker`, not `new Worker(new URL(...))` — see analyzer-worker/index.ts (tests/repo/worker-import-syntax.test.ts pins it).
import VocalStripWorkerCtor from '@/platform/vocal-strip-worker/worker.ts?worker'

let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, (r: VocalStripResponse) => void>()

function getWorker(): Worker {
  if (!worker) {
    worker = new VocalStripWorkerCtor()
    worker.onmessage = (e: MessageEvent<VocalStripResponse>) => {
      const resolve = pending.get(e.data.id)
      if (!resolve) return
      pending.delete(e.data.id)
      resolve(e.data)
    }
    worker.onerror = (e: ErrorEvent) => {
      for (const resolve of pending.values()) resolve({ id: -1, ok: false, error: e.message || 'worker error' })
      pending.clear()
    }
  }
  return worker
}

/** Takes the PCM over (its buffers are transferred): do not read it afterwards. */
export async function analyseVocalStrip(pcm: PcmData, genre: string): Promise<VocalResult> {
  if (!detectCapabilities().webWorker) return detectVocalStrip(pcm, genre, parseVocalModel(modelJson))
  const id = nextId++
  const w = getWorker()
  const response = await new Promise<VocalStripResponse>((resolve) => {
    pending.set(id, resolve)
    const req: VocalStripRequest = { id, pcm, genre }
    w.postMessage(req, pcm.channels.map((c) => c.buffer))
  })
  return response.ok ? response.result : { state: 'failed', timeline: null, note: response.error }
}
