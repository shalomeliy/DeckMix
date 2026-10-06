/**
 * Asking the internet who sang a song (v0.9.44). The only thing in DeckMix that
 * leaves the computer, and only when the owner presses the button on one row:
 * the song's name goes out, nothing else — no file, no path, no audio.
 * `core/online-artist.ts` decides what to send and which answers to believe.
 */
export interface OnlineHit {
  artist: string
  track: string
}

export interface ArtistLookup {
  /** Rejects with a message the owner can read — never resolves empty on a failed request. */
  search(term: string): Promise<OnlineHit[]>
}
