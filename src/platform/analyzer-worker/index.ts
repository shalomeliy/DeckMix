/**
 * `core/ports/analyzer.ts`'s `Analyzer`, backed by a Web Worker where
 * `capabilities.webWorker` allows it, falling back to calling `analyzeTrack`
 * directly on the main thread otherwise — same public API either way, no
 * caller ever branches on which path ran. Single track in, single result
 * out; the concurrency-limited batch queue for scanning a whole folder is a
 * separate concern built on top of this, not inside it (v0.4.0, background
 * analysis step).
 */
import { analyzeTrack } from '@/platform/analyzer-js/analyze'
import { detectCapabilities } from '@/platform/capabilities'
import type { Analyzer, PcmData, TrackAnalysis } from '@/core/ports/analyzer'
import type { AnalyzeRequest, AnalyzeResponse } from '@/platform/analyzer-worker/protocol'
// `?worker`, not `new Worker(new URL(...))` — the latter only gets Vite 8
// to copy the raw, untranspiled `.ts` source as a generic asset (works by
// accident under `npm run dev`, where Vite serves and transpiles anything
// on request; silently non-functional in a real `vite build`, where the
// browser gets handed unparseable TypeScript and `worker.onerror` fires
// with no useful reason). Found and fixed in v0.5.5 while building
// `platform/ai-local/`'s own worker the same wrong way and catching it
// against `vite build`, not `npm run dev` — see `HANDOFF.md`.
// `tests/repo/worker-import-syntax.test.ts` pins the fix.
import AnalyzerWorkerCtor from '@/platform/analyzer-worker/worker.ts?worker'

let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, (response: AnalyzeResponse) => void>()

function getWorker(): Worker {
  if (!worker) {
    worker = new AnalyzerWorkerCtor()
    worker.onmessage = (e: MessageEvent<AnalyzeResponse>) => {
      const resolve = pending.get(e.data.id)
      if (!resolve) return // already settled by onerror, or a stale response — ignore, don't throw
      pending.delete(e.data.id)
      resolve(e.data)
    }
    // A worker-level failure (e.g. a syntax error in the bundle, not caught by
    // worker.ts's own try/catch) has no `id` to route back to one caller —
    // every request still waiting is rejected so nothing hangs forever.
    worker.onerror = (e: ErrorEvent) => {
      const message = e.message || 'worker error'
      for (const resolve of pending.values()) resolve({ id: -1, ok: false, error: message })
      pending.clear()
    }
  }
  return worker
}

function analyzeInWorker(pcm: PcmData, opts?: { minBpm?: number; maxBpm?: number; hintBpm?: number | null }): Promise<AnalyzeResponse> {
  const id = nextId++
  const w = getWorker()
  return new Promise((resolve) => {
    pending.set(id, resolve)
    const req: AnalyzeRequest = { id, pcm, opts }
    // Channel data is transferred, not copied — zero-cost for what can be a
    // many-MB array. Safe here because nothing else still needs to read
    // `pcm.channels` after this call: the caller either already extracted
    // what it needs (duration, etc.) or is calling this specifically to hand
    // analysis off. Do not reuse a `PcmData` after passing it here.
    const transfer = pcm.channels.map((c) => c.buffer)
    w.postMessage(req, transfer)
  })
}

/**
 * Analyze one track's PCM. Dispatches to the Worker when available; on any
 * Worker-path failure (unsupported, or the analysis itself threw inside the
 * Worker) falls back to the main thread rather than leaving the caller with
 * nothing — a track that fails to analyze should say so through the normal
 * `analysisState: 'failed'` path (wired in a later step), not through this
 * function throwing in a way that looks like a bug in the fallback itself.
 */
export const analyzerWorker: Analyzer = {
  async analyze(pcm: PcmData, opts?: { minBpm?: number; maxBpm?: number; hintBpm?: number | null }): Promise<TrackAnalysis> {
    if (!detectCapabilities().webWorker) {
      return analyzeTrack(pcm, opts)
    }
    const response = await analyzeInWorker(pcm, opts)
    if (response.ok) return response.analysis
    // The Worker itself is fine; this one track's analysis threw inside it
    // (decode-adjacent errors don't apply here since decode never happens in
    // the Worker — this would be a bug in analyzeTrack surfacing either way).
    // Re-throwing lets the caller's existing try/catch (loadTrackToDeck,
    // the background queue) handle it exactly like any other analysis
    // failure, instead of silently degrading to a different code path here.
    throw new Error(response.error)
  },
}
