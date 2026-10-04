/**
 * Finished vocal strips on `idb-keyval` (v0.9.10b), one record per (song, genre): the model's genre column changes the answer, so a genre edit is a
 * different entry, not a stale one. `VOCAL_STRIP_VERSION` covers everything the answer depends on besides the audio: the frozen model and the
 * thresholds in core/sound/vocal-strip.ts. Bump it with either, and every strip is recomputed in the background — never served stale.
 * `failed` is never stored: a failure is not an answer about the song and the next run should try again.
 */
import { del, get, set } from 'idb-keyval'
import type { VocalResult } from '@/core/sound/vocal-timeline'

export const VOCAL_STRIP_VERSION = 2
const KEY_PREFIX = 'deckmix:vocalStrip:'

interface Stored {
  version: number
  state: VocalResult['state']
  note?: string
  cells: Uint8Array | null
  stereo: boolean
}

const keyFor = (contentHash: string, genre: string) => `${KEY_PREFIX}${contentHash}:${genre}`

export async function getVocalStrip(contentHash: string, genre: string): Promise<VocalResult | null> {
  let s: Stored | undefined
  try {
    s = await get<Stored>(keyFor(contentHash, genre))
  } catch {
    return null // unreadable storage: the strip is recomputed this session
  }
  if (!s || s.version !== VOCAL_STRIP_VERSION) return null
  return { state: s.state, note: s.note, timeline: s.cells ? { cells: s.cells, stereo: s.stereo } : null }
}

/** Throws on failure; the queue counts it and says so. */
export async function putVocalStrip(contentHash: string, genre: string, r: VocalResult): Promise<void> {
  if (r.state === 'failed') return
  const s: Stored = { version: VOCAL_STRIP_VERSION, state: r.state, note: r.note, cells: r.timeline?.cells ?? null, stereo: r.timeline?.stereo ?? false }
  await set(keyFor(contentHash, genre), s)
}

/** Forgets the computer's own strip for one song (the owner taught the computer from it: his marks replace it). Throws; the caller says so. */
export async function deleteVocalStrip(contentHash: string, genre: string): Promise<void> {
  await del(keyFor(contentHash, genre))
}
