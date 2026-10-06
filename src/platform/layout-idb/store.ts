/**
 * Screen layout the owner chose by hand (v0.9.34): today one flag, whether the
 * track list is pulled up big (pads hidden). Same one-record `idb-keyval`
 * shape as `fx-idb/store.ts`.
 *
 * Not a Settings-screen field: it is set by dragging the list's edge, and a
 * second way to set the same thing in a form would only be a second thing to
 * keep in step.
 */
import { get, set } from 'idb-keyval'

const KEY = 'deckmix:layout:libraryExpanded'

/** Never throws — a blocked IndexedDB must only mean "starts at the normal size", not an app that will not open. `null` = nothing saved yet. */
export async function getLibraryExpanded(): Promise<boolean | null> {
  try {
    const stored = await get<unknown>(KEY)
    return typeof stored === 'boolean' ? stored : null
  } catch {
    return null
  }
}

/** Throws on failure — the one call site in `controls.ts` says so on screen rather than letting the size quietly not come back next time. */
export async function saveLibraryExpanded(expanded: boolean): Promise<void> {
  await set(KEY, expanded)
}
