/**
 * The order of the "check the 1" queue (v0.9.71) and where on a song it starts playing. Pure: the queue itself lives in `controls.ts`.
 *
 * Why Hip Hop and Mizrahi first: the detector's "1" is right on ~93% of the owner's dance songs and ~70% of those (`docs/handoff/v0.9.5.md`),
 * so his minutes go where the computer is worst.
 */
import { nextBarLineSec, setDownbeatAt } from '@/core/beatgrid'
import type { BeatGrid } from '@/core/types'

export interface QueueTrack {
  id: string
  contentHash?: string
  genre?: string
}

const WEAK_GENRES = /hip.?hop|\brap\b|mizrahi|מזרחית|היפ/i

/** The songs whose "1" he has not checked yet, weak-genre songs first, otherwise in library order. A song without a hash yet is unknown, so it stays in. */
export function queueOrder<T extends QueueTrack>(tracks: readonly T[], checkedHashes: ReadonlySet<string>): T[] {
  const open = tracks.filter((t) => !(t.contentHash && checkedHashes.has(t.contentHash)))
  const weak = open.filter((t) => t.genre != null && WEAK_GENRES.test(t.genre))
  const rest = open.filter((t) => !(t.genre != null && WEAK_GENRES.test(t.genre)))
  return [...weak, ...rest]
}

/**
 * v0.9.73: how many songs still wait for his "1". A song without a content hash yet cannot be matched to a saved grid, so it is counted
 * apart (`unidentified`) instead of being folded into either side: the hash pass takes minutes after a scan, and the count must not jump.
 */
export function countUnchecked(tracks: readonly QueueTrack[], checkedHashes: ReadonlySet<string>): { unchecked: number; unidentified: number } {
  let unchecked = 0
  let unidentified = 0
  for (const t of tracks) {
    if (!t.contentHash) unidentified++
    else if (!checkedHashes.has(t.contentHash)) unchecked++
  }
  return { unchecked, unidentified }
}

/** The first song in the order not yet visited this run (visited = checked, moved or skipped). */
export function nextInQueue<T extends QueueTrack>(order: readonly T[], visitedIds: ReadonlySet<string>): T | null {
  return order.find((t) => !visitedIds.has(t.id)) ?? null
}

/** How many are still ahead: not visited and not found checked since the queue was built. */
export function queueRemaining(order: readonly QueueTrack[], visitedIds: ReadonlySet<string>, checkedHashes: ReadonlySet<string>): number {
  return order.filter((t) => !visitedIds.has(t.id) && !(t.contentHash && checkedHashes.has(t.contentHash))).length
}

/**
 * Where to start playing: a bar line about a third into the song. The first seconds are often an intro with no kick, where the "1"
 * cannot be heard; a third in is usually inside the body. Without a grid, just that point.
 */
export function checkStartSec(durationSec: number, grid: BeatGrid | null): number {
  const t = Math.max(0, durationSec * 0.3)
  return grid && grid.bpm > 0 ? nextBarLineSec(t, grid) : t
}

/**
 * "The 1 is here", pressed by hand: a press lands 100-200 ms after the beat it meant, and taking the playhead as the new bar line would
 * carry that delay into the whole grid. The detector's beats are already within ~25 ms on 97% of the corrected songs, so the press only
 * picks WHICH beat is the "1": the grid keeps its beat positions and its bar line moves to the nearest one.
 */
export function barLineAtNearestBeat(grid: BeatGrid, pressSec: number): BeatGrid {
  const beatSec = 60 / grid.bpm
  const n = Math.round((pressSec - grid.offsetSec) / beatSec)
  return setDownbeatAt(grid.bpm, grid.offsetSec + n * beatSec)
}
