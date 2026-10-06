import { describe, expect, it } from 'vitest'
import { GRID_CORRECTION_SCHEMA, ownerCorrection, reconcileSavedGrid, resolveGridCorrection } from '@/core/grid-corrections.ts'

describe('resolveGridCorrection', () => {
  it('nothing stored is nothing, not a refusal', () => {
    expect(resolveGridCorrection(undefined)).toBeNull()
  })

  it('gives back exactly the grid the owner saved — bar line on beat 3 included', () => {
    const saved = ownerCorrection({ bpm: 120, offsetSec: 1.0 }, 1)
    expect(saved.source).toBe('owner')
    expect(resolveGridCorrection(saved)).toEqual({ grid: { bpm: 120, offsetSec: 1.0 }, tempoByHand: false })
  })

  it('refuses a record from a format it does not know, and says which', () => {
    const r = resolveGridCorrection({ ...ownerCorrection({ bpm: 120, offsetSec: 0 }, 1), schema: GRID_CORRECTION_SCHEMA + 1 })
    expect(r).toEqual({ refused: `unknown format (${GRID_CORRECTION_SCHEMA + 1})` })
  })

  it.each([
    [{ bpm: 0, offsetSec: 0 }],
    [{ bpm: Number.NaN, offsetSec: 0 }],
    [{ bpm: 120, offsetSec: -1 }],
  ])('refuses a grid that cannot be drawn: %o', (grid) => {
    expect(resolveGridCorrection({ schema: GRID_CORRECTION_SCHEMA, grid, source: 'owner', savedAt: 1 })).toEqual({
      refused: 'damaged record',
    })
  })
})

describe('reconcileSavedGrid (v0.9.45)', () => {
  it('a grid saved at 75 under a typed 150 is recounted to 150, its bar line kept — the deck said 75 while the row said 150', () => {
    const r = reconcileSavedGrid({ bpm: 75, offsetSec: 0.4 }, 150)
    expect(r.outcome).toBe('recounted')
    expect(r.grid.bpm).toBe(150)
    expect(r.grid.offsetSec).toBeCloseTo(0.4, 9)
  })

  it('and the other way: a grid at 150 under a typed 75 is halved', () => {
    expect(reconcileSavedGrid({ bpm: 150, offsetSec: 0.4 }, 75)).toEqual({ grid: { bpm: 75, offsetSec: 0.4 }, outcome: 'recounted' })
  })

  it("keeps the grid's own finer number when it is the same tempo: 124.93 under a typed 125", () => {
    expect(reconcileSavedGrid({ bpm: 124.93, offsetSec: 0.1 }, 125)).toEqual({ grid: { bpm: 124.93, offsetSec: 0.1 }, outcome: 'same' })
  })

  it('a refined octave keeps its fine number: 74.9 under a typed 150 becomes 149.8, not 150', () => {
    expect(reconcileSavedGrid({ bpm: 74.9, offsetSec: 0 }, 150).grid.bpm).toBeCloseTo(149.8, 9)
  })

  it('a different tempo is not guessed at: the checked grid stays, and the caller is told they differ', () => {
    expect(reconcileSavedGrid({ bpm: 125, offsetSec: 0.1 }, 100)).toEqual({ grid: { bpm: 125, offsetSec: 0.1 }, outcome: 'differs' })
  })
})

describe('tempoByHand (v0.9.45)', () => {
  it('is kept only when the tempo was set by hand, and reads back', () => {
    expect(ownerCorrection({ bpm: 75, offsetSec: 0 }, 1, true).tempoByHand).toBe(true)
    expect('tempoByHand' in ownerCorrection({ bpm: 75, offsetSec: 0 }, 1)).toBe(false)
    expect(resolveGridCorrection(ownerCorrection({ bpm: 75, offsetSec: 0 }, 1, true))).toEqual({ grid: { bpm: 75, offsetSec: 0 }, tempoByHand: true })
  })

  it('a record from before the flag reads as not by hand', () => {
    expect(resolveGridCorrection({ schema: GRID_CORRECTION_SCHEMA, grid: { bpm: 75, offsetSec: 0 }, source: 'owner', savedAt: 1 })).toEqual({
      grid: { bpm: 75, offsetSec: 0 },
      tempoByHand: false,
    })
  })
})
