/**
 * The owner's tags (v0.9.0), one record per track per kind, keyed by content
 * hash on `idb-keyval` — the same shape as `grid-corrections-idb`. Apart from
 * the grid corrections on purpose: a correction is what the deck plays, a tag
 * is the answer the detector is graded against, and it also records what the
 * detector said at the time, which a correction does not.
 */
import { getMany, keys, set } from 'idb-keyval'
import type { BarTag, MarkTag, VocalReviewTag, VocalTag } from '@/core/tagging'

const BAR_PREFIX = 'deckmix:tag:bar:'
const VOCAL_PREFIX = 'deckmix:tag:vocal:'
/** v0.9.11's blind re-check of already-answered clips. NOT under VOCAL_PREFIX: `startsWith` would otherwise read these as first-pass answers, and the key would overwrite them. */
const VOCAL_REVIEW_PREFIX = 'deckmix:tag:vocalreview:'
/** v0.9.1's waveform-marker tags. Their own prefix, so re-tagging a song never overwrites its v0.9.0 answer — the two are compared. */
const MARK_PREFIX = 'deckmix:tag:mark:'
/** v0.12.8's blind tie-break on the songs whose two answers disagree. Its own prefix, so the two it settles stay as they were. */
const DECIDE_PREFIX = 'deckmix:tag:decide:'
/** v0.9.5's round on songs no detector was ever tuned on — the fair test. Its own prefix so it can never be mistaken for the 105 it is compared against. */
const FRESH_PREFIX = 'deckmix:tag:fresh:'

export interface AllTags {
  bar: BarTag[]
  mark: MarkTag[]
  decide: MarkTag[]
  fresh: MarkTag[]
  vocal: VocalTag[]
  vocalReview: VocalReviewTag[]
}

/** Throws on failure, like `putGridCorrection` — the caller says so on screen. */
export async function putMarkTag(tag: MarkTag): Promise<void> {
  await set(MARK_PREFIX + tag.contentHash, tag)
}

export async function putDecideTag(tag: MarkTag): Promise<void> {
  await set(DECIDE_PREFIX + tag.contentHash, tag)
}

export async function putFreshTag(tag: MarkTag): Promise<void> {
  await set(FRESH_PREFIX + tag.contentHash, tag)
}

export async function putVocalTag(tag: VocalTag): Promise<void> {
  // one record per clip: three per song (v0.9.10)
  await set(`${VOCAL_PREFIX}${tag.contentHash}:${tag.clipIndex}`, tag)
}

export async function putVocalReviewTag(tag: VocalReviewTag): Promise<void> {
  await set(`${VOCAL_REVIEW_PREFIX}${tag.contentHash}:${tag.clipIndex}`, tag)
}

/** Every stored tag. Throws on a blocked IndexedDB: an empty list there would read as "nothing tagged yet". */
export async function getAllTags(): Promise<AllTags> {
  // Keys first, then only the tag values: this store is shared with the
  // analysis cache and the sampler's recorded audio, and reading every value
  // after each answer would pull all of it into memory (v0.9.0 review).
  const all = (await keys()).filter((k): k is string => typeof k === 'string')
  const barKeys = all.filter((k) => k.startsWith(BAR_PREFIX))
  const markKeys = all.filter((k) => k.startsWith(MARK_PREFIX))
  const decideKeys = all.filter((k) => k.startsWith(DECIDE_PREFIX))
  const freshKeys = all.filter((k) => k.startsWith(FRESH_PREFIX))
  const vocalKeys = all.filter((k) => k.startsWith(VOCAL_PREFIX))
  const reviewKeys = all.filter((k) => k.startsWith(VOCAL_REVIEW_PREFIX))
  const [bar, mark, decide, fresh, vocal, vocalReview] = await Promise.all([
    getMany<BarTag>(barKeys),
    getMany<MarkTag>(markKeys),
    getMany<MarkTag>(decideKeys),
    getMany<MarkTag>(freshKeys),
    getMany<VocalTag>(vocalKeys),
    getMany<VocalReviewTag>(reviewKeys),
  ])
  // A key deleted between the two reads comes back undefined — not a tag.
  return {
    bar: bar.filter((t): t is BarTag => t != null),
    mark: mark.filter((t): t is MarkTag => t != null),
    decide: decide.filter((t): t is MarkTag => t != null),
    fresh: fresh.filter((t): t is MarkTag => t != null),
    vocal: vocal.filter((t): t is VocalTag => t != null),
    vocalReview: vocalReview.filter((t): t is VocalReviewTag => t != null),
  }
}
