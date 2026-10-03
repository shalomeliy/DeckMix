/**
 * The owner's hand-made vocal marks (v0.9.10b) on `idb-keyval`, one record per song, keyed by CONTENT HASH — the same identity the genre edits
 * and cue points use — so a mark follows the file when it is renamed or moved, and is kept for good. Never overwritten by the model's strip
 * (that is cached under its own prefix) and never expired: it is the owner's own work.
 * Writes throw; the caller says on screen that it was not saved.
 */
import { del, get, keys, getMany, set } from 'idb-keyval'
import type { VocalManualTag } from '@/core/sound/vocal-manual'

const PREFIX = 'deckmix:vocalManual:'

export async function getVocalManual(contentHash: string): Promise<VocalManualTag | null> {
  const t = await get<VocalManualTag>(PREFIX + contentHash)
  return t && t.schema === 1 && Array.isArray(t.regions) ? t : null
}

export async function putVocalManual(tag: VocalManualTag): Promise<void> {
  await set(PREFIX + tag.contentHash, tag)
}

export async function deleteVocalManual(contentHash: string): Promise<void> {
  await del(PREFIX + contentHash)
}

/** Every mark, for an export or a count. Throws on a blocked IndexedDB: an empty list would read as "nothing marked". */
export async function getAllVocalManual(): Promise<VocalManualTag[]> {
  const all = (await keys()).filter((k): k is string => typeof k === 'string' && k.startsWith(PREFIX))
  return (await getMany<VocalManualTag>(all)).filter((t): t is VocalManualTag => !!t && t.schema === 1)
}
