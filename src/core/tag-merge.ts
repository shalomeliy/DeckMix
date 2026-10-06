import type { DeckId, Track } from '@/core/types'

/**
 * Folds a tag-read patch into a track that may already carry analysis
 * results: what the track already holds wins, the tag only fills gaps.
 *
 * "Already holds" means a value, not a key. The analysis merge writes
 * `durationSec: t.durationSec ?? p.durationSec`, which leaves an explicit
 * `durationSec: undefined` on a track whose decode failed. The plain
 * `{ ...patch, ...track }` this replaced let that `undefined` overwrite the
 * tag's TLEN, so when a failed decode landed before the tag pass the Time
 * column went blank for good — two of six tracks in
 * `scripts/verify-library-boot.mjs`, depending on which pass finished first
 * (found 2026-09-24, the first time the verify scripts ran as one suite).
 */
export function mergeTagPatch(track: Track, patch: Partial<Track>): Track {
  const merged: Record<string, unknown> = { ...patch }
  for (const [key, value] of Object.entries(track)) if (value !== undefined) merged[key] = value
  // The one exception to "what the track holds wins" (v0.8.27): a key the
  // analysis detected is a guess, a key tag is the owner's own data. The
  // analysis pass runs alongside this one, so either can land first.
  if (track.keySource === 'detected' && (patch.key || patch.camelot)) {
    merged.key = patch.key
    merged.camelot = patch.camelot
    delete merged.keySource
    delete merged.keyUncertain
  }
  return merged as unknown as Track
}

/**
 * The analysis side of the same rule: a detected key fills a track only when
 * it has no key at all. A tag that is present — even one in a spelling
 * `parseKey` could not read, kept as bare `key` — is never replaced.
 */
export function fillDetectedKey(track: Track, detected: Partial<Track>): Track {
  if (!detected.keySource || track.key || track.camelot) return track
  return { ...track, key: detected.key, camelot: detected.camelot, keySource: 'detected', keyUncertain: detected.keyUncertain }
}

/**
 * The background queue's merge (`Library.tsx`): tag values already on the
 * track win for bpm/duration, and the key fields go through
 * `fillDetectedKey`, never the spread — a plain `{ ...t, ...p }` would put a
 * detected key on top of a tag the tag pass read first.
 */
export function mergeAnalysisPatch(track: Track, patch: Partial<Track>): Track {
  const { key: _key, camelot: _camelot, keySource: _source, keyUncertain: _uncertain, ...rest } = patch
  return fillDetectedKey(
    { ...track, ...rest, bpm: track.bpm ?? patch.bpm, durationSec: track.durationSec ?? patch.durationSec },
    patch,
  )
}

/**
 * A deck holds a snapshot of the track from load time; the tag pass only
 * updates the library. So before a detected key goes on a deck, take the key
 * the library holds *now* — otherwise a tag read during the deck's analysis
 * loses to the guess (found in review, v0.8.27).
 */
export function withLatestKey(track: Track, latest: Track | undefined): Track {
  if (!latest || (!latest.key && !latest.camelot)) return track
  return { ...track, key: latest.key, camelot: latest.camelot, keySource: latest.keySource, keyUncertain: latest.keyUncertain }
}

/**
 * The standing half of `withLatestKey` (v0.8.35): the deck's copy of a track
 * follows the library's key every time the library changes, not only at the
 * one moment the deck's own analysis finishes. A cached analysis finishes in
 * milliseconds — before the tag pass or the background key detection has
 * reached the track — and the deck then said "key unknown" for the rest of
 * the set while the library row next to it showed the key.
 *
 * Returns the same object when nothing differs, so a library write that did
 * not touch this track's key does not re-render the deck.
 */
export function followLibraryKey(deckTrack: Track, latest: Track | undefined): Track {
  if (
    !latest ||
    (latest.key === deckTrack.key &&
      latest.camelot === deckTrack.camelot &&
      latest.keySource === deckTrack.keySource &&
      latest.keyUncertain === deckTrack.keyUncertain)
  )
    return deckTrack
  return withLatestKey(deckTrack, latest)
}

/**
 * `followLibraryKey` for every deck at once — what the store's `setLibrary`
 * runs on each write of `tracks`. Pure and here rather than inline in the
 * store so the tests reach it without a DOM. Returns the same `decks` object
 * when no deck's key changed.
 */
