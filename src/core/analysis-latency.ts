import type { LatencyProfile } from '@/core/settings'
import type { Track } from '@/core/types'

/**
 * The sound gets a bigger cushion while the library analyses (v0.9.52).
 *
 * 07/10 Shalom, after v0.9.51 slowed the analysis down while a deck plays: "make Balanced the default when the site loads, and once the
 * analysis is done go back to the original setting". A bigger audio buffer rides out a busy CPU instead of skipping; the cost is a slightly
 * later response to the jog wheel and cues, which is why it is only for the stretch with analysis to do.
 *
 * Two limits the platform sets, both said on screen rather than hidden:
 * - `latencyHint` is fixed when the AudioContext is built, before the library is even read, so "is there analysis to do?" is answered from
 *   what the last session left behind: the analysis versions it finished with. A version bump (the case he hears after every new version)
 *   or a session closed mid-analysis both read as "not settled". New files dropped into an already-settled library are not foreseen.
 * - Going back means building a new AudioContext, which cuts the sound. So it is not done behind his back: when the analysis finishes the
 *   library says to reload the page, and the next load is back on his own setting.
 */

/** Everything whose bump re-analyses the library. A new one belongs here, or a bump of it gets no cushion. */
export function analysisFingerprint(v: { analyzer: number; embedder: number; vocal: number }): string {
  return `a${v.analyzer}-e${v.embedder}-v${v.vocal}`
}

/**
 * What the AudioContext is built with. Only the owner's default (`interactive`, or nothing stored) is lifted; a profile he chose himself
 * in Settings — Balanced or Safe — is already at least this cushioned and stays exactly as he set it.
 */
export function bootLatency(
  stored: LatencyProfile | null,
  settledFingerprint: string | null,
  currentFingerprint: string,
): { hint: LatencyProfile; cushioned: boolean } {
  const own = stored ?? 'interactive'
  if (own === 'interactive' && settledFingerprint !== currentFingerprint) return { hint: 'balanced', cushioned: true }
  return { hint: own, cushioned: false }
}

/**
 * Every pass is done for every row: BPM (failed counts as done — it is a final answer on screen), similarity, and the vocal strip.
 * Mirrors the "waiting" counts the library header shows, so the cushion is never declared over while a badge still counts.
 */
export function libraryAnalysisSettled(
  tracks: ReadonlyArray<Pick<Track, 'analysisState' | 'embedding' | 'embeddingState' | 'vocal'>>,
): boolean {
  return tracks.every((t) => {
    if (t.analysisState === 'queued' || t.analysisState === 'analyzing') return false
    if (t.analysisState !== 'analyzed') return true
    if (!t.embedding && t.embeddingState !== 'failed') return false
    const v = t.vocal?.state
    return !!v && v !== 'queued' && v !== 'analysing'
  })
}
