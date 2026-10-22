/**
 * The owner's intro/outro marks (v0.9.40 experiment) on `idb-keyval`, one record per song keyed by CONTENT HASH, like the vocal and
 * sample marks, so a mark follows the file when it is renamed or moved. Never expired: it is the owner's own work.
 * Writes throw; the caller says on screen that it was not saved.
 */
import { get, getMany, keys, set } from 'idb-keyval'
import type { StructureMark } from '@/core/song-structure'

const PREFIX = 'deckmix:structureMarks:'

export async function getStructureMark(contentHash: string): Promise<StructureMark | null> {
  const t = await get<StructureMark>(PREFIX + contentHash)
  return t && t.schema === 1 ? t : null
}

export async function putStructureMark(mark: StructureMark): Promise<void> {
  await set(PREFIX + mark.contentHash, mark)
}

/** Every mark, for the queue, the count and the export. Throws on a blocked IndexedDB: an empty list would read as "nothing marked". */
export async function getAllStructureMarks(): Promise<StructureMark[]> {
  const all = (await keys()).filter((k): k is string => typeof k === 'string' && k.startsWith(PREFIX))
  return (await getMany<StructureMark>(all)).filter((t): t is StructureMark => !!t && t.schema === 1)
}
