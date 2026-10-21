import { type EnergyProfile } from '@/core/structure'

/**
 * v0.12.16, the owner (21/10): "A starts to rise in bass and drums, and right at the rise the mix begins with a song that is quiet, only
 * singing, and the music comes in later. That drops the energy in the middle of the rise." A plain mix joins on A's next phrase start, and
 * a build-up often sits right behind a phrase start; B's entry, chosen on its own contour, can be a quiet start. Neither side knows about
 * the other, so the pair cuts a rise short.
 *
 * Read from the two songs' energy contours (`analyzeEnergyProfile`, each normalised to its own near-peak): the mix cuts a rise when A is
 * about to get clearly louder within `LOOKAHEAD_SEC` of the join AND B's first stretch is far quieter than where A was heading.
 * A heuristic on loudness, not on what is played — the notice that says a join moved says so in those words.
 */

/** How far ahead of the join A's rise is looked for: about 8 bars at 120 BPM, a build-up. */
export const LOOKAHEAD_SEC = 16
/** What A's level before the join is averaged over. */
const BEFORE_SEC = 6
/** A's top ahead must exceed its level before the join by this share … */
export const RISE_RATIO = 1.25
/** … and by this much of its own near-peak, so a rise of 0.02 to 0.03 in a near-silent stretch is not a build-up. */
export const RISE_MIN_ABS = 0.08
/** B's first stretch under this share of where A is heading is "quiet" — the owner's "too quiet". */
export const QUIET_SHARE = 0.6

export interface RiseVerdict {
  /** the join cuts a rise of A short with a quiet B */
  cuts: boolean
  /** A's top level ahead over its level before the join (0 when unknown) */
  riseRatio: number
  /** B's first stretch over A's top level ahead (0 when unknown) */
  entryShare: number
}

function meanLevel(p: EnergyProfile, fromSec: number, toSec: number): number {
  if (p.contour.length === 0 || p.peak <= 1e-6 || p.windowSec <= 0) return 0
  const lo = Math.max(0, Math.floor(fromSec / p.windowSec))
  const hi = Math.min(p.contour.length - 1, Math.max(lo, Math.ceil(toSec / p.windowSec) - 1))
  let sum = 0
  for (let i = lo; i <= hi; i++) sum += p.contour[i]
  return sum / (hi - lo + 1) / p.peak
}

function topLevel(p: EnergyProfile, fromSec: number, toSec: number): number {
  if (p.contour.length === 0 || p.peak <= 1e-6 || p.windowSec <= 0) return 0
  const lo = Math.max(0, Math.floor(fromSec / p.windowSec))
  const hi = Math.min(p.contour.length - 1, Math.max(lo, Math.ceil(toSec / p.windowSec) - 1))
  let top = 0
  for (let i = lo; i <= hi; i++) top = Math.max(top, p.contour[i])
  return top / p.peak
}

/** Does joining B at `entrySec` as A reaches `joinSec` cut a rise of A short? `mixSec` is how much of B's start the mix plays. */
export function riseCutByQuietEntry(a: EnergyProfile, joinSec: number, b: EnergyProfile, entrySec: number, mixSec: number): RiseVerdict {
  const before = meanLevel(a, joinSec - BEFORE_SEC, joinSec)
  const top = topLevel(a, joinSec, joinSec + LOOKAHEAD_SEC)
  if (before <= 1e-6 || top <= 1e-6) return { cuts: false, riseRatio: 0, entryShare: 0 }
  const riseRatio = top / before
  const entryShare = meanLevel(b, entrySec, entrySec + mixSec) / top
  const rising = riseRatio >= RISE_RATIO && top - before >= RISE_MIN_ABS
  return { cuts: rising && entryShare < QUIET_SHARE, riseRatio, entryShare }
}

/** Phrase starts to try after the first one before giving up: 6 phrases of 8 bars is about a minute and a half. */
export const MAX_JOIN_MOVES = 6

/**
 * The first phrase start at or after `firstSec` whose join does not cut a rise: `nextStart` gives the phrase start after a second (null when
 * there is none left). `moved` is false when `firstSec` itself was fine; `stuck` when every try cut one — then the first is kept and the caller says so.
 */
export function joinWithoutCut(
  firstSec: number,
  nextStart: (afterSec: number) => number | null,
  cuts: (joinSec: number) => RiseVerdict,
): { sec: number; moved: boolean; stuck: boolean; verdict: RiseVerdict } {
  const first = cuts(firstSec)
  if (!first.cuts) return { sec: firstSec, moved: false, stuck: false, verdict: first }
  let sec = firstSec
  for (let i = 0; i < MAX_JOIN_MOVES; i++) {
    const next = nextStart(sec)
    if (next == null || next <= sec) break
    sec = next
    const v = cuts(sec)
    if (!v.cuts) return { sec, moved: true, stuck: false, verdict: v }
  }
  return { sec: firstSec, moved: false, stuck: true, verdict: first }
}
