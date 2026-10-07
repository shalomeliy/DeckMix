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
  /** the Settings switch (v0.9.54) — off by default, and then nothing here ever lifts anything */
  enabled = false,
): { hint: LatencyProfile; cushioned: boolean } {
  const own = stored ?? 'interactive'
  if (enabled && own === 'interactive' && settledFingerprint !== currentFingerprint) return { hint: 'balanced', cushioned: true }
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

/**
 * How the cushion goes once the analysis is done (v0.9.53, Shalom 07/10: "why not refresh by yourself when no song is playing, or show
 * a button"). A reload is the only way back, and a reload throws away everything the page holds only in memory, so:
 * - `reload`: the page holds nothing to lose — both decks empty, no set history yet, no screen open over the decks, no recording or armed
 *   pad, and this tab has not already refreshed for this once (a second time would mean a loop). It refreshes by itself.
 * - `button`: nothing plays, but something would go — a song on a deck, the set history. His click: only he knows whether he needs it.
 * - `wait`: something plays (deck, pad, tagging clip), a recording is open or armed, a screen is open over the decks, or a deck's song has
 *   no identity yet (a cue set before it is hashed is not saved) — no button, so no click can cut sound or lose work.
 */
export function cushionExit(s: {
  decksLoaded: boolean
  /** a loaded deck whose song has no content hash yet */
  deckUnhashed: boolean
  anyPlaying: boolean
  recordingOpen: boolean
  screenOpen: boolean
  historyEntries: number
  alreadyReloaded: boolean
}): 'reload' | 'button' | 'wait' {
  if (s.anyPlaying || s.recordingOpen || s.screenOpen || s.deckUnhashed) return 'wait'
  if (s.decksLoaded || s.historyEntries > 0 || s.alreadyReloaded) return 'button'
  return 'reload'
}
