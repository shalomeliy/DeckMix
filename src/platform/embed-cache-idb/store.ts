/**
 * `EmbeddingCache` on `idb-keyval` (v0.8.5) — structurally mirrors
 * `analyze-cache-idb/store.ts`, but keyed by `(modelId, contentHash)` rather
 * than `contentHash` alone: a model swap (e.g. classical → CLAP, v0.20.0-style)
 * is a whole new key namespace, not a value to invalidate in place, so old
 * vectors are left exactly as they are — `workshop-output/FEATURE_SPEC.md`
 * decision 3 (silent background re-embedding, no blanket invalidation).
 */
import { get, set } from 'idb-keyval'
import { resolveEmbeddingEntry, type StoredEmbeddingEntry } from '@/core/embedding-cache'
import type { EmbeddingCache } from '@/core/ports/embedder'
import { EMBEDDER_VERSION } from '@/platform/embed-cache-idb/version'

const KEY_PREFIX = 'deckmix:embeddingCache:'

function keyFor(modelId: string, contentHash: string): string {
  return `${KEY_PREFIX}${modelId}:${contentHash}`
}

class IdbEmbeddingCache implements EmbeddingCache {
  async get(contentHash: string, modelId: string): Promise<Float32Array | null> {
    let stored: StoredEmbeddingEntry | undefined
    try {
      stored = await get<StoredEmbeddingEntry>(keyFor(modelId, contentHash))
    } catch {
      // IndexedDB unavailable (private window, blocked storage) — the track
      // re-embeds this session, same degrade every other IDB-backed store in
      // this app already falls back to (`analyze-cache-idb/store.ts`).
      return null
    }
    return resolveEmbeddingEntry(stored, modelId, EMBEDDER_VERSION)
  }

  async put(contentHash: string, modelId: string, vector: Float32Array): Promise<void> {
    const entry: StoredEmbeddingEntry = {
      contentHash,
      modelId,
      embedderVersion: EMBEDDER_VERSION,
      vector,
      cachedAt: Date.now(),
    }
    await set(keyFor(modelId, contentHash), entry)
  }
}

export const embeddingCache: EmbeddingCache = new IdbEmbeddingCache()
