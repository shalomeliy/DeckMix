/**
 * "Collect and copy" sampler bank export/import (v0.8.9) — the counterpart
 * to `sampler-idb/store.ts`'s plain JSON save/load. A recorded slot's audio
 * (v0.7.5) lives only in this browser's `sampler-recordings-idb`, so the
 * plain export deliberately leaves it out (`controls.ts`'s `exportSamplerBank`)
 * and only counts it. This module is the mode that actually carries the
 * audio: a folder the owner picks, holding one JSON manifest plus one WAV
 * per recorded slot.
 *
 * Neither `sampler-idb/store.ts` nor `recorder-fsaccess/writer.ts` is the
 * right home for this: the first owns IndexedDB persistence, the second owns
 * writing bytes the app just captured. This is the third thing — reading
 * IndexedDB blobs back out and writing them to disk alongside a manifest —
 * so it gets its own module rather than stretching either existing one's
 * single responsibility.
 *
 * Same "read the user's files, never write to them" carve-out as
 * `recorder-fsaccess/writer.ts`: this only ever writes into a folder the
 * owner explicitly opens in a directory picker, never a path the app already
 * knew about.
 */
import { manifestFileNames } from '@/core/sampler'
import type { StoredSamplerBank } from '@/platform/sampler-idb/store'

const BASE_NAME = 'soundgrid-sampler-bank'

interface BankManifest {
  version: 2
  bank: StoredSamplerBank
  recordings: { recordingId: string; fileName: string }[]
}

interface DirectoryPickerOptions {
  mode?: 'read' | 'readwrite'
}

