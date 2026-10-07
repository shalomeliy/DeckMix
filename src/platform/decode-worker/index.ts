/**
 * Decode a song in a Worker (v0.9.57) — see `decode.ts` for why. `null` means "not a format this path takes" (the named set
 * `OFF_MAIN_FORMATS`) or no Worker in this browser: the caller uses `engine.decode`, as before. A real failure throws with the reason.
 */
import type { PcmData } from '@/core/ports/analyzer'
import { detectCapabilities } from '@/platform/capabilities'
import { OFF_MAIN_FORMATS, type OffMainFormat } from '@/platform/decode-worker/decode'
import type { DecodeRequest, DecodeResponse } from '@/platform/decode-worker/protocol'
// `?worker`, not `new Worker(new URL(...))` — see analyzer-worker/index.ts (tests/repo/worker-import-syntax.test.ts pins it).
import DecodeWorkerCtor from '@/platform/decode-worker/worker.ts?worker'

/**
 * Files above these sizes go down the old path, by name (`decodeInWorker` throws, and the library header counts them): minimp3's memory
 * only grows, and a 70-minute MP3 measured ~3.9 GB inside the Worker against ~1.6 GB the old way (review 07/10) — enough to kill the tab
 * rather than throw. 40 MB is ~17 minutes at 320 kbps, longer than any track in his library; a WAV needs no decoder memory.
 */
export const OFF_MAIN_MAX_BYTES: Record<OffMainFormat, number> = { mp3: 40 * 1024 * 1024, wav: 200 * 1024 * 1024 }

/** Longest a decode may take before it counts as stuck: generous (measured ~4.5 s for a 10 MB song), but never forever. */
function timeoutMs(bytes: number): number {
  return 60_000 + (bytes / (1024 * 1024)) * 5_000
}

let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, (r: DecodeResponse) => void>()

/**
 * Ends the Worker, answering anything still waiting with `error`. Also called whenever the line empties: the decoder's memory never
 * shrinks while the Worker lives, and a fresh one costs a 21 KB module.
 */
function retire(error: string | null) {
  if (error) for (const resolve of pending.values()) resolve({ id: -1, ok: false, error })
  pending.clear()
  worker?.terminate()
  worker = null
}

function getWorker(): Worker {
  if (!worker) {
    const w = new DecodeWorkerCtor()
    w.onmessage = (e: MessageEvent<DecodeResponse>) => {
      const resolve = pending.get(e.data.id)
      if (!resolve) return
      pending.delete(e.data.id)
      resolve(e.data)
      if (pending.size === 0 && worker === w) retire(null)
    }
    w.onerror = (e: ErrorEvent) => retire(e.message || 'decode worker error')
    w.onmessageerror = () => retire('the decode worker sent something unreadable')
    worker = w
  }
  return worker
}

/** The file's format by its name, if this path takes it. */
export function offMainFormat(fileName: string): OffMainFormat | null {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
  return (OFF_MAIN_FORMATS as readonly string[]).includes(ext) ? (ext as OffMainFormat) : null
}

/** Takes `bytes` over (transferred): do not read them afterwards. */
export async function decodeInWorker(bytes: ArrayBuffer, fileName: string, targetRate: number): Promise<PcmData | null> {
  const format = offMainFormat(fileName)
  if (!format || !detectCapabilities().webWorker) return null
  if (bytes.byteLength > OFF_MAIN_MAX_BYTES[format]) {
    throw new Error(`file is ${Math.round(bytes.byteLength / 1024 / 1024)} MB, over the background decoder's ${OFF_MAIN_MAX_BYTES[format] / 1024 / 1024} MB limit`)
  }
  const id = nextId++
  const w = getWorker()
  const limit = timeoutMs(bytes.byteLength)
  let timer: ReturnType<typeof setTimeout> | undefined
  const r = await new Promise<DecodeResponse>((resolve) => {
    pending.set(id, resolve)
    // A Worker killed for memory is not guaranteed to fire `onerror`; without this the pacer's slot would be held for good.
    timer = setTimeout(() => {
      if (pending.has(id)) retire(`no answer from the background decoder after ${Math.round(limit / 1000)} s`)
    }, limit)
    const req: DecodeRequest = { id, bytes, format, targetRate }
    w.postMessage(req, [bytes])
  })
  clearTimeout(timer)
  if (!r.ok) throw new Error(r.error)
  return r.pcm
}
