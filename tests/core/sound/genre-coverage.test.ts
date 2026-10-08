import { describe, expect, it } from 'vitest'
import { NO_GENRE_LABEL, MIN_SONGS_FOR_GENRE_MODEL, genreCoverage, modelSongCounts } from '@/core/sound/genre-coverage'
import genreModels from '@/core/sound/vocal-genre-models.json'

const many = (g: string, n: number) => Array<string>(n).fill(g)

describe('genreCoverage', () => {
  it('names a genre with a model, a genre with a rule, and a genre that is missing songs', () => {
    const rows = genreCoverage([...many('Techno', 50), ...many('Hip Hop', 20)], [...many('Techno', 42), ...many('Hip Hop', 11)], { Techno: 42 })
    const by = Object.fromEntries(rows.map((r) => [r.genre, r]))
    expect(by.Techno).toMatchObject({ state: 'learned', marked: 42, inLibrary: 50, detail: 42 })
    expect(by['Hip Hop']).toMatchObject({ state: 'missing', marked: 11, detail: MIN_SONGS_FOR_GENRE_MODEL - 11 })
    expect(by.Trance).toMatchObject({ state: 'rule', marked: 0 })
  })

  it('lists a genre that is only in the library, with zero marks, and never a negative shortfall', () => {
    const rows = genreCoverage(many('Reggae', 3), many('Hip Hop', 45), {})
    expect(rows.find((r) => r.genre === 'Reggae')).toMatchObject({ state: 'missing', marked: 0, detail: MIN_SONGS_FOR_GENRE_MODEL })
    expect(rows.find((r) => r.genre === 'Hip Hop')?.detail).toBe(0)
  })

  it('shows songs without a genre as their own row, so the totals add up', () => {
    const rows = genreCoverage([undefined, undefined, 'House'], [undefined], {})
    expect(rows.at(-1)).toMatchObject({ genre: NO_GENRE_LABEL, state: 'unassigned', inLibrary: 2, marked: 1 })
    expect(genreCoverage(['House'], ['House'], {}).some((r) => r.state === 'unassigned')).toBe(false)
  })

  it('reads the shipped models: Techno, House and Mizrahi, each with its song count', () => {
    expect(modelSongCounts(genreModels)).toEqual({ Techno: 42, House: 31, Mizrahi: 79 })
  })
})
