/**
 * Whether a song is being read and decoded for a deck right now (v0.9.61).
 *
 * Measured 08/10 on the owner's PC with 40 songs: loading deck B while A played took 9.0 s during the background analysis and 2.0 s
 * after it; the step that grew was the decode (2.5-3.5 s of it, against 0.06 s reading and 0.03 s hashing). The decode runs on the
 * CPU the analysis jobs were using, so the background passes (`core/background-pace.ts`) start no new job while this says a deck is
 * loading. A job already running is not stopped — it cannot be — which is why this narrows the gap and does not close it.
 * Counted, not a flag: both decks can load at once, and the first to finish must not release the other.
 */
let loading = 0

export function beginDeckLoad(): void {
  loading++
}

export function endDeckLoad(): void {
  loading = Math.max(0, loading - 1)
}

export function isDeckLoading(): boolean {
  return loading > 0
}
