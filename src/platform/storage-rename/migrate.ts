/**
 * Moves every `soundgrid:` entry to its `deckmix:` name (v0.8.20). See
 * `core/storage-rename.ts` for why. `main.tsx` runs this before importing the
 * app, because stores read their keys the moment their modules load
 * (`boot-latency.ts` for one), and a read that lands before the move finds
 * nothing.
 *
 * Order matters: copy first, delete only what was copied. When the new key is
 * already filled, the new one wins and the old one is **kept**, not deleted.
 * A half-finished earlier move leaves an identical copy there, and that is
 * harmless. But a tab from before the rename, left open, could have kept
 * writing the old key after another tab moved it. Deleting that copy would
 * throw away the owner's newer edit without a word. Each copy is a single
 * `update()` transaction, so a second tab starting at the same moment cannot
 * write over a value the first one has already saved.
 */
import { del, getMany, keys, update } from 'idb-keyval'
import { renamedKey, type StorageMoveResult } from '@/core/storage-rename'

/** Recordings and embedding caches are large, so they move in batches, not all at once. */
const BATCH = 25

function moveLocalStorage(result: StorageMoveResult): void {
  let names: string[]
  try {
    names = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(
      (k): k is string => renamedKey(k) !== null,
    )
  } catch {
    // Blocked storage throws on access, and then there is nothing to move and
    // nothing any other part of the app can read either.
    return
  }
  for (const oldKey of names) {
    try {
      const newKey = renamedKey(oldKey)!
      const value = localStorage.getItem(oldKey)
      if (value === null) continue
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, value)
        result.moved++
        localStorage.removeItem(oldKey)
      } else {
        result.alreadyThere++
      }
    } catch {
      result.failed++
    }
  }
}

async function moveIndexedDb(result: StorageMoveResult): Promise<void> {
  const oldKeys = (await keys()).filter((k): k is string => renamedKey(k) !== null)
  for (let i = 0; i < oldKeys.length; i += BATCH) {
    const chunk = oldKeys.slice(i, i + BATCH)
    let values: unknown[]
    try {
      values = await getMany(chunk)
    } catch {
      result.failed += chunk.length
      continue
    }
    for (let j = 0; j < chunk.length; j++) {
      let wrote = false
      try {
        await update(renamedKey(chunk[j])!, (current) => {
          if (current !== undefined) return current
          wrote = true
          return values[j]
        })
      } catch {
        result.failed++
        continue
      }
      if (!wrote) {
        result.alreadyThere++
        continue
      }
      result.moved++
      // The copy is saved, so a failed delete only leaves a spare copy under
      // the old name. The next boot finds the new key filled and keeps both.
      await del(chunk[j]).catch(() => undefined)
    }
  }
}

export async function migrateLegacyStorage(): Promise<StorageMoveResult> {
  const result: StorageMoveResult = { moved: 0, alreadyThere: 0, failed: 0, uncheckable: false }
  moveLocalStorage(result)
  try {
    await moveIndexedDb(result)
  } catch {
    // `keys()` itself failed, so there was no way to see whether old data
    // exists. Said on screen rather than assumed away: if it does exist, the
    // owner's settings would look reset with no explanation.
    result.uncheckable = true
  }
  return result
}
