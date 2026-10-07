import { describe, expect, it } from 'vitest'
import {
  catchUpFactor,
  KICK_LOCK_MAX_BARS,
  KICK_LOCK_NUDGE_SEC,
  KICK_LOCK_SEC,
  KICK_LOCK_SETTLE_SEC,
  kickLockStep,
} from '@/core/kick-lock'

const BAR = 1.875 // 128 BPM

describe('kickLockStep: B stays down until its kicks sit on A (v0.9.33, the owner 07/10)', () => {
  it('waits for the audio thread to report the real position before trusting a zero gap', () => {
    expect(kickLockStep(KICK_LOCK_SETTLE_SEC / 2, 0, Infinity, 2 * BAR)).toEqual({ kind: 'wait' })
  })
  it('locks at once when the join already landed within the deadband', () => {
    expect(kickLockStep(0.1, 0.002, Infinity, 2 * BAR)).toEqual({ kind: 'locked' })
    expect(kickLockStep(0.1, -0.0039, Infinity, 2 * BAR)).toEqual({ kind: 'locked' })
  })
  it('nudges a gap the owner would hear (the 20-30 ms measured after a seek), in its direction', () => {
    expect(kickLockStep(0.1, 0.025, Infinity, 2 * BAR)).toEqual({ kind: 'nudge', deltaSec: 0.025 })
    expect(kickLockStep(0.1, -0.03, Infinity, 2 * BAR)).toEqual({ kind: 'nudge', deltaSec: -0.03 })
  })
  it('never calls a gap read in the middle of its own nudge "locked" — it is half corrected', () => {
    expect(kickLockStep(0.2, 0.001, KICK_LOCK_NUDGE_SEC / 2, 2 * BAR)).toEqual({ kind: 'wait' })
    expect(kickLockStep(0.2, 0.001, KICK_LOCK_NUDGE_SEC, 2 * BAR)).toEqual({ kind: 'locked' })
  })
  it('goes on after two bars rather than hold the mix forever, with the gap it gave up on', () => {
    expect(kickLockStep(KICK_LOCK_MAX_BARS * BAR, 0.02, Infinity, KICK_LOCK_MAX_BARS * BAR)).toEqual({ kind: 'timeout', deltaSec: 0.02 })
    expect(kickLockStep(KICK_LOCK_MAX_BARS * BAR, 0.02, 0.01, KICK_LOCK_MAX_BARS * BAR)).toEqual({ kind: 'timeout', deltaSec: 0.02 })
  })
  it('a gap that cannot be measured (SYNC turned off) does not hold the mix', () => {
    expect(kickLockStep(0.1, null, Infinity, 2 * BAR)).toEqual({ kind: 'unmeasured' })
  })
  it('the deadband is SYNC’s own: locked means SYNC has nothing left to correct', () => {
    expect(KICK_LOCK_SEC).toBe(0.004)
  })
  it('a 30 ms gap closes inside the two bars: each nudge takes ~7.5 ms (6% for half its window)', () => {
    const perNudge = 0.06 * (KICK_LOCK_NUDGE_SEC / 2)
    expect(Math.ceil(0.03 / perNudge) * KICK_LOCK_NUDGE_SEC).toBeLessThan(KICK_LOCK_MAX_BARS * BAR)
  })
})

describe('catchUpFactor: a handoff catches up over one beat from the lock, never jumping', () => {
  it('starts at zero and reaches one after a beat', () => {
    expect(catchUpFactor(0, 0.5)).toBe(0)
    expect(catchUpFactor(0.25, 0.5)).toBeCloseTo(0.5)
    expect(catchUpFactor(2, 0.5)).toBe(1)
  })
})