export function decksFollowLibraryKeys<D extends { track: Track | null }>(
  decks: Record<DeckId, D>,
  tracks: readonly Track[],
): Record<DeckId, D> {
  let out = decks
  for (const id of Object.keys(decks) as DeckId[]) {
    const deckTrack = decks[id].track
    if (!deckTrack) continue
    const next = followLibraryKey(deckTrack, tracks.find((t) => t.id === deckTrack.id))
    if (next !== deckTrack) out = { ...out, [id]: { ...out[id], track: next } }
  }
  return out
}

/** What the owner typed for a track (v0.8.38), as stored by content hash in `track-meta-idb`. */
export interface OwnerTempoKey {
  bpm?: number
  key?: string
  camelot?: string
}

/**
 * Puts the owner's own values on a track. They beat a tag and a detection,
 * so this runs *after* the other merges, and it has to hold whichever pass
 * lands later: a key marked `'owner'` is never replaced by `mergeTagPatch`
 * (it only replaces `'detected'`) nor by `fillDetectedKey` (it only fills an
 * empty key), and `mergeAnalysisPatch` keeps a `bpm` that is already set.
 * Returns the same track when there is nothing to apply.
 */
export function applyOwnerMeta(track: Track, owner: OwnerTempoKey | undefined): Track {
  if (!owner || (owner.bpm == null && !owner.key && !owner.camelot)) return track
  const out: Track = { ...track }
  if (owner.bpm != null) {
    out.bpm = owner.bpm
    out.bpmSource = 'owner'
  }
  if (owner.key || owner.camelot) {
    out.key = owner.key
    out.camelot = owner.camelot
    out.keySource = 'owner'
    delete out.keyUncertain
  }
  return out
}

/**
 * The undo of `applyOwnerMeta`: the owner pressed "back to original", so the
 * track takes the values a rescan would give it — `original` is the file tag,
 * else the analysis (the caller reads both, `controls.ts`). A field the owner
 * never set is left exactly as it is.
 */
export function clearOwnerMeta(track: Track, original: Partial<Track>, fields: { bpm: boolean; key: boolean }): Track {
  const out: Track = { ...track }
  if (fields.bpm && out.bpmSource === 'owner') {
    delete out.bpmSource
    out.bpm = original.bpm
  }
  if (fields.key && out.keySource === 'owner') {
    out.key = original.key
    out.camelot = original.camelot
    if (original.keySource) out.keySource = original.keySource
    else delete out.keySource
    if (original.keyUncertain != null) out.keyUncertain = original.keyUncertain
    else delete out.keyUncertain
  }
  return out
}

/**
 * Whether the deck may play our refined tempo instead of the track's labelled
 * BPM (the 20/09 rule in `loadTrackToDeck`): a label is a rounded number, so a
 * detection close to it is the same tempo, measured finer.
 *
 * "Close" is 2% for a tag. For a BPM the owner typed (v0.8.38) it is 0.5% —
 * enough for Beatport's whole-number rounding and no more. Detection is still
 * steered by the *file's* tag (it is the analysis hint and cache key), so with
 * a tag of 128 and the owner's 126 it settles near 127.9 — inside 2% of 126,
 * and the deck would have played the tag's tempo while the row said 126
 * (found in review).
 */
export function labelAgrees(track: Pick<Track, 'bpm' | 'bpmSource'>, detectedBpm: number | null): boolean {
  if (track.bpm == null || detectedBpm == null) return false
  const tolerance = track.bpmSource === 'owner' ? 0.005 : 0.02
  return Math.abs(detectedBpm - track.bpm) / track.bpm <= tolerance
}

/**
 * The owner's own artist answers (v0.9.41), stored by content hash in
 * `track-meta-idb`: an accepted artist goes on with `artistSource: 'owner'`
 * and beats the tag, the same way his BPM/key do; the rejected ones ride along
 * so the suggestion list never offers them again. `mergeTagPatch` keeps what
 * the track already holds, so a tag pass that lands later does not undo it.
 * Returns the same track when there is nothing to apply.
 */
export function applyOwnerArtist(track: Track, owner: { artist?: string; artistRejected?: string[] } | undefined): Track {
  if (!owner || (!owner.artist && !owner.artistRejected?.length)) return track
  const out: Track = { ...track }
  if (owner.artist) {
    out.artist = owner.artist
    out.artistSource = 'owner'
  }
  if (owner.artistRejected?.length) out.artistRejected = owner.artistRejected
  return out
}
