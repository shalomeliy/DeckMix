import { describe, expect, it } from 'vitest'
import { resolveCacheEntry, type StoredAnalysisEntry } from '@/core/analysis-cache'
import type { TrackAnalysis } from '@/core/ports/analyzer'

function makeAnalysis(bpm: number): TrackAnalysis {
  return {
    peaks: new Float32Array(0),
    bands: new Float32Array(0),
    bpm,
    durationSec: 180,
    beatGrid: { bpm, offsetSec: 0 },
    beatGridConfirmed: true,
    key: null,
  }
}

function makeEntry(analyzerVersion: number, bpm = 128): StoredAnalysisEntry {
  return { contentHash: 'abc', analyzerVersion, analysis: makeAnalysis(bpm), cachedAt: 0 }
}

describe('resolveCacheEntry', () => {
  it('returns null when there is no stored entry', () => {
    expect(resolveCacheEntry(undefined, 1)).toBeNull()
  })

  it('returns the stored analysis when the version matches', () => {
    const entry = makeEntry(1, 128)
    expect(resolveCacheEntry(entry, 1)?.bpm).toBe(128)
  })

  it('treats a version mismatch as a miss, not the stale data', () => {
    const entry = makeEntry(1, 128)
    expect(resolveCacheEntry(entry, 2)).toBeNull()
  })
})
