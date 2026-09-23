import { describe, expect, it } from 'vitest'
import {
  analyzeEnergyProfile,
  energyProximity,
  findTransitionCandidates,
  nextCandidateFrom,
  resolveExitPointSec,
  type EnergyProfile,
  type StructureCandidate,
} from '@/core/structure'
import type { BeatGrid } from '@/core/types'

/**
 * `bands` is interleaved [low, mid, high] RMS per bucket (`analyzeWaveform`,
 * `platform/analyzer-js/analyze.ts`). These fixtures put the whole energy
 * value into the low band and leave mid/high at zero — the function only
 * ever looks at the sum of all three, so this is equivalent to a real track
 * for testing purposes without needing real audio.
 *
 * `secondsOfLevel` builds one bucket per 0.1s (10 buckets/sec — finer than
 * the function's own 1s analysis window, matching how real `bands` arrays
 * are always denser than the window they get downsampled into).
 */
function secondsOfLevel(...levels: { sec: number; level: number }[]): {
  bands: Float32Array
  durationSec: number
} {
  const bucketsPerSec = 10
  const totalSec = levels.reduce((a, l) => a + l.sec, 0)
  const bucketCount = Math.round(totalSec * bucketsPerSec)
  const bands = new Float32Array(bucketCount * 3)
  let bucket = 0
  for (const { sec, level } of levels) {
    const n = Math.round(sec * bucketsPerSec)
    for (let i = 0; i < n && bucket < bucketCount; i++, bucket++) {
      bands[bucket * 3] = level
    }
  }
  return { bands, durationSec: totalSec }
}

describe('findTransitionCandidates', () => {
  it('finds a rise out of a quiet intro, and never an "into the outro" candidate', () => {
    // v0.5.1: the dedicated end-of-track scan was removed outright — every
    // track fades or thins out somewhere in its last few seconds, so that
    // scan always fired trivially and never pointed at a useful mix point.
    // This fixture's own 5s "quiet outro" tail sits inside `END_GUARD_SEC`
    // and must never produce a candidate of any kind.
    const { bands, durationSec } = secondsOfLevel(
      { sec: 5, level: 0.1 }, // quiet intro
      { sec: 40, level: 1.0 }, // loud body
      { sec: 5, level: 0.1 }, // quiet outro tail
    )
    const candidates = findTransitionCandidates(bands, durationSec, null)
    const builds = candidates.find((c) => c.reason === 'energy-builds')
    expect(builds?.sec).toBe(5)
    expect(candidates.every((c) => c.reason === 'energy-builds')).toBe(true)
  })

  it('a track that is loud from the first second has no "builds" candidate', () => {
    // Nothing precedes second 0 to have risen from — a candidate there would
    // overstate what the heuristic found, which is exactly what this
    // function must never do (ROADMAP.md v0.4.6's honesty requirement).
    const { bands, durationSec } = secondsOfLevel({ sec: 30, level: 1.0 })
    const candidates = findTransitionCandidates(bands, durationSec, null)
    expect(candidates.find((c) => c.reason === 'energy-builds')).toBeUndefined()
  })

  it('a uniformly flat track (loud or quiet) returns no candidates at all', () => {
    const loud = secondsOfLevel({ sec: 30, level: 1.0 })
    const quiet = secondsOfLevel({ sec: 30, level: 0.1 })
    expect(findTransitionCandidates(loud.bands, loud.durationSec, null)).toEqual([])
    expect(findTransitionCandidates(quiet.bands, quiet.durationSec, null)).toEqual([])
  })

  it('finds a mid-track breakdown that never crosses the global near-peak threshold', () => {
    // v0.5.1's whole point: a loudness-war master never dips below 55% of its
    // own peak anywhere, including its real breakdown — the dip here only
    // goes to 65% of the surrounding level (never below `ENERGY_THRESHOLD_RATIO`
    // = 55%, so the old global-threshold scan would have missed it entirely),
    // but it is still a clear 35% drop relative to the 15s that led into it.
    const { bands, durationSec } = secondsOfLevel(
      { sec: 10, level: 1.0 }, // open
      { sec: 20, level: 1.0 }, // loud body — builds the local baseline
      { sec: 6, level: 0.65 }, // breakdown: 35% below its own local baseline, never below the global 55% floor
      { sec: 20, level: 1.0 }, // loud body again
    )
    const candidates = findTransitionCandidates(bands, durationSec, null)
    const drop = candidates.find((c) => c.reason === 'quiet-passage')
    expect(drop?.sec).toBe(30)
  })

  it('finds a mid-track lift — a rise into a fuller section, not just at the very start', () => {
    const { bands, durationSec } = secondsOfLevel(
      { sec: 15, level: 0.6 }, // moderate open (never below the global 55% floor, so no "builds" candidate)
      { sec: 20, level: 1.0 }, // lifts to full energy
      { sec: 20, level: 1.0 }, // stays there
    )
    const candidates = findTransitionCandidates(bands, durationSec, null)
    expect(candidates.find((c) => c.reason === 'energy-builds')).toBeUndefined()
    const lift = candidates.find((c) => c.reason === 'energy-lifts')
    expect(lift?.sec).toBe(15)
  })

  it('returns multiple well-separated mid-track candidates, not just the first', () => {
    const { bands, durationSec } = secondsOfLevel(
      { sec: 15, level: 1.0 }, // open
      { sec: 6, level: 0.6 }, // breakdown 1
      { sec: 20, level: 1.0 }, // recovery — long enough to rebuild the local baseline
      { sec: 6, level: 0.6 }, // breakdown 2
      { sec: 20, level: 1.0 }, // tail
    )
    const candidates = findTransitionCandidates(bands, durationSec, null)
    const drops = candidates.filter((c) => c.reason === 'quiet-passage').map((c) => c.sec)
    expect(drops).toEqual([15, 41])
  })

  it('quantizes candidates to the beat grid when one is given', () => {
    const { bands, durationSec } = secondsOfLevel(
      { sec: 5, level: 0.1 },
      { sec: 20, level: 1.0 },
      { sec: 5, level: 0.1 },
    )
    const grid: BeatGrid = { bpm: 120, offsetSec: 0.1 } // beat every 0.5s, offset by 0.1s
    const candidates = findTransitionCandidates(bands, durationSec, grid)
    const builds = candidates.find((c) => c.reason === 'energy-builds')
    // Unquantized this would be exactly 5; on this grid the nearest beat is 5.1.
    expect(builds?.sec).toBeCloseTo(5.1, 5)
  })

  it('an empty bands array returns no candidates rather than throwing', () => {
    expect(findTransitionCandidates(new Float32Array(0), 0, null)).toEqual([])
  })
})

