/**
 * The owner's hand-made sample marks (v0.9.30 stage 1 experiment) on `idb-keyval`, one record per song keyed by CONTENT HASH — the identity the
 * vocal marks and cue points use — so a mark follows the file when it is renamed or moved. Never expired: it is the owner's own work.
 * Writes throw; the caller says on screen that it was not saved.
 */
import { del, get, getMany, keys, set } from 'idb-keyval'
import type { SampleMarkTag } from '@/core/sound/sample-marks'

const PREFIX = 'deckmix:sampleMarks:'

export async function getSampleMarks(contentHash: string): Promise<SampleMarkTag | null> {
  const t = await get<SampleMarkTag>(PREFIX + contentHash)
  return t && t.schema === 1 && Array.isArray(t.regions) ? t : null
}

export async function putSampleMarks(tag: SampleMarkTag): Promise<void> {
  await set(PREFIX + tag.contentHash, tag)
}

export async function deleteSampleMarks(contentHash: string): Promise<void> {
  await del(PREFIX + contentHash)
}

/** Every mark, for an export or a count. Throws on a blocked IndexedDB: an empty list would read as "nothing marked". */
export async function getAllSampleMarks(): Promise<SampleMarkTag[]> {
  const all = (await keys()).filter((k): k is string => typeof k === 'string' && k.startsWith(PREFIX))
  return (await getMany<SampleMarkTag>(all)).filter((t): t is SampleMarkTag => !!t && t.schema === 1)
}