function getDirectoryPicker(): ((o?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>) | undefined {
  return (window as unknown as { showDirectoryPicker?: (o?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker
}

async function fileExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name, { create: false })
    return true
  } catch {
    return false
  }
}

export type ExportOutcome = { kind: 'ok'; collected: number; total: number } | { kind: 'cancelled' }

/**
 * Exports the bank plus every recorded slot's actual audio into a folder the
 * owner picks. `getBlob` is injected (`sampler-recordings-idb`'s
 * `getRecordingBlob`) rather than imported directly, so this module's only
 * real I/O dependency is the file system — everything else comes in as data.
 *
 * On a name collision the owner decides, every time (v0.8.9 spec, 22/09):
 * `confirm` overwrites, `cancel` asks for a different base name and the
 * whole check runs again. Nothing is silently overwritten and nothing is
 * silently refused.
 */
export async function exportSamplerBankWithRecordings(
  bank: StoredSamplerBank,
  getBlob: (id: string) => Promise<Blob | undefined>,
): Promise<ExportOutcome> {
  const picker = getDirectoryPicker()
  if (typeof picker !== 'function') throw new Error('this browser has no folder save dialog')
  let dir: FileSystemDirectoryHandle
  try {
    dir = await picker({ mode: 'readwrite' })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return { kind: 'cancelled' }
    throw err
  }

  const recordingIds = bank.filter((s): s is NonNullable<typeof s> => s?.recordingId != null).map((s) => s.recordingId!)

  let base = BASE_NAME
  // eslint-disable-next-line no-constant-condition -- exits via return, not the condition
  while (true) {
    const { jsonName, wavNames } = manifestFileNames(base, recordingIds)
    const collision = (await fileExists(dir, jsonName))
      ? jsonName
      : (await Promise.all(wavNames.map(async (n) => ((await fileExists(dir, n)) ? n : null)))).find((n) => n)
    if (!collision) break
    const overwrite = window.confirm(
      `A file named "${collision}" already exists in this folder. Overwrite it? Click Cancel to pick a different name instead.`,
    )
    if (overwrite) break
    const next = window.prompt('Pick a different name:', base)
    if (!next || !next.trim()) return { kind: 'cancelled' }
    base = next.trim()
  }

  const { jsonName, wavNames } = manifestFileNames(base, recordingIds)
  const recordings: BankManifest['recordings'] = []
  let collected = 0
  for (let i = 0; i < recordingIds.length; i++) {
    const id = recordingIds[i]
    const blob = await getBlob(id)
    // A slot's blob missing from IndexedDB at the moment of export (evicted
    // storage, a prior save that silently failed) is rare but not this
    // module's failure to hide — it's just left out, and the caller reports
    // `collected < total` rather than this throwing mid-export.
    if (!blob) continue
    const handle = await dir.getFileHandle(wavNames[i], { create: true })
    const writable = await handle.createWritable()
    await writable.write(await blob.arrayBuffer())
    await writable.close()
    recordings.push({ recordingId: id, fileName: wavNames[i] })
    collected++
  }
  // The manifest is written last, after every WAV it names — an export
  // interrupted partway through leaves WAVs with no manifest pointing at
  // them yet, never a manifest promising a WAV that was never written.
  const manifest: BankManifest = { version: 2, bank, recordings }
  const jsonHandle = await dir.getFileHandle(jsonName, { create: true })
  const jsonWritable = await jsonHandle.createWritable()
  await jsonWritable.write(JSON.stringify(manifest, null, 2))
  await jsonWritable.close()

  return { kind: 'ok', collected, total: recordingIds.length }
}

export type ImportOutcome =
  | { kind: 'ok'; bank: StoredSamplerBank; recordingsFound: number; recordingsMissing: number }
  | 'cancelled'

/**
 * Inverse of `exportSamplerBankWithRecordings`. The manifest is a statement
 * of intent, not a promise — a WAV it names but that isn't in the folder
 * (moved, deleted, a hand-trimmed copy) is counted as missing and skipped,
 * never treated as a reason to fail the whole import. `resolveSamplerSlots`
 * (`controls.ts`) already turns a slot whose recording never arrived into a
 * visible, counted "couldn't be loaded" notice — this only has to get the
 * blob into IndexedDB under the same `recordingId` the manifest names, and
 * that existing machinery takes it from there.
 */
export async function importSamplerBankWithRecordings(
  saveBlob: (id: string, blob: Blob) => Promise<void>,
): Promise<ImportOutcome> {
  const picker = getDirectoryPicker()
  if (typeof picker !== 'function') throw new Error('this browser has no folder open dialog')
  let dir: FileSystemDirectoryHandle
  try {
    dir = await picker({ mode: 'read' })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
    throw err
  }

  const jsonNames: string[] = []
  // FileSystemDirectoryHandle is an async-iterable of [name, handle] pairs in
  // every browser that implements it — not yet in lib.dom's own types.
  for await (const [name] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    if (name.toLowerCase().endsWith('.json')) jsonNames.push(name)
  }
  if (jsonNames.length === 0) throw new Error('no sampler bank file (.json) found in this folder')
  if (jsonNames.length > 1) {
    throw new Error(`this folder has ${jsonNames.length} .json files — expected exactly one sampler bank export`)
  }

  const jsonHandle = await dir.getFileHandle(jsonNames[0])
  const file = await jsonHandle.getFile()
  const parsed = JSON.parse(await file.text()) as Partial<BankManifest>
  if (parsed.version !== 2 || !Array.isArray(parsed.bank) || !Array.isArray(parsed.recordings)) {
    throw new Error(`"${file.name}" is not a SoundGrid sampler bank + recordings export`)
  }

  let recordingsFound = 0
  let recordingsMissing = 0
  for (const { recordingId, fileName } of parsed.recordings) {
    try {
      const wavHandle = await dir.getFileHandle(fileName)
      const wavFile = await wavHandle.getFile()
      await saveBlob(recordingId, wavFile)
      recordingsFound++
    } catch {
      recordingsMissing++
    }
  }

  return { kind: 'ok', bank: parsed.bank, recordingsFound, recordingsMissing }
}
