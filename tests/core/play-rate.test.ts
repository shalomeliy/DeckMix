import { describe, expect, it } from 'vitest'
import { centreBpm, deckRate, rowBpm, speedPercent } from '@/core/constants'
import { matchesColumnQuery, matchesQuery } from '@/core/library-search'
import { sortTracks } from '@/core/library-sort'
import { matchesColumnFilters } from '@/core/library-filter'
import { mixRecommendations, type DeckMixState } from '@/core/recommend'
import { findSimilarTracks } from '@/core/embedding-search'
import type { Track } from '@/core/types'

/**
 * v0.9.47: a speed the owner saved becomes the track's own. Shalom saved a slower speed for a 150 BPM track and the row went on saying
 * 150 while the deck's fader sat down — every reader of the row has to count from the saved speed, and the fader's centre is it.
 */
const track = (id: string, bpm?: number, playRate?: number): Track =>
  ({ id, name: id, path: id, kind: 'audio/wav', handle: {} as FileSystemFileHandle, bpm, playRate }) as Track

describe('saved speed (v0.9.47)', () => {
  it('the row shows the file BPM times the saved speed', () => {
    expect(rowBpm(track('a', 150, 0.92))).toBeCloseTo(138)
    expect(rowBpm(track('a', 150))).toBe(150)
    expect(rowBpm(track('a', undefined, 0.92))).toBeUndefined()
  })

  it('the fader centre is the saved speed; the fader moves around it', () => {
    expect(deckRate(0.92, 0)).toBeCloseTo(0.92)
    expect(deckRate(0.92, 1, 0.08)).toBeCloseTo(0.92 * 1.08)
    expect(centreBpm(150, 0.92)).toBeCloseTo(138)
    expect(speedPercent(0.92)).toBe('-8.0%')
    expect(speedPercent(1.02)).toBe('+2.0%')
  })

  it('search, filter and sort use the number on screen, not the file one', () => {
    const saved = track('saved', 150, 0.92)
    expect(matchesColumnQuery(saved, 'bpm', '138')).toBe(true)
    expect(matchesColumnQuery(saved, 'bpm', '150')).toBe(false)
    expect(matchesQuery(saved, '135-140')).toBe(true)
    expect(matchesColumnFilters(saved, { bpm: { min: 135, max: 140 } }, 0)).toBe(true)
    expect(matchesColumnFilters(saved, { bpm: { min: 145, max: 155 } }, 0)).toBe(false)
    const sorted = sortTracks([saved, track('plain', 140)], 'bpm', 'asc').map((t) => t.id)
    expect(sorted).toEqual(['saved', 'plain'])
  })

  it('suggestions match on the saved speed, on the deck and in the list', () => {
    const deck: DeckMixState = { id: 'A', playing: true, bpm: 150, tempo: 0, baseRate: 0.92, trackId: 'onDeck', camelot: null }
    const { matches } = mixRecommendations([deck], [track('near138', 138), track('at150', 150), track('saved', 150, 0.92)])
    expect(matches.get('near138')?.strong).toBe(true)
    expect(matches.get('saved')?.strong).toBe(true)
    // 150 against 138 is 8.7% — outside the window: the deck plays 138, not the file's 150
    expect(matches.has('at150')).toBe(false)
    expect(matches.get('saved')?.trackBpm).toBe(138)
  })

  it('"similar" gates on the saved speed too', () => {
    const e = new Float32Array([1, 0, 0])
    const t = (id: string, bpm: number, playRate?: number) => ({ ...track(id, bpm, playRate), contentHash: id, embedding: e })
    const ids = findSimilarTracks('seed', [t('seed', 150, 0.92), t('at138', 138), t('at150', 150)]).map((m) => m.id)
    expect(ids).toContain('at138')
    expect(ids).not.toContain('at150')
  })
})
