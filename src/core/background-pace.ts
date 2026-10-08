/**
 * Background analysis gives way to the music (v0.9.51).
 *
 * 07/10 Shalom: after every new version the library re-analyses, and anything he plays meanwhile skips and stutters until the queue
 * empties. The decks render on the audio thread, which needs a free CPU core at every block; the passes in `library.ts` kept several
 * busy at once — four hashers reading whole files, two decodes (each a full-track decode plus a Worker analysis), then the embedding and
 * vocal Workers. Nothing here stops the analysis: while a deck plays, the heavy jobs go one at a time across every pass, and each
 * one is followed by a rest as long as itself, so the background holds at most about half of one core. With no deck playing it runs
 * at full speed, exactly as before.
 *
 * The rest is the job's own length rather than a fixed number because the jobs differ by ~10x (a BPM pass ~1 s, an embedding ~8 s,
 * measured 25/09) — a fixed pause would starve the short ones or barely dent the long ones.
 */

/** A rest shorter than this is not worth a timer. */
export const MIN_REST_MS = 250

export interface Pacer {
  /** Runs `job` now if nothing plays; otherwise waits for the single slot and keeps it through a rest after the job. */
  run<T>(job: () => Promise<T>): Promise<T>
}

export function createPacer(deps: { isPlaying: () => boolean; now: () => number; sleep: (ms: number) => Promise<void> }): Pacer {
  let held = false
  const waiting: (() => void)[] = []
  // Wakes every waiter, not one: each re-checks for itself. Handing the slot straight to the next waiter kept the passes one at a time
  // for as long as they had work, long after the music stopped — caught by review, pinned by the "back to full speed" test.
  const release = () => {
    held = false
    for (const wake of waiting.splice(0)) wake()
  }
  return {
    async run<T>(job: () => Promise<T>): Promise<T> {
      // Checked once per job, not during it: a decode already running cannot be slowed, only the next one held back.
      if (!deps.isPlaying()) return job()
      while (held) {
        await new Promise<void>((r) => waiting.push(r))
        if (!deps.isPlaying()) return job()
      }
      held = true
      const start = deps.now()
      try {
        return await job()
      } finally {
        // Not awaited: the caller gets its result now (the row updates), only the *next* job waits out the rest.
        const rest = deps.isPlaying() ? Math.max(MIN_REST_MS, deps.now() - start) : 0
        if (rest > 0) void deps.sleep(rest).then(release)
        else release()
      }
    },
  }
}