describe('nextCandidateFrom', () => {
  const candidates: StructureCandidate[] = [
    { sec: 10, reason: 'energy-builds' },
    { sec: 40, reason: 'quiet-passage' },
    { sec: 70, reason: 'energy-lifts' },
  ]

  it('picks the earliest candidate at or after the given position', () => {
    expect(nextCandidateFrom(candidates, 20)?.sec).toBe(40)
  })

  it('includes a candidate exactly at the given position', () => {
    expect(nextCandidateFrom(candidates, 40)?.sec).toBe(40)
  })

  it('returns null when nothing is left ahead — never a guess', () => {
    expect(nextCandidateFrom(candidates, 71)).toBeNull()
  })

  it('returns null for an empty candidate list', () => {
    expect(nextCandidateFrom([], 0)).toBeNull()
  })
})

describe('resolveExitPointSec (v0.8.15, regression pin)', () => {
  const candidates: StructureCandidate[] = [
    { sec: 10, reason: 'energy-builds' },
    { sec: 40, reason: 'quiet-passage' },
  ]

  it('uses the next candidate when one exists ahead', () => {
    expect(resolveExitPointSec(candidates, 20)).toBe(40)
  })

  // The bug: a transition started past every candidate used to compute
  // `exitPointSec` as `null` here, which silently skipped the rating prompt
  // in `finishTransition` (controls.ts) — found live, 23/09.
  it('falls back to the live position — never null — when nothing is left ahead', () => {
    expect(resolveExitPointSec(candidates, 71)).toBe(71)
  })

  it('falls back to the live position for an empty candidate list too', () => {
    expect(resolveExitPointSec([], 33.5)).toBe(33.5)
  })
})

