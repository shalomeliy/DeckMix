/**
 * Pure ranking math for v0.8.5's "more like this" — no IO, no model, no
 * cache. `rankBySimilarity` is cosine-only for now (`workshop-output/PLAN.md`
 * §3): hybrid blending against BPM/genre is deferred until there is a real
 * result set to check it against, not added speculatively.
 */
import { rowBpm } from '@/core/constants'
import type { Track } from '@/core/types'

/** `NaN` on a zero vector is deliberate — a zero embedding is not "unrelated" (0), it's undefined, and callers must not silently rank it as a mediocre match. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch (${a.length} vs ${b.length}) — embeddings from different models are not comparable`)
  }
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export interface SimilarityCandidate {
  contentHash: string
  embedding: Float32Array
  bpm: number | null
  genre: string | null
}

export interface SimilarityMatch {
  contentHash: string
  score: number
}

const DEFAULT_LIMIT = 10

/** Ranks `candidates` by cosine similarity to `seed`, highest first. Throws if any candidate's embedding length disagrees with the seed's — see `cosineSimilarity`. */
export function rankBySimilarity(
  seed: SimilarityCandidate,
  candidates: SimilarityCandidate[],
  opts: { limit?: number } = {},
): SimilarityMatch[] {
  const limit = opts.limit ?? DEFAULT_LIMIT
  return candidates
    .filter((c) => c.contentHash !== seed.contentHash)
    .map((c) => ({ contentHash: c.contentHash, score: cosineSimilarity(seed.embedding, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export interface TrackSimilarityMatch {
  id: string
  score: number
}

/** Same tempo range Mix Assist uses in spirit: a DJ can beatmatch within ~8%, or ride half/double time. */
const BPM_TOLERANCE = 0.08

/**
 * Tempo-compatible: within ±8% of the seed, or of its half/double time.
 * Cosine on averaged MFCC/chroma measures timbre only (real library, 20/09:
 * a 97 BPM Hip Hop seed returned Techno at 122-173 BPM — 2/10 matched the
 * v0.8.5 criterion), so tempo has to be a hard gate, not a tiebreak.
 */
export function bpmCompatible(seedBpm: number, candidateBpm: number): boolean {
  return [1, 2, 0.5].some((m) => Math.abs(candidateBpm / (seedBpm * m) - 1) <= BPM_TOLERANCE)
}

/**
 * `rankBySimilarity` adapted to `Library.tsx`'s actual keys (M3) — rows are
 * addressed by `Track.id`, not `contentHash` (two rows can share a hash if
 * the same file exists at two paths in the library). Returns `[]` — never
 * throws, never a guess — when the seed itself isn't found or has no
 * embedding yet, matching every other "not ready" state in this project
 * (a disabled button, not a crash).
 *
 * Similar = tempo + genre + sound (Shalom, 20/09): candidates outside the
 * seed's tempo range are dropped (a candidate with no BPM can't be shown to
 * match, so it is dropped too — the chip says so); same-genre tracks come
 * first; sound (cosine) orders within each group. A seed with no BPM applies
 * no tempo gate — the chip shows no BPM in that case, so it isn't hidden.
 */
export function findSimilarTracks(seedId: string, tracks: Track[], opts: { limit?: number } = {}): TrackSimilarityMatch[] {
  const seedTrack = tracks.find((t) => t.id === seedId)
  if (!seedTrack?.embedding || !seedTrack.contentHash) return []

  // v0.9.47: the BPM the row shows (a saved speed included), so the ±8% gate and the chip agree with the column
  const seedBpm = rowBpm(seedTrack) ?? null
  const idByHash = new Map<string, string>()
  const genreByHash = new Map<string, string | null>()
  const candidates: SimilarityCandidate[] = []
  for (const t of tracks) {
    if (!t.embedding || !t.contentHash) continue
    if (seedBpm != null && t.contentHash !== seedTrack.contentHash && (rowBpm(t) == null || !bpmCompatible(seedBpm, rowBpm(t)!))) continue
    if (!idByHash.has(t.contentHash)) idByHash.set(t.contentHash, t.id)
    genreByHash.set(t.contentHash, t.genre ?? null)
    candidates.push({ contentHash: t.contentHash, embedding: t.embedding, bpm: rowBpm(t) ?? null, genre: t.genre ?? null })
  }

  const seed: SimilarityCandidate = {
    contentHash: seedTrack.contentHash,
    embedding: seedTrack.embedding,
    bpm: seedBpm,
    genre: seedTrack.genre ?? null,
  }
  const seedGenre = seedTrack.genre ?? null
  const sameGenre = (hash: string) => seedGenre != null && genreByHash.get(hash) === seedGenre

  return rankBySimilarity(seed, candidates, { limit: Infinity })
    .sort((a, b) => Number(sameGenre(b.contentHash)) - Number(sameGenre(a.contentHash)) || b.score - a.score)
    .slice(0, opts.limit ?? DEFAULT_LIMIT)
    .map((m) => ({ id: idByHash.get(m.contentHash) ?? m.contentHash, score: m.score }))
}

/**
 * The table's rows for a "more like this" view: only the matches, **in
 * `findSimilarTracks`'s order**. `Library.tsx` used to re-sort these by raw
 * cosine score, which threw away the genre-first ordering above — a Trance
 * seed (23/09, Shalom's library) showed a genre-less track and two Hip Hop
 * tracks above its seven Trance matches. Rank position is the order, never
 * the score.
 */
export function orderBySimilarMatches<T extends { id: string }>(rows: T[], matches: TrackSimilarityMatch[]): T[] {
  const rank = new Map(matches.map((m, i) => [m.id, i]))
  return rows.filter((r) => rank.has(r.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
}
