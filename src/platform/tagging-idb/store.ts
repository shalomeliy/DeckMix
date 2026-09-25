/**
 * The owner's tags (v0.9.0), one record per track per kind, keyed by content
 * hash on `idb-keyval` — the same shape as `grid-corrections-idb`. Apart from
 * the grid corrections on purpose: a correction is what the deck plays, a tag
 * is the answer the detector is graded against, and it also records what the
 * detector said at the time, which a correction does not.
 */
import { getMany, keys, set } from 'idb-keyval'
import type { BarTag, VocalTag } from '@/core/tagging'

const BAR_PREFIX = 'deckmix:tag:bar:'
const VOCAL_PREFIX = 'deckmix:tag:vocal:'

/** Throws on failure, like `putGridCorrection` — the caller says so on screen. */
export async function putBarTag(tag: BarTag): Promise<void> {
  await set(BAR_PREFIX + tag.contentHash, tag)
}

export async function putVocalTag(tag: VocalTag): Promise<void> {
  await set(VOCAL_PREFIX + tag.contentHash, tag)
}

/** Every stored tag. Throws on a blocked IndexedDB: an empty list there would read as "nothing tagged yet". */
export async function getAllTags(): Promise<{ bar: BarTag[]; vocal: VocalTag[] }> {
  // Keys first, then only the tag values: this store is shared with the
  // analysis cache and the sampler's recorded audio, and reading every value
  // after each answer would pull all of it into memory (v0.9.0 review).
  const all = (await keys()).filter((k): k is string => typeof k === 'string')
  const barKeys = all.filter((k) => k.startsWith(BAR_PREFIX))
  const vocalKeys = all.filter((k) => k.startsWith(VOCAL_PREFIX))
  const [bar, vocal] = await Promise.all([getMany<BarTag>(barKeys), getMany<VocalTag>(vocalKeys)])
  // A key deleted between the two reads comes back undefined — not a tag.
  return { bar: bar.filter((t): t is BarTag => t != null), vocal: vocal.filter((t): t is VocalTag => t != null) }
}