/** `analyzeEnergyProfile` over the same fixture builder the candidate tests above use. */
function profileOfLevel(...levels: { sec: number; level: number }[]) {
  const { bands, durationSec } = secondsOfLevel(...levels)
  return analyzeEnergyProfile(bands, durationSec)
}

describe('energyProximity', () => {
  it('reads "close" when both tracks sit at the same near-peak-relative level', () => {
    const outgoing = profileOfLevel({ sec: 20, level: 1.0 })
    const incoming = profileOfLevel({ sec: 20, level: 1.0 })
    expect(energyProximity(outgoing, 10, incoming, 10)).toBe('close')
  })

  it('reads "louder" when the incoming candidate point is well above the outgoing deck\'s current level', () => {
    // outgoing deck is currently in its own quiet half; incoming candidate
    // sits in its own loud half — both relative to each track's own peak.
    const outgoing = profileOfLevel({ sec: 10, level: 1.0 }, { sec: 10, level: 0.1 })
    const incoming = profileOfLevel({ sec: 10, level: 0.1 }, { sec: 10, level: 1.0 })
    expect(energyProximity(outgoing, 15, incoming, 15)).toBe('louder')
  })

  it('reads "quieter" when the incoming candidate point is well below the outgoing deck\'s current level', () => {
    const outgoing = profileOfLevel({ sec: 10, level: 1.0 }, { sec: 10, level: 1.0 })
    const incoming = profileOfLevel({ sec: 10, level: 1.0 }, { sec: 10, level: 0.1 })
    expect(energyProximity(outgoing, 2, incoming, 15)).toBe('quieter')
  })

  it('returns null — never a guessed "close" — when the outgoing deck has no profile yet', () => {
    const incoming = profileOfLevel({ sec: 20, level: 1.0 })
    expect(energyProximity(null, 5, incoming, 5)).toBeNull()
  })

  it('returns null when the outgoing deck\'s own analysis is empty (too short/no data)', () => {
    const outgoing = analyzeEnergyProfile(new Float32Array(0), 0)
    const incoming = profileOfLevel({ sec: 20, level: 1.0 })
    expect(energyProximity(outgoing, 0, incoming, 5)).toBeNull()
  })

  it('returns null when the outgoing deck is silent (near-peak level is ~0)', () => {
    const outgoing = profileOfLevel({ sec: 20, level: 0 })
    const incoming = profileOfLevel({ sec: 20, level: 1.0 })
    expect(energyProximity(outgoing, 5, incoming, 5)).toBeNull()
  })

  it('returns null when the incoming candidate track has no usable contour', () => {
    const outgoing = profileOfLevel({ sec: 20, level: 1.0 })
    const incoming = analyzeEnergyProfile(new Float32Array(0), 0)
    expect(energyProximity(outgoing, 5, incoming, 5)).toBeNull()
  })

  it('regression: recovers the correct window even when windowSec is not an exact float', () => {
    // `findTransitionCandidates` generates a candidate's `sec` as
    // `i * windowSec`. When `windowSec` isn't a "nice" float (real analysis
    // on real audio almost never produces one — this exact combination was
    // found by brute-forcing realistic duration/bucket-count pairs), dividing
    // that `sec` back by the same `windowSec` can land a hair under the
    // intended integer index: `Math.floor(2.5995 / 0.8665)` is 2, not 3,
    // even though `3 * 0.8665 === 2.5995`. `levelAt` (core/structure.ts) must
    // use `Math.round`, not `Math.floor`, or it silently reads the *previous*
    // window — exactly the bug a real browser run caught (a loud candidate
    // reading "quieter" instead of "close" against a flat reference track).
    const windowSec = 0.8665
    const incoming: EnergyProfile = { contour: [0.1, 0.1, 0.1, 1.0], peak: 1.0, windowSec }
    const candidateSec = 3 * windowSec // the exact `i * windowSec` shape a real candidate carries
    const outgoing: EnergyProfile = { contour: [1.0], peak: 1.0, windowSec: 1 }
    // The candidate sits in incoming's *last* window (level 1.0, same as
    // outgoing) — a correct index recovery reads "close"; the old
    // `Math.floor` bug would instead read the second-to-last window (level
    // 0.1) and wrongly call it "quieter".
    expect(energyProximity(outgoing, 0, incoming, candidateSec)).toBe('close')
  })
})
