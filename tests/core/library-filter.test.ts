import { describe, expect, it } from 'vitest'
import {
  describeColumnFilter,
  matchesColumnFilters,
  missingCount,
  normalizeFilter,
  parseTimeInput,
  playedBucket,
  type ColumnFilters,
} from '@/core/library-filter'
import { sortTracks } from '@/core/library-sort'
import type { Track } from '@/core/types'

const track = (id: string, over: Partial<Track> = {}): Track =>
  ({ id, name: id, path: id, kind: 'mp3', handle: {} as FileSystemFileHandle, ...over }) as Track

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000
const keep = (tracks: Track[], f: ColumnFilters) => tracks.filter((t) => matchesColumnFilters(t, f, NOW)).map((t) => t.id)

describe('matchesColumnFilters (v0.9.36)', () => {
  it('no filter keeps every track', () => {
    expect(keep([track('a'), track('b')], {})).toEqual(['a', 'b'])
  })

  it('text: anywhere in the cell, any case; Title falls back to the file name', () => {
    const ts = [track('a', { title: 'Endless Love' }), track('b', { title: 'Glove' }), track('lovely.mp3')]
    expect(keep(ts, { title: { contains: 'LOVE' } })).toEqual(['a', 'b', 'lovely.mp3'])
    expect(keep(ts, { title: { contains: 'endless' } })).toEqual(['a'])
  })

  it('artist: "empty only" finds the tracks with no artist, "hide empty" drops them', () => {
    const ts = [track('a', { artist: 'Avicii' }), track('b'), track('c', { artist: '  ' })]
    expect(keep(ts, { artist: { blank: 'only' } })).toEqual(['b', 'c'])
    expect(keep(ts, { artist: { blank: 'hide' } })).toEqual(['a'])
  })

  it('type and key: keep the ticked values; "" is "no key"; Am and 8A are one key', () => {
    const ts = [
      track('a', { kind: 'wav', camelot: '8A', key: 'Am' }),
      track('b', { kind: 'mp3', key: 'Am', camelot: '8A' }),
      track('c', { kind: 'mp3' }),
    ]
    expect(keep(ts, { type: ['wav'] })).toEqual(['a'])
    expect(keep(ts, { key: ['8A'] })).toEqual(['a', 'b'])
    expect(keep(ts, { key: [''] })).toEqual(['c'])
  })

  it('bpm range: inclusive, either end optional, a track with no BPM is hidden and counted', () => {
    const ts = [track('a', { bpm: 120 }), track('b', { bpm: 125.5 }), track('c', { bpm: 131 }), track('d')]
    expect(keep(ts, { bpm: { min: 120, max: 130 } })).toEqual(['a', 'b'])
    expect(keep(ts, { bpm: { min: 125 } })).toEqual(['b', 'c'])
    expect(keep(ts, { bpm: { max: 125 } })).toEqual(['a'])
    expect(missingCount(ts, 'bpm')).toBe(1)
  })

  it('time range is in seconds', () => {
    const ts = [track('a', { durationSec: 150 }), track('b', { durationSec: 400 }), track('c')]
    expect(keep(ts, { durationSec: { min: 180 } })).toEqual(['b'])
    expect(missingCount(ts, 'durationSec')).toBe(1)
  })

  it('played: each track sits in exactly one period', () => {
    expect(playedBucket(undefined, NOW)).toBe('never')
    expect(playedBucket(NOW - 2 * 60 * 60 * 1000, NOW)).toBe('day')
    expect(playedBucket(NOW - 3 * DAY, NOW)).toBe('week')
    expect(playedBucket(NOW - 10 * DAY, NOW)).toBe('month')
    expect(playedBucket(NOW - 90 * DAY, NOW)).toBe('older')
    const ts = [track('a'), track('b', { lastPlayedAt: NOW - 3 * DAY })]
    expect(keep(ts, { played: ['never'] })).toEqual(['a'])
  })

  it('filters on two columns both apply', () => {
    const ts = [track('a', { bpm: 124, kind: 'wav' }), track('b', { bpm: 124 }), track('c', { bpm: 140, kind: 'wav' })]
    expect(keep(ts, { bpm: { min: 120, max: 130 }, type: ['wav'] })).toEqual(['a'])
  })
})

describe('normalizeFilter', () => {
  it('an empty filter is no filter, never an empty table', () => {
    expect(normalizeFilter('type', [])).toBeUndefined()
    expect(normalizeFilter('title', { contains: '   ' })).toBeUndefined()
    expect(normalizeFilter('bpm', { min: undefined, max: undefined })).toBeUndefined()
    expect(normalizeFilter('bpm', null)).toBeUndefined()
  })

  it('a range typed backwards is the same range', () => {
    expect(normalizeFilter('bpm', { min: 130, max: 120 })).toEqual({ min: 120, max: 130 })
  })

  it('"empty only" drops the text, "hide empty" keeps it', () => {
    expect(normalizeFilter('artist', { contains: 'x', blank: 'only' })).toEqual({ blank: 'only' })
    expect(normalizeFilter('artist', { contains: 'x', blank: 'hide' })).toEqual({ blank: 'hide', contains: 'x' })
  })
})

describe('parseTimeInput', () => {
  it('reads m:ss and whole or half minutes, and refuses the rest', () => {
    expect(parseTimeInput('3:30')).toBe(210)
    expect(parseTimeInput('5')).toBe(300)
    expect(parseTimeInput('2.5')).toBe(150)
    expect(parseTimeInput('')).toBeUndefined()
    expect(parseTimeInput('abc')).toBeUndefined()
    expect(parseTimeInput('3:75')).toBeUndefined()
  })
})

describe('describeColumnFilter', () => {
  it('names the column and what it keeps', () => {
    expect(describeColumnFilter('bpm', { min: 120, max: 130 })).toBe('BPM: 120–130')
    expect(describeColumnFilter('durationSec', { min: 180 })).toBe('Time: 3:00 and up')
    expect(describeColumnFilter('artist', { blank: 'only' })).toBe('Artist: empty')
    expect(describeColumnFilter('type', ['wav', 'mp3'])).toBe('Type: WAV, MP3')
    expect(describeColumnFilter('key', ['8A', ''])).toBe('Key: 8A, No key')
  })
})

describe('sort by Type (v0.9.36)', () => {
  it('orders by file type, ties by artist', () => {
    const ts = [track('a', { kind: 'wav', artist: 'A' }), track('b', { kind: 'mp3', artist: 'B' }), track('c', { kind: 'mp3', artist: 'A' })]
    expect(sortTracks(ts, 'type', 'asc').map((t) => t.id)).toEqual(['c', 'b', 'a'])
  })
})

describe('ranges compare what the cell shows (review, v0.9.36)', () => {
  it('130.4 BPM reads "130" and is in 120–130; 450.6s reads "7:30" and is in "up to 7:30"', () => {
    expect(keep([track('a', { bpm: 130.4 }), track('b', { bpm: 130.6 })], { bpm: { min: 120, max: 130 } })).toEqual(['a'])
    expect(keep([track('a', { durationSec: 450.6 }), track('b', { durationSec: 451 })], { durationSec: { max: 450 } })).toEqual(['a'])
  })
})
