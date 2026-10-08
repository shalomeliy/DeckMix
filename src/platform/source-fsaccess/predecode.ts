/**
 * Decode a song ahead of time into the one slot (v0.9.66). The same steps as the first half of `loadTrackToDeck` — read, hash, then
 * `engine.decode` — so the buffer is the one a load would have made, sample for sample (the plan's reason for not using another
 * decoder: v0.9.64). It goes through the background pacer, like every other pass that must not make a playing deck skip.
 */
import type { Track } from '@/core/types'
import { decodedBytes, predecodeKey, predecodeSkipReason } from '@/core/predecode'
import { engine } from '@/platform/audio-webaudio/engine'
import { clearPredecoded, hasPredecoded, putPredecoded, setPredecodeStatus } from '@/platform/audio-webaudio/predecode-slot'
import { hashBytes } from '@/platform/source-fsaccess/hash'
import { runInBackgroundPace } from '@/platform/source-fsaccess/library'

/** The key a load must present for this file, or the one this decode will store under. Reads the file's metadata, not its bytes. */
export async function predecodeKeyFor(track: Track): Promise<string> {
  const file = await track.handle.getFile()
  return predecodeKey(track.id, file.size, file.lastModified, engine.ctx.sampleRate)
}

/**
 * Resolves when the slot holds this song, was already holding it, or the song was refused/failed — each with its status set.
 * `stillWanted` is asked again just before the expensive step and just before storing: the selection may have moved on, and a decode
 * nobody wants must not evict a good one or sit in memory.
 */
export async function predecodeTrack(track: Track, deviceMemoryGb: number | undefined, stillWanted: () => boolean): Promise<void> {
  const name = track.title ?? track.name
  try {
    const file = await track.handle.getFile()
    const key = predecodeKey(track.id, file.size, file.lastModified, engine.ctx.sampleRate)
    if (hasPredecoded(key)) return
    const why = predecodeSkipReason({ sizeBytes: file.size, durationSec: track.durationSec, deviceMemoryGb })
    if (why) {
      setPredecodeStatus({ state: 'skipped', name, why })
      return
    }
    if (!stillWanted()) return
    // Before the new decode, not after it: holding the old song and decoding the new one together is two slots of memory at the peak
    // (up to ~460 MB), which is the risk the memory rule exists to avoid. The old song is no longer the selection.
    clearPredecoded()
    setPredecodeStatus({ state: 'decoding', name })
    await runInBackgroundPace(async () => {
      if (!stillWanted()) {
        setPredecodeStatus({ state: 'idle' })
        return
      }
      const data = await file.arrayBuffer()
      // Hashed before decode for the same reason `loadTrackToDeck` does: `decodeAudioData` neuters its input.
      let contentHash: string | undefined
      try {
        contentHash = await hashBytes(data)
      } catch (hashErr) {
        console.error('hash failed (ahead-of-time decode)', hashErr)
      }
      const buffer = await engine.decode(data)
      if (!stillWanted()) {
        setPredecodeStatus({ state: 'idle' })
        return
      }
      putPredecoded(key, buffer, contentHash)
      setPredecodeStatus({ state: 'ready', name, megabytes: Math.round(decodedBytes(buffer.length, buffer.numberOfChannels) / 1048576) })
    })
  } catch (err) {
    setPredecodeStatus({ state: 'failed', name, why: err instanceof Error ? err.message : String(err) })
  }
}
