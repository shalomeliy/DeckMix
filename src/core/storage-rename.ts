/**
 * v0.8.20: storage keys follow the product rename (v0.8.19, the old name → DeckMix).
 *
 * Every setting, cue, rating, crate, sampler recording and the remembered
 * library folder lives in the owner's browser under a prefixed key. Change the
 * prefix without carrying the data across and the app stops finding any of it.
 * Nothing is deleted, but everything *looks* deleted. So the old keys are moved,
 * once, before anything reads storage. What moved, and what could not, is
 * reported on screen.
 */
export const LEGACY_KEY_PREFIX = 'soundgrid:'
export const KEY_PREFIX = 'deckmix:'

/** The new name for an old key, or `null` for a key this move does not own. */
export function renamedKey(key: unknown): string | null {
  if (typeof key !== 'string' || !key.startsWith(LEGACY_KEY_PREFIX)) return null
  return KEY_PREFIX + key.slice(LEGACY_KEY_PREFIX.length)
}

export interface StorageMoveResult {
  /** entries carried from an old key to its new one */
  moved: number
  /** old entries left in place because the new key already held data, which wins */
  alreadyThere: number
  /** entries that could not be moved and still sit under the old key */
  failed: number
  /** storage could not even be listed, so it is unknown whether old data exists */
  uncheckable: boolean
}

/** What the owner is told, or `null` when there was nothing to move. */
export function storageMoveNotice(r: StorageMoveResult): { text: string; tone: 'warn' | 'info' } | null {
  if (r.failed > 0) {
    return {
      tone: 'warn',
      text:
        `${r.failed} saved item${r.failed === 1 ? '' : 's'} from before the rename to DeckMix could not be moved, ` +
        `so ${r.failed === 1 ? 'it is' : 'they are'} not showing. Nothing was deleted. Reload the page to try again.`,
    }
  }
  if (r.uncheckable) {
    return {
      tone: 'warn',
      text:
        'Could not check for data saved before the rename to DeckMix. If your settings, cues or ratings look reset, ' +
        'reload the page. Nothing was deleted.',
    }
  }
  if (r.moved === 0) return null
  return {
    tone: 'info',
    text: `Moved ${r.moved} saved item${r.moved === 1 ? '' : 's'} (settings, cues, ratings, crates, recordings) to DeckMix. Nothing was lost.`,
  }
}
