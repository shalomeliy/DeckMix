/**
 * Where the "Mix in" pad of an Excellent-rated mix may go: onto the track the mix went into, if the deck still holds it.
 *
 * The first version compared content hashes only. A hash is read when the song loads and can still be missing when the mix ends
 * (hash failed, or the load was served from elsewhere), so a deck that held the right track was reported as "no longer holds the
 * track". The track's own id is the identity that cannot be missing; the hash is what the pad is *saved under*, so a missing one is a
 * different, separately named reason.
 */
export interface MixEntryTarget {
  toTrackId?: string
  toContentHash?: string
}
export interface DeckTrackRef {
  id: string
  contentHash?: string
}

export type MixEntryVerdict = 'ok' | 'other-track' | 'no-hash'

export function mixEntryVerdict(r: MixEntryTarget, deckTrack: DeckTrackRef | undefined | null): MixEntryVerdict {
  if (!deckTrack) return 'other-track'
  const sameById = r.toTrackId != null && deckTrack.id === r.toTrackId
  const sameByHash = r.toContentHash != null && deckTrack.contentHash === r.toContentHash
  if (!sameById && !sameByHash) return 'other-track'
  return deckTrack.contentHash ? 'ok' : 'no-hash'
}
