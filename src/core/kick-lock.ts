/**
 * The incoming song waits, silent, until its kicks sit on the outgoing song's (v0.9.33, the owner, 07/10): "if you know how to get the
 * kicks on top of each other within a second even when they didn't start that way, why not do it while the volume is down, and only
 * bring the incoming song up once you see they sit together?"
 *
 * Why the join alone is not enough: it is worked out from the two play positions on the frame that crosses A's yellow line, but the seek
 * reaches the audio thread a few render quanta later, and a key-locked deck adds its own few ms. Measured after a jump (v0.9.33,
 * `verify-hotcue-sync-jump.mjs`): the first click up to ~30 ms off, which SYNC's 1 s loop then takes in over a few seconds — while B was
 * already rising on the crossfader.
 *
 * So after the join the caller asks this function once a frame what to do with B still held at zero. Pure: the phase gap comes in already
 * measured (`phaseDeltaSec` against the master), and the clock is any seconds.
 */

/** Same as SYNC's own deadband: below it the loop does nothing, so "locked" here means exactly "SYNC has nothing left to correct". */
export const KICK_LOCK_SEC = 0.004
/**
 * Until the audio thread has reported B's real position after the seek (an anchor every ~23 ms), the position read is the seek's own
 * target, and the gap would read as zero whatever was heard. Three anchors' worth.
 */
export const KICK_LOCK_SETTLE_SEC = 0.08
/**
 * Each correction while B is silent: a short speed nudge (`syncNudge`), at most 6% of the rate for half of it — ~7.5 ms of gap per nudge,
 * so 30 ms closes in about a second. A gap read *during* a nudge is half-corrected, so it is never taken as "locked".
 */
export const KICK_LOCK_NUDGE_SEC = 0.25
/** Past this many of A's bars a handoff goes on anyway — and says so — rather than leave the owner waiting on a lock that will not come. */
export const KICK_LOCK_MAX_BARS = 2
/**
 * A plain transition is screened by Mix Assist for a window of seconds after its join (`plainTransitionClashSec`, `plainMixEndInB`), so
 * it may move by at most this many bars: a lock not there in time moves the start to A's next yellow line (its bass swap counts whole
 * bars from the start), and at that line it goes, locked or not. Both screens are widened by the same bar.
 */
export const KICK_LOCK_PLAIN_SHIFT_BARS = 1

export type KickLockStep =
  | { kind: 'wait' }
  | { kind: 'nudge'; deltaSec: number }
  | { kind: 'locked' }
  /** No gap could be measured (SYNC turned off by hand, a deck lost its grid): nothing to wait for. */
  | { kind: 'unmeasured' }
  | { kind: 'timeout'; deltaSec: number }

export function kickLockStep(
  /** seconds since the join */
  sinceJoinSec: number,
  /** B's phase gap to A now, `null` when it cannot be measured */
  deltaSec: number | null,
  /** seconds since this gate's own last nudge (`Infinity` before the first) */
  sinceNudgeSec: number,
  /** how long the caller will hold B at all, from the join, in the same seconds as the two above */
  maxHoldSec: number,
): KickLockStep {
  if (sinceJoinSec < KICK_LOCK_SETTLE_SEC) return { kind: 'wait' }
  if (deltaSec == null) return { kind: 'unmeasured' }
  const nudging = sinceNudgeSec < KICK_LOCK_NUDGE_SEC
  if (!nudging && Math.abs(deltaSec) < KICK_LOCK_SEC) return { kind: 'locked' }
  if (sinceJoinSec >= maxHoldSec) return { kind: 'timeout', deltaSec }
  if (nudging) return { kind: 'wait' }
  return { kind: 'nudge', deltaSec }
}

/**
 * A plain transition whose lock came within this long of its original start keeps that start: B is at ~3% of the way to the middle
 * (2-bar rise at 128 BPM), no jump anyone hears. Later than that, the start moves a bar (`KICK_LOCK_PLAIN_SHIFT_BARS`).
 */
export const KICK_LOCK_KEEP_START_SEC = 0.25

/**
 * A handoff runs on A's own seconds, which kept moving during the wait: B's crossfader would jump to wherever the plan has got to.
 * Instead it catches up over one beat from the lock — continuous from zero. (The vocal swap is not held at all: B is meant to be heard
 * from its voice line, and its LOW — the kick — is killed until the swap anyway.)
 */
export function catchUpFactor(sinceLockSec: number, beatSec: number): number {
  if (beatSec <= 0) return 1
  return Math.min(1, Math.max(0, sinceLockSec / beatSec))
}
