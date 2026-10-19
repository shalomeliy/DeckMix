import { describe, expect, it } from 'vitest'
import { barLineAtNearestBeat, checkStartSec, countUnchecked, nextInQueue, queueOrder, queueRemaining } from '@/core/bar-one-queue'

const t = (id: string, genre?: string, contentHash?: string) => ({ id, genre, contentHash })

describe('queueOrder', () => {
  it('puts Hip Hop and Mizrahi first and keeps library order inside each group', () => {
    const o = queueOrder([t('1', 'Techno'), t('2', 'Hip Hop'), t('3', 'House'), t('4', 'Mizrahi')], new Set())
    expect(o.map((x) => x.id)).toEqual(['2', '4', '1', '3'])
  })

  it('leaves out songs already checked, and keeps a song with no hash yet', () => {
    const o = queueOrder([t('1', 'Techno', 'a'), t('2', 'Techno', 'b'), t('3', 'Techno')], new Set(['a']))
    expect(o.map((x) => x.id)).toEqual(['2', '3'])
  })
})

describe('nextInQueue / queueRemaining', () => {
  const order = [t('1', 'x', 'a'), t('2', 'x', 'b'), t('3', 'x', 'c')]
  it('walks the order and skips visited songs', () => {
    expect(nextInQueue(order, new Set(['1']))?.id).toBe('2')
    expect(nextInQueue(order, new Set(['1', '2', '3']))).toBeNull()
  })
  it('counts only what is still ahead, minus hashes found checked meanwhile', () => {
    expect(queueRemaining(order, new Set(['1']), new Set(['c']))).toBe(1)
  })
})

describe('checkStartSec', () => {
  it('starts on a bar line after 30% of the song', () => {
    const grid = { bpm: 120, offsetSec: 0.1 } // bar = 2 s
    const s = checkStartSec(200, grid)
    expect(s).toBeGreaterThanOrEqual(60)
    expect(s).toBeLessThan(62.1)
    expect(((s - 0.1) / 2) % 1).toBeCloseTo(0, 6)
  })
  it('without a grid it is the plain point', () => {
    expect(checkStartSec(200, null)).toBe(60)
  })
})

describe('barLineAtNearestBeat', () => {
  const grid = { bpm: 120, offsetSec: 0.013 } // beat = 0.5 s
  it('a press 150 ms late lands on the beat it meant, not 150 ms after it', () => {
    const g = barLineAtNearestBeat(grid, 10.013 + 0.15)
    expect(g.bpm).toBe(120)
    expect(((10.013 - g.offsetSec) / 0.5) % 1 === 0 || Math.abs((((10.013 - g.offsetSec) / 0.5) % 1)) < 1e-6).toBe(true)
  })
  it('an early press picks the beat it was heading for', () => {
    const g = barLineAtNearestBeat(grid, 10.013 - 0.1)
    expect(Math.abs((((10.013 - g.offsetSec) / 2) % 1) || 0)).toBeLessThan(1e-6)
  })
  it('keeps the detector beat phase within a hair: only the bar line moves', () => {
    const g = barLineAtNearestBeat(grid, 33.3)
    const beatPhase = (((g.offsetSec - grid.offsetSec) / 0.5) % 1 + 1) % 1
    expect(Math.min(beatPhase, 1 - beatPhase)).toBeLessThan(1e-6)
  })
})

describe('countUnchecked', () => {
  it('counts songs with a hash and no saved grid, and keeps unidentified songs apart', () => {
    const tracks = [t('1', 'x', 'a'), t('2', 'x', 'b'), t('3', 'x', 'c'), t('4', 'x')]
    expect(countUnchecked(tracks, new Set(['a']))).toEqual({ unchecked: 2, unidentified: 1 })
  })
  it('an empty library, or every song checked, is zero', () => {
    expect(countUnchecked([], new Set())).toEqual({ unchecked: 0, unidentified: 0 })
    expect(countUnchecked([t('1', 'x', 'a')], new Set(['a']))).toEqual({ unchecked: 0, unidentified: 0 })
  })
})
