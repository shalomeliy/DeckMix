import type { Track } from '@/core/types'

/**
 * Which track the background analysis takes next (v0.8.32).
 *
 * A track with no BPM or no key has nothing to show until its analysis lands;
 * one whose tags already carry both only gets a waveform and a grid it can wait
 * for. 25/09 in Shalom's Chrome, a full re-analysis crawled through the library
 * in folder order, and the rows missing BPM/Key sat at "queued" behind tracks
 * that were already complete — they looked broken, not pending.
 *
 * Asked at every pick rather than sorted once up front: the tag pass runs
 * alongside this queue (`Library.tsx`), so what a track lacks is only known
 * while the queue is already running.
 */
export function takeNextForAnalysis<T>(remaining: T[], needsFirst: (item: T) => boolean): T | undefined {
  if (remaining.length === 0) return undefined
  const i = remaining.findIndex(needsFirst)
  return remaining.splice(i === -1 ? 0 : i, 1)[0]
}

/**
 * What a track just loaded onto a deck still lacks from the passes that come after BPM (v0.9.49) — those run for it now instead of when
 * the background queue reaches it. `null`: nothing to do yet or at all — no identity, BPM pass not done (`loadTrackToDeck` does that one
 * itself), or both already there. A strip left `queued` (a genre change) or stuck `analysing` (a pass cancelled mid-track) counts as missing.
 */
export function deckTrackNeeds(row: Pick<Track, 'analysisState' | 'contentHash' | 'vocal' | 'embedding'>): { vocal: boolean; embedding: boolean } | null {
  if (row.analysisState !== 'analyzed' || !row.contentHash) return null
  const vocal = !row.vocal || row.vocal.state === 'queued' || row.vocal.state === 'analysing'
  const embedding = !row.embedding
  return vocal || embedding ? { vocal, embedding } : null
}
