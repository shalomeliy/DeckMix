/**
 * What the library shows on startup, before anyone has clicked anything.
 *
 * A browser cannot open a folder on its own — that is a deliberate security
 * boundary, not a missing API. So "load the library automatically" is really
 * two different situations, and the whole point of this module is that the app
 * can tell them apart:
 *
 * - the saved handle still holds a `granted` permission → scan with no click;
 * - it does not → **exactly one** click, and a line that says so.
 *
 * The trap this exists to close: picking "Allow this time" in Chromium's
 * dialog does **not** make the next visit `denied`. It makes it `prompt` —
 * the same value a handle has when it was never granted at all. And
 * `requestPermission()` needs transient user activation, so calling it from a
 * page-load effect raises no dialog whatsoever. Code that treats `prompt` as
 * "just ask again" therefore produces an empty library with no error, no
 * dialog and nothing on screen — the silent skip this project forbids.
 *
 * Pure on purpose: no handle, no DOM, no IndexedDB. It maps facts to a state
 * and a sentence, which is the part worth testing.
 */

/** Chromium's three answers to `queryPermission({ mode: 'read' })`. */
export type SavedPermission = 'granted' | 'prompt' | 'denied'

export type LibraryBoot =
  /** the IndexedDB read is still in flight — first paint only */
  | 'checking'
  /** not a Chromium desktop browser: no `showDirectoryPicker` at all */
  | 'unsupported'
  /** nothing saved: a first visit, or the handle was cleared */
  | 'new'
  /** something IS saved, but it is not a handle this build can revive (v0.2.8) */
  | 'unusable'
  /** saved and still granted — scanning right now, no click was needed */
  | 'restoring'
  /** saved, but the permission reverted to `prompt`. One click fixes it. */
  | 'needs-click'
  /** the user (or a site setting) actually said no */
  | 'blocked'
  /** the folder was moved, renamed or deleted since it was saved */
  | 'missing'
  /** the scan threw something we did not anticipate — never swallowed */
  | 'failed'
  /** tracks are on screen */
  | 'loaded'

/**
 * Which of the three startup situations we are in.
 *
 * `granted` is the only one that may scan unattended; everything else has to
 * wait for a gesture, and say why it is waiting.
 */
export function bootFor(
  supported: boolean,
  saved: { kind: 'none' } | { kind: 'unusable' } | { kind: 'saved'; permission: SavedPermission },
): LibraryBoot {
  if (!supported) return 'unsupported'
  if (saved.kind === 'none') return 'new'
  if (saved.kind === 'unusable') return 'unusable'
  if (saved.permission === 'granted') return 'restoring'
  if (saved.permission === 'denied') return 'blocked'
  return 'needs-click'
}

/**
 * A failed scan, classified by the exception name.
 *
 * `NotFoundError` is the folder having moved or been renamed — a fact worth
 * naming out loud, because an empty list looks identical to a folder with no
 * music in it. `NotAllowedError` is permission that went away between the
 * query and the walk. Anything else keeps its own name rather than being
 * flattened into "something went wrong".
 */
export function bootForScanError(errorName: string): LibraryBoot {
  if (errorName === 'NotFoundError') return 'missing'
  if (errorName === 'NotAllowedError' || errorName === 'SecurityError') return 'blocked'
  return 'failed'
}

export interface BootCopy {
  title: string
  body: string
  /** label for the one button that resolves this state, when one can */
  cta?: string
}

/**
 * The sentence each state puts on screen.
 *
 * Every state that is not `loaded` returns copy — that is the invariant, and
 * `tests/core/library-boot.test.ts` holds it: no startup path may end in a
 * blank panel with nothing explaining it.
 *
 * `folderName` is threaded through rather than described generically because
 * "Tracks is no longer there" is actionable and "the folder is missing" is
 * not. Same reason the skipped badge names the extensions.
 */
export function bootCopy(
  boot: LibraryBoot,
  folderName: string | null,
  detail?: string,
): BootCopy | null {
  const folder = folderName ?? 'your library folder'
  switch (boot) {
    case 'loaded':
      return null
    case 'checking':
      return { title: 'Looking for your library…', body: 'Reading the folder you used last.' }
    case 'unsupported':
      return {
        title: 'Local library needs Chrome or Edge',
        body: 'DeckMix reads audio straight from a folder on your disk using the File System Access API. Open it in a Chromium desktop browser to scan your collection.',
      }
    case 'new':
      return {
        title: 'No music loaded yet',
        body: 'Pick the folder your tracks live in. The dialog opens in your Music folder. Nothing is uploaded — files stay on your machine.',
        cta: 'Load my music folder',
      }
    case 'unusable':
      return {
        title: 'The saved folder cannot be reopened',
        body: 'DeckMix remembers a folder from an earlier version of itself, and this build cannot revive it. Picking it again fixes it for good — nothing was lost.',
        cta: 'Pick the folder again',
      }
    case 'restoring':
      return { title: `Opening ${folder}…`, body: 'The folder you used last, reopening on its own.' }
    case 'needs-click':
      return {
        title: `${folder} is ready — one click to open it`,
        body: 'Browsers hand back folder access one session at a time. If yours offered "Allow on every visit" and you took it, this step disappears; otherwise it is one click after each reload. Either way it is not an error.',
        cta: `Open ${folder}`,
      }
    case 'blocked':
      return {
        title: `Chrome is blocking access to ${folder}`,
        body: 'Folder access was refused for this site. Pick the folder again to grant it — and if the dialog offers "Allow on every visit", taking it is what lets DeckMix open the folder by itself.',
        cta: 'Pick the folder again',
      }
    case 'missing':
      return {
        title: `${folder} is no longer there`,
        body: 'It was moved, renamed or deleted since the last session. Nothing was lost here — DeckMix only ever reads.',
        cta: 'Pick the folder again',
      }
    case 'failed':
      return {
        title: `Could not read ${folder}`,
        body: detail ? `The browser reported: ${detail}` : 'The browser refused the read and gave no reason.',
        cta: 'Pick the folder again',
      }
  }
}
