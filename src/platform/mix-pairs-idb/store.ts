/**
 * "This pair worked" memory (v0.8.14), keyed by the OUTGOING track's content
 * hash on `idb-keyval` — same one-record-per-track shape as `mix-ratings-idb`,
 * for the same reason: content hash travels with the file even after it
 * moves to a different library folder.
 *
 * Directional by design: a record under `fromHash` says "after this track,
 * `toHash` worked" — it says nothing about the reverse order. If B→A is
 * later also rated excellent, that is a separate record under `toHash`.
 *
 * `entrySec` is the raw candidate second `startAutoTransition` was called
 * with, *before* `phaseAlignedEntrySec` re-aligns it against wherever the
 * outgoing deck actually is when replayed — the same "store raw, re-align
 * live" split `activeTransition.exitPointSec` already uses.
 */
import { get, set } from 'idb-keyval'
import { addPairEntry, entriesOf, type PairEntry } from '@/core/pair-entries'

const KEY_PREFIX = 'deckmix:mixpairs:'

export interface ExcellentFollowUp {
  toHash: string
  entrySec: number
  /**
   * v0.8.16: where the OUTGOING deck actually was when this mix joined — the
   * second a replay waits for. Stored as-is, not re-aligned: it was already
   * a bar line at save time. Absent on every pair saved before v0.8.16; the
   * replay says so rather than guessing one.
   */
  exitSec?: number
  /**
   * v0.8.17: the follow-up's scan-relative path at rating time. A library
   * track's content hash is filled in lazily, so right after the folder is
   * opened the follow-up usually has none yet and a hash-only lookup can't
   * see it. The id lets the strip find it at once; the hash is still checked
   * after the load, so a different file at the same path is caught.
   */
  toTrackId?: string
  /**
   * v0.9.68: every excellent entry point of this pair. `entrySec`/`exitSec` above stay as the
   * latest one, so readers that know only one point keep working; absent on older records
   * (`entriesOf` reads those as a list of one).
   */
  entries?: PairEntry[]
}

/**
 * Never throws — a missing/blocked IndexedDB must not stop a track from
 * loading, only stop its remembered follow-ups from showing up.
 */
export async function getExcellentFollowUps(fromHash: string): Promise<ExcellentFollowUp[]> {
  try {
    return (await get<ExcellentFollowUp[]>(KEY_PREFIX + fromHash)) ?? []
  } catch {
    return []
  }
}

/**
 * Throws on failure, same choice `mix-ratings-idb`/`cues-idb` make — the one
 * call site (`controls.ts`'s rating handler) can surface it rather than an
 * "excellent" confirmation that silently didn't save. A later rating of the
 * same pair adds an entry (v0.9.68), unless it is within a few seconds of one already there, which it replaces.
 */
export async function markExcellentPair(
  fromHash: string,
  toHash: string,
  entrySec: number,
  exitSec: number,
  toTrackId: string | undefined,
): Promise<{ dropped: boolean }> {
  const existing = await getExcellentFollowUps(fromHash)
  const before = existing.find((p) => p.toHash === toHash)
  const withoutThisPair = existing.filter((p) => p.toHash !== toHash)
  const { entries, dropped } = addPairEntry(before ? entriesOf(before) : [], { entrySec, exitSec, at: Date.now() })
  await set(KEY_PREFIX + fromHash, [...withoutThisPair, { toHash, entrySec, exitSec, toTrackId, entries }])
  return { dropped }
}
