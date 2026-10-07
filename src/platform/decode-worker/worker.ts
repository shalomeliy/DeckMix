/**
 * The decode Worker (v0.9.57): file bytes in, PCM at the AudioContext's rate out, the main thread never touching a sample. `self` is typed
 * through the DOM `Worker` interface for the reason given in analyzer-worker/worker.ts.
 */
import { decodeOffMain } from '@/platform/decode-worker/decode'
import type { DecodeRequest, DecodeResponse } from '@/platform/decode-worker/protocol'

declare const self: Worker

// One song at a time, in arrival order: the decoder instance is shared, and `reset()` between songs must not interleave.
let chain: Promise<void> = Promise.resolve()

self.onmessage = (e: MessageEvent<DecodeRequest>) => {
  const { id, bytes, format, targetRate } = e.data
  chain = chain.then(async () => {
    let response: DecodeResponse
    let transfer: Transferable[] = []
    try {
      const pcm = await decodeOffMain(new Uint8Array(bytes), format, targetRate)
      response = { id, ok: true, pcm }
      transfer = pcm.channels.map((c) => c.buffer)
    } catch (err) {
      response = { id, ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    // A throw here would be an unhandled rejection inside the Worker, which the page never hears about: the request would wait forever.
    try {
      self.postMessage(response, transfer)
    } catch (err) {
      self.postMessage({ id, ok: false, error: `could not send the result back: ${err instanceof Error ? err.message : String(err)}` })
    }
  })
}
