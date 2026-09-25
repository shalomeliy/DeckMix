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
