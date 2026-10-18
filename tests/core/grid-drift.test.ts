import { describe, expect, it } from 'vitest'
import { compareGrid, summarizeDrift, type DriftInput } from '@/core/grid-drift'

const base = (hand: DriftInput['hand'], detected: DriftInput['detected'], durationSec: number | null = 240): DriftInput => ({
  contentHash: 'h', name: 'x', hand, detected, durationSec,
})

describe('compareGrid', () => {
  it('the same grid is ok with zero error', () => {
    const r = compareGrid(base({ bpm: 128, offsetSec: 0.2, tempoByHand: false }, { bpm: 128, offsetSec: 0.2 }))
    expect(r.verdict).toBe('ok')
    expect(r.worstMs).toBeCloseTo(0, 6)
    expect(r.beatsFromFirst).toBe(0)
  })

  it('a 40 ms phase miss is drifting, a 10 ms one is not', () => {
    expect(compareGrid(base({ bpm: 120, offsetSec: 0.24, tempoByHand: false }, { bpm: 120, offsetSec: 0.2 })).verdict).toBe('drift')
    expect(compareGrid(base({ bpm: 120, offsetSec: 0.21, tempoByHand: false }, { bpm: 120, offsetSec: 0.2 })).verdict).toBe('ok')
  })

  it('a slightly different tempo shows up as error at the END of the song, not the start', () => {
    const r = compareGrid(base({ bpm: 128, offsetSec: 0.2, tempoByHand: false }, { bpm: 128.3, offsetSec: 0.2 }))
    expect(Math.abs(r.startErrMs ?? 99)).toBeLessThan(1)
    expect(r.verdict).toBe('drift')
  })

  it('a 1.5% tempo gap that adds up to whole beats by the end is still drift (the end error is not folded)', () => {
    const r = compareGrid(base({ bpm: 128, offsetSec: 0.2, tempoByHand: false }, { bpm: 129, offsetSec: 0.2 }, 240))
    expect(r.verdict).toBe('drift')
    expect(r.worstMs).toBeGreaterThan(1000)
  })

  it('no duration means the end cannot be measured: not comparable, never ok', () => {
    expect(compareGrid(base({ bpm: 128, offsetSec: 0.2, tempoByHand: false }, { bpm: 128, offsetSec: 0.2 }, null)).verdict).toBe('no-detection')
  })

  it('his "1" three beats after the detected first beat is not a phase error', () => {
    const p = 60 / 120
    const r = compareGrid(base({ bpm: 120, offsetSec: 0.2 + 3 * p, tempoByHand: false }, { bpm: 120, offsetSec: 0.2 }))
    expect(r.verdict).toBe('ok')
    expect(r.beatsFromFirst).toBe(3)
  })

  it('half or double tempo is named, not measured', () => {
    expect(compareGrid(base({ bpm: 150, offsetSec: 0, tempoByHand: true }, { bpm: 75, offsetSec: 0 })).verdict).toBe('octave')
    expect(compareGrid(base({ bpm: 140, offsetSec: 0, tempoByHand: true }, { bpm: 120, offsetSec: 0 })).verdict).toBe('differs')
  })

  it('nothing cached is counted as such, never as ok', () => {
    expect(compareGrid(base({ bpm: 120, offsetSec: 0, tempoByHand: false }, null)).verdict).toBe('no-detection')
  })
})

describe('summarizeDrift', () => {
  const mk = (n: number, hand: number): DriftInput[] =>
    Array.from({ length: n }, () => base({ bpm: 120, offsetSec: hand, tempoByHand: false }, { bpm: 120, offsetSec: 0 }))

  it('below the minimum sample it refuses to give a verdict', () => {
    expect(summarizeDrift(mk(5, 0.1).map(compareGrid)).verdict).toBe('not-enough-data')
  })

  it('over 15% off asks for the marking flow; under it asks for better detection', () => {
    const rows = [...mk(8, 0), ...mk(2, 0.05)].map(compareGrid) // 20% off
    expect(summarizeDrift(rows).verdict).toBe('build-marking')
    const fine = [...mk(9, 0), ...mk(1, 0.05)].map(compareGrid) // 10% off
    expect(summarizeDrift(fine).verdict).toBe('improve-detection')
  })

  it('no-detection songs are not in the denominator but are counted', () => {
    const rows = [...mk(10, 0).map(compareGrid), compareGrid(base({ bpm: 120, offsetSec: 0, tempoByHand: false }, null))]
    const s = summarizeDrift(rows)
    expect(s.comparable).toBe(10)
    expect(s.noDetection).toBe(1)
  })
})
