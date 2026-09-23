/**
 * Bumps when the *extraction logic* for a given `modelId` changes meaningfully
 * (e.g. `embed-classical/analyze.ts`'s frame size, hop size, or coefficient
 * count changes) — not when the model itself changes, which is what
 * `modelId` already distinguishes. Mirrors `analyze-cache-idb/version.ts`'s
 * `ANALYZER_VERSION` reasoning: a stale entry is a silent-skip risk, so this
 * is a deliberate manual step, named here.
 */
// 2 (23/09): version 1's cache holds all-zero vectors written by the
// transfer-before-copy bug in `queueLibraryAnalysis`. The extraction logic is
// unchanged, but those entries have to become misses so they re-embed.
export const EMBEDDER_VERSION = 2
