/**
 * Sampler bank persistence (v0.6.0) — one record holding all 16 slots'
 * settings, not per-track like `cues-idb`/`mix-ratings-idb`: a bank is a
 * single saved setup, not something that travels with one file.
 *
 * Slots key on `contentHash`, the same identity `genre-overrides-idb`
 * migrated to and `cues-idb` already used — a scan-relative path breaks the
 * moment a file moves; a content hash does not. Restoring only ever
 * resolves against the *currently scanned* library (`controls.ts`'s
 * `resolveSamplerSlots`) — a slot whose track isn't in this session's scan
 * yet stays visibly unresolved rather than silently empty.
 */
import { get, set } from 'idb-keyval'
import type { SamplerMode } from '@/core/sampler'

const KEY = 'soundgrid:sampler:bank'
const FILE_TYPES = [
  { description: 'DeckMix sampler bank', accept: { 'application/json': ['.json'] } },
]

export interface StoredSamplerSlot {
  /** exactly one of `contentHash`/`recordingId` is set for a real slot — library-linked vs. live-recorded (v0.7.5). */
  contentHash: string | undefined
  recordingId: string | undefined
  trackName: string
  bpm: number | undefined
  mode: SamplerMode
  gain: number
  syncEnabled: boolean
}

/** Fixed-length, index-aligned with the live bank; `null` marks an empty slot. */
export type StoredSamplerBank = (StoredSamplerSlot | null)[]

/**
 * Never throws — a missing/blocked IndexedDB must not stop the app from
 * starting, only leave every slot empty (same choice `mix-ratings-idb` makes).
 */
export async function getSamplerBank(): Promise<StoredSamplerBank> {
  try {
    return (await get<StoredSamplerBank>(KEY)) ?? []
  } catch {
    return []
  }
}

/** Throws on failure — `controls.ts`'s one call site surfaces it as a notice rather than silently not saving. */
export async function saveSamplerBank(bank: StoredSamplerBank): Promise<void> {
  await set(KEY, bank)
}

/**
 * Export the bank to a JSON file the owner picks — same File System Access
 * dialog family `pickLibraryFolder`/`pickTrackFiles` already use
 * (`platform/source-fsaccess/library.ts`), gated by the same `fsAccess`
 * capability. `'cancelled'` is not a failure: the owner closing the dialog
 * is a normal outcome, not something `controls.ts` should show a notice for.
 */
export async function exportSamplerBankToFile(bank: StoredSamplerBank): Promise<'ok' | 'cancelled'> {
  const picker = (
    window as unknown as {
      showSaveFilePicker?: (o?: {
        suggestedName?: string
        types?: { description: string; accept: Record<string, string[]> }[]
      }) => Promise<FileSystemFileHandle>
    }
  ).showSaveFilePicker
  if (typeof picker !== 'function') throw new Error('this browser has no file save dialog')
  let handle: FileSystemFileHandle
  try {
    handle = await picker({ suggestedName: 'deckmix-sampler-bank.json', types: FILE_TYPES })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
    throw err
  }
  const writable = await handle.createWritable()
  await writable.write(JSON.stringify({ version: 1, bank }, null, 2))
  await writable.close()
  return 'ok'
}

/** Inverse of `exportSamplerBankToFile`. Throws on a file that isn't one of ours — a bank silently half-imported from an unrelated JSON file is worse than a refused import. */
export async function importSamplerBankFromFile(): Promise<StoredSamplerBank | 'cancelled'> {
  const picker = (
    window as unknown as {
      showOpenFilePicker?: (o?: {
        multiple?: boolean
        types?: { description: string; accept: Record<string, string[]> }[]
      }) => Promise<FileSystemFileHandle[]>
    }
  ).showOpenFilePicker
  if (typeof picker !== 'function') throw new Error('this browser has no file open dialog')
  let handles: FileSystemFileHandle[]
  try {
    handles = await picker({ multiple: false, types: FILE_TYPES })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
    throw err
  }
  const file = await handles[0].getFile()
  const parsed = JSON.parse(await file.text()) as { version?: number; bank?: unknown }
  if (!Array.isArray(parsed.bank)) throw new Error(`"${file.name}" is not a DeckMix sampler bank file`)
  return parsed.bank as StoredSamplerBank
}
