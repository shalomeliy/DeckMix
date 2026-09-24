import { describe, expect, it } from 'vitest'
import { GRID_CORRECTION_SCHEMA, ownerCorrection, resolveGridCorrection } from '@/core/grid-corrections.ts'

describe('resolveGridCorrection', () => {
  it('nothing stored is nothing, not a refusal', () => {
    expect(resolveGridCorrection(undefined)).toBeNull()
  })

  it('gives back exactly the grid the owner saved — bar line on beat 3 included', () => {
    const saved = ownerCorrection({ bpm: 120, offsetSec: 1.0 }, 1)
    expect(saved.source).toBe('owner')
    expect(resolveGridCorrection(saved)).toEqual({ grid: { bpm: 120, offsetSec: 1.0 } })
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
