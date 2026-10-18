/**
 * The order of the "check the 1" queue (v0.9.71) and where on a song it starts playing. Pure: the queue itself lives in `controls.ts`.
 *
 * Why Hip Hop and Mizrahi first: the detector's "1" is right on ~93% of the owner's dance songs and ~70% of those (`docs/handoff/v0.9.5.md`),
 * so his minutes go where the computer is worst.
 */
import { nextBarLineSec } from '@/core/beatgrid'
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
