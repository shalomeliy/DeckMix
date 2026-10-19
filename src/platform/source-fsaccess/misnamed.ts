import {
  MAX_ID3_SKIP,
  detectAudioFormat,
  extensionMismatch,
  id3TagLength,
  renamedWithExtension,
  hasMpegFramesWithin,
  startsWithMpegFrame,
  type AudioFormat,
  type MisnamedFile,
} from '@/core/audio-format'
import type { Track } from '@/core/types'

/** Reads `n` bytes at `at` — never the whole file. */
async function slice(file: File, at: number, n: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(at, at + n).arrayBuffer())
}

/** An untagged mp3 starts with a frame; a tagged one may have audio a little past a too-short ID3 size (seen on tags with a UTF-16 frame at the end). */
async function looksLikeMp3(file: File): Promise<boolean> {
  const skip = id3TagLength(await slice(file, 0, 10))
  if (skip === 0) return startsWithMpegFrame(await slice(file, 0, 4))
  if (skip > MAX_ID3_SKIP) return false
  return hasMpegFramesWithin(await slice(file, skip, 1024 + 2 * 1441), 1024)
}

/** Real format of a file from at most two small reads (the ID3 header, then the bytes after the tag); `null` = could not tell. */
export async function sniffFormat(file: File): Promise<AudioFormat | null> {
  const head = await slice(file, 0, 10)
  const skip = id3TagLength(head)
  if (skip > MAX_ID3_SKIP) return null
  return detectAudioFormat(await slice(file, skip, 12), skip > 0)
}

const extOf = (name: string): string => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '')

export interface MisnamedReport {
  misnamed: MisnamedFile[]
  /** content we could not name — an unknown is listed, not treated as fine. Ids, not a count: the dialog names every one the badge counts */
  unverified: string[]
  /** files that could not be opened for the check (ids, for the same reason) */
  unreadable: string[]
}

/** Walks the scanned tracks and reports every one whose content disagrees with its extension. Reads a few bytes per file, writes nothing. */
export async function findMisnamedFiles(
  tracks: readonly Track[],
  shouldStop: () => boolean = () => false,
): Promise<MisnamedReport> {
  const report: MisnamedReport = { misnamed: [], unverified: [], unreadable: [] }
  for (const track of tracks) {
    if (shouldStop()) break
    try {
      const file = await track.handle.getFile()
      const actual = await sniffFormat(file)
      const ext = extOf(file.name)
      if (!actual) {
        // an untagged ".mp3" that really starts with an MPEG frame agrees with its name: nothing to report, nothing to fix
        if (ext === 'mp3' && (await looksLikeMp3(file))) continue
        report.unverified.push(track.id)
        continue
      }
      const m = extensionMismatch(ext, actual)
      if (m) {
        report.misnamed.push({ trackId: track.id, fileName: file.name, currentExt: ext, actual, suggestedExt: m.suggestedExt })
      }
    } catch {
      report.unreadable.push(track.id)
    }
  }
  return report
}

/** The folder the last scan walked — the permission prompt for a rename is asked on it, once for the whole library. */
let scanRoot: FileSystemDirectoryHandle | null = null
export function rememberScanRoot(root: FileSystemDirectoryHandle | null): void {
  scanRoot = root
}
export function currentScanRoot(): FileSystemDirectoryHandle | null {
  return scanRoot
}

export type RenameOutcome = { ok: true; newName: string } | { ok: false; why: string }

type MovableHandle = FileSystemFileHandle & { move?: (name: string) => Promise<void> }

/** Can this browser rename a file in place? Without it the dialog lists the files and says how to fix them by hand. */
export function canRenameFiles(): boolean {
  return typeof (globalThis as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle?.prototype === 'object' &&
    'move' in (FileSystemFileHandle.prototype as object)
}

/**
 * The only place the app renames an existing file of the owner's (v0.9.59, named exception to "never write to them").
 * One file per call, only after the owner clicked that file's own button; only the extension changes, to one from a fixed table;
 * content is never touched and nothing is created or deleted. **Call from the click**: the permission prompt needs the gesture,
 * so `requestPermission` is the first await.
 *
 * Every refusal is a named sentence (`why`) — a failed fix is shown, never swallowed.
 */
export async function renameTrackExtension(
  root: FileSystemDirectoryHandle,
  track: Track,
  expected: MisnamedFile,
): Promise<RenameOutcome> {
  const handle = track.handle as MovableHandle
  if (typeof handle.move !== 'function') return { ok: false, why: 'This browser cannot rename files from a page.' }
  if ((await root.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if ((await root.requestPermission({ mode: 'readwrite' })) !== 'granted') {
      return { ok: false, why: 'Permission to change files was not given, so nothing was renamed.' }
    }
  }
  try {
    // the file may have changed since the scan: look at the same handle again, and rename only if it is still what the list said
    const file = await handle.getFile()
    if (file.name !== expected.fileName) return { ok: false, why: 'The file was renamed since the scan. Scan the folder again.' }
    const actual = await sniffFormat(file)
    if (actual !== expected.actual) return { ok: false, why: 'The file changed since the scan, so it was left alone.' }
    const newName = renamedWithExtension(file.name, expected.suggestedExt)
    if (!newName) return { ok: false, why: 'The name cannot safely carry the new extension.' }

    // the folder this file sits in: walk the scan path, and confirm the walk ends at the very same file
    const segments = track.path.split('/')
    let dir = root
    for (const seg of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(seg)
    const same = await (await dir.getFileHandle(file.name)).isSameEntry(handle)
    if (!same) return { ok: false, why: 'The file is no longer where the scan found it. Scan the folder again.' }

    // Windows treats a.MP3 and a.mp3 as one name, so compare ignoring case across the whole folder
    const wanted = newName.toLowerCase()
    for await (const [name] of dir.entries()) {
      if (name.toLowerCase() === wanted) return { ok: false, why: `A file named “${name}” already exists next to it. Nothing was changed.` }
    }

    await handle.move(newName)
    const check = await dir.getFileHandle(newName)
    if (!(await check.isSameEntry(handle))) return { ok: false, why: 'The rename did not leave the file where expected. Check the folder.' }
    return { ok: true, newName }
  } catch (err) {
    const e = err as DOMException
    return { ok: false, why: `The browser refused: ${e?.name ?? 'error'}${e?.message ? ` (${e.message})` : ''}` }
  }
}
