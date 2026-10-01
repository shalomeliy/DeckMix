import { describe, expect, it } from 'vitest'
import { OVERVIEW_STRIDE, overviewColumns, overviewLoopBox, overviewSecAt } from '@/core/waveform-overview.ts'

/** `n` quiet buckets (min/max interleaved) with one loud one at `loudAt`. */
function peaksWithSpike(n: number, loudAt: number): Float32Array {
  const p = new Float32Array(n * 2)
  for (let b = 0; b < n; b++) {
    p[b * 2] = -0.01
    p[b * 2 + 1] = 0.01
  }
  p[loudAt * 2] = -0.9
  p[loudAt * 2 + 1] = 0.8
  return p
}

describe('overviewColumns', () => {
  it('keeps a one-bucket spike wherever it falls — every bucket lands in a column', () => {
    // 6 min at ~50 buckets/s folded into 420 columns: ~43 buckets per column.
    const n = 18000
    for (const at of [0, 1, 42, 43, 9001, n - 1]) {
      const cols = overviewColumns(peaksWithSpike(n, at), null, 420)
      let max = 0
      let min = 0
      for (let c = 0; c < 420; c++) {
        max = Math.max(max, cols[c * OVERVIEW_STRIDE + 1])
        min = Math.min(min, cols[c * OVERVIEW_STRIDE])
      }
      expect(max, `spike at bucket ${at}`).toBeCloseTo(0.8)
      expect(min, `spike at bucket ${at}`).toBeCloseTo(-0.9)
    }
  })

  it('puts the spike in the column that matches its place in the track', () => {
    const cols = overviewColumns(peaksWithSpike(1000, 750), null, 100)
    expect(cols[75 * OVERVIEW_STRIDE + 1]).toBeCloseTo(0.8)
    expect(cols[74 * OVERVIEW_STRIDE + 1]).toBeCloseTo(0.01)
  })

  it('averages the bands, so a column is not louder just for covering more buckets', () => {
    const n = 400
    const bands = new Float32Array(n * 3)
    for (let b = 0; b < n; b++) bands.set([0.3, 0.2, 0.1], b * 3)
    for (const width of [4, 40, 400]) {
      const cols = overviewColumns(new Float32Array(n * 2), bands, width)
      expect(cols[2]).toBeCloseTo(0.3)
      expect(cols[3]).toBeCloseTo(0.2)
      expect(cols[4]).toBeCloseTo(0.1)
    }
  })

  it('leaves no empty column when the strip is wider than the track has buckets', () => {
    const cols = overviewColumns(peaksWithSpike(10, 3), null, 50)
    for (let c = 0; c < 50; c++) expect(cols[c * OVERVIEW_STRIDE + 1]).toBeGreaterThan(0)
  })

  it('returns nothing to draw for no width or no peaks', () => {
    expect(overviewColumns(peaksWithSpike(10, 3), null, 0).length).toBe(0)
    expect(overviewColumns(new Float32Array(0), null, 10).every((v) => v === 0)).toBe(true)
  })
})

describe('overviewSecAt', () => {
  it('maps the strip onto the track and clamps outside it', () => {
    expect(overviewSecAt(210, 420, 300)).toBe(150)
    expect(overviewSecAt(-5, 420, 300)).toBe(0)
    expect(overviewSecAt(500, 420, 300)).toBe(300)
    expect(overviewSecAt(10, 0, 300)).toBe(0)
  })
})

describe('overviewLoopBox', () => {
  it('places a loop as a share of the track', () => {
    const b = overviewLoopBox({ startSec: 60, endSec: 90 }, 300)!
    expect(b.leftPct).toBeCloseTo(20)
    expect(b.widthPct).toBeCloseTo(10)
  })
  it('never lets a short loop vanish — a 2 s loop in a 6 min track is still drawn', () => {
    const b = overviewLoopBox({ startSec: 100, endSec: 102 }, 360)!
    expect(b.widthPct).toBeGreaterThanOrEqual(0.8)
  })
  it('stays inside the strip at the end of the track', () => {
    const b = overviewLoopBox({ startSec: 299.9, endSec: 300 }, 300)!
    expect(b.leftPct + b.widthPct).toBeLessThanOrEqual(100 + 1e-9)
  })
  it('draws nothing without a loop, a track, or a real range', () => {
    expect(overviewLoopBox(null, 300)).toBeNull()
    expect(overviewLoopBox({ startSec: 1, endSec: 2 }, 0)).toBeNull()
    expect(overviewLoopBox({ startSec: 5, endSec: 5 }, 300)).toBeNull()
    expect(overviewLoopBox({ startSec: 9, endSec: 3 }, 300)).toBeNull()
  })
})
