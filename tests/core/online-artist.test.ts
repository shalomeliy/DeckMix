import { describe, expect, it } from 'vitest'
import { canLookUp, lookupTerm, onlineOptions } from '@/core/online-artist'

/** v0.9.44: the owner's manual "search the web" on a row with no artist. Names are from his library. */
describe('lookupTerm', () => {
  it('drops the extension, brackets and a key / BPM tail', () => {
    expect(lookupTerm({ name: 'Humble (DALI \'migos\' Intro).mp3' })).toBe('Humble')
    expect(lookupTerm({ name: 'Gimme! Gimme! Gimme! - 2A - 100.m4a' })).toBe('Gimme! Gimme! Gimme!')
  })
})

describe('onlineOptions', () => {
  const hits = [
    { artist: 'Kendrick Lamar', track: 'HUMBLE.' },
    { artist: 'Kendrick Lamar', track: 'HUMBLE.' },
    { artist: 'Some Cover Band', track: 'Humble (Cover)' },
    { artist: 'Other', track: 'Humble Pie' },
  ]
  it('keeps only hits whose song name is the searched one, most frequent artist first', () => {
    const o = onlineOptions('Humble', hits)
    expect(o.map((x) => x.artist)).toEqual(['Kendrick Lamar', 'Some Cover Band'])
    expect(o[0].source).toBe('online')
  })
  it('matches one side of a dash, and never offers what the owner rejected', () => {
    expect(onlineOptions('Humble - Intro', hits, ['kendrick lamar']).map((x) => x.artist)).toEqual(['Some Cover Band'])
  })
  it('finds nobody when the store only has look-alikes', () => {
    expect(onlineOptions('Humble Pi', hits)).toEqual([])
  })
})

describe('canLookUp', () => {
  it('Trance rows have no web search', () => {
    expect(canLookUp({ genre: 'Trance' })).toBe(false)
    expect(canLookUp({ genre: 'Hip Hop' })).toBe(true)
    expect(canLookUp({})).toBe(true)
  })
})
