/**
 * "This mix was bad" memory (v0.12.14), keyed by the OUTGOING track's content hash on `idb-keyval`, same one-record-per-track shape and
 * same reason as `mix-pairs-idb`: the hash travels with the file. Directional too: bad after A says nothing about the reverse order.
 * The v0.5.4 note in `mix-ratings-idb` that nothing reads a negative rating is no longer true; this is the reader.
 */
import { get, set } from 'idb-keyval'
import { addBadEntry, type BadEntry } from '@/core/bad-mixes'

const KEY_PREFIX = 'deckmix:mixbad:'

interface BadFollowUp {
  toHash: string
  entries: BadEntry[]
}

async function readAll(fromHash: string): Promise<BadFollowUp[]> {
  const v = await get<BadFollowUp[]>(KEY_PREFIX + fromHash)
  return Array.isArray(v) ? v : []
}

/** Never throws, like the other per-track reads: a blocked IndexedDB only means nothing is hidden. */
export async function getBadEntries(fromHash: string, toHash: string): Promise<BadEntry[]> {
  try {
    return (await readAll(fromHash)).find((f) => f.toHash === toHash)?.entries ?? []
  } catch {
    return []
  }
}

/** Throws on failure so the rating handler can say the rating was not saved. */
export async function markBadMix(fromHash: string, toHash: string, entrySec: number): Promise<void> {
  const all = await readAll(fromHash)
  const before = all.find((f) => f.toHash === toHash)?.entries ?? []
  const rest = all.filter((f) => f.toHash !== toHash)
  await set(KEY_PREFIX + fromHash, [...rest, { toHash, entries: addBadEntry(before, { entrySec, at: Date.now() }) }])
}

/** The panel's "show again": forgets every Bad rating of this pair. Throws on failure. */
export async function clearBadMixes(fromHash: string, toHash: string): Promise<void> {
  const all = await readAll(fromHash)
  await set(KEY_PREFIX + fromHash, all.filter((f) => f.toHash !== toHash))
}
