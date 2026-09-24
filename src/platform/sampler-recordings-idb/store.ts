/**
 * Raw audio for a live-recorded sampler slot (v0.7.5). `sampler-idb/store.ts`
 * only ever persisted metadata — a `contentHash` pointing at a library
 * file — because every slot used to come from one. A slot recorded live has
 * no source file to re-resolve from, so its actual bytes (a WAV blob) have
 * to live somewhere; this is that somewhere, keyed by a generated id
 * (`SamplerSlot.recordingId`) instead of a content hash.
 *
 * Never throws on read — same convention as `getSamplerBank`: a missing or
 * blocked IndexedDB must not stop the app from starting, only leave that
 * one slot unresolved with a visible notice (`controls.ts`'s
 * `resolveSamplerSlots`), never a silently empty pad.
 */
import { del, get, set } from 'idb-keyval'

const KEY_PREFIX = 'deckmix:sampler:recording:'

export async function saveRecordingBlob(id: string, blob: Blob): Promise<void> {
  await set(KEY_PREFIX + id, blob)
}

export async function getRecordingBlob(id: string): Promise<Blob | undefined> {
  try {
    return await get<Blob>(KEY_PREFIX + id)
  } catch {
    return undefined
  }
}

export async function deleteRecordingBlob(id: string): Promise<void> {
  try {
    await del(KEY_PREFIX + id)
  } catch (err) {
    // Best-effort cleanup — an orphaned blob costs storage, not correctness,
    // so this doesn't surface a user-facing notice. But "best-effort" isn't
    // "invisible": logged so a repeated failure is at least findable,
    // per this project's "a catch that swallows has to answer: how does
    // the user find out?" rule (change-reviewer flagged this as silent).
    console.error(`sampler recording blob ${id} failed to delete`, err)
  }
}
