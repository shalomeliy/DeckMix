import { describe, expect, it } from 'vitest'
import { matchesColumnQuery, matchesQuery, matchesSearch, parseBpmRange } from '@/core/library-search'
import type { Track } from '@/core/types'

const track = (over: Partial<Track> = {}): Track =>
  ({
    id: 't',
    name: 'Some Track',
    path: 'Techno/Some Track.mp3',
    kind: 'audio/mpeg',
    handle: {} as FileSystemFileHandle,
    ...over,
  }) as Track

describe('parseBpmRange', () => {
  it('parses a simple range', () => {
    expect(parseBpmRange('120-130')).toEqual({ min: 120, max: 130 })
  })

  it('allows spaces and decimals', () => {
    expect(parseBpmRange('120.5 - 130')).toEqual({ min: 120.5, max: 130 })
  })

  it('rejects a reversed range', () => {
    expect(parseBpmRange('130-120')).toBeNull()
  })

  it('rejects a non-numeric range', () => {
    expect(parseBpmRange('abc-xyz')).toBeNull()
  })

  it('rejects plain text with no dash', () => {
    expect(parseBpmRange('techno')).toBeNull()
  })
})

describe('matchesQuery', () => {
  it('matches everything on an empty query', () => {
    expect(matchesQuery(track(), '')).toBe(true)
    expect(matchesQuery(track(), '   ')).toBe(true)
  })

  it('matches a BPM range against the track bpm', () => {
    expect(matchesQuery(track({ bpm: 125 }), '120-130')).toBe(true)
    expect(matchesQuery(track({ bpm: 118 }), '120-130')).toBe(false)
  })

  it('a track with no bpm never matches a range query', () => {
    expect(matchesQuery(track(), '120-130')).toBe(false)
  })

  /** Same guarantee QA-expert flagged: never blocked, never a hard error. */
  it('falls back to plain text for a reversed or non-numeric range', () => {
    expect(matchesQuery(track({ path: '130-120 remix.mp3' }), '130-120')).toBe(true)
  })

  it('still matches path/artist/title/genre substrings like before', () => {
    expect(matchesQuery(track({ artist: 'DJ Test' }), 'dj test')).toBe(true)
    expect(matchesQuery(track({ title: 'Warehouse' }), 'house')).toBe(true)
    expect(matchesQuery(track({ genre: 'Techno' }), 'techno')).toBe(true)
    expect(matchesQuery(track(), 'techno')).toBe(true) // matches the path fixture
  })

  it('matches an exact key or camelot code, case-insensitively', () => {
    expect(matchesQuery(track({ camelot: '8A' }), '8a')).toBe(true)
    expect(matchesQuery(track({ key: 'Am' }), 'am')).toBe(true)
    expect(matchesQuery(track({ camelot: '8A' }), '9a')).toBe(false)
  })
})

describe('matchesColumnQuery (v0.8.25)', () => {
  const t = (o: Partial<Track>): Track => ({ id: 'x', name: 'x.mp3', path: 'x.mp3', kind: 'mp3', handle: {} as FileSystemFileHandle, ...o })

  it('title/artist: the text starts a word, not anywhere inside one', () => {
    expect(matchesColumnQuery(t({ title: 'Endless Love' }), 'title', 'love')).toBe(true)
    expect(matchesColumnQuery(t({ title: 'Lovely Day' }), 'title', 'LOVE')).toBe(true)
    expect(matchesColumnQuery(t({ title: 'Glove Box' }), 'title', 'love')).toBe(false)
    expect(matchesColumnQuery(t({ artist: 'Daft Punk' }), 'artist', 'punk')).toBe(true)
    expect(matchesColumnQuery(t({ title: 'Daft Punk' }), 'artist', 'punk')).toBe(false)
  })

  it('title falls back to the file name when there is no title tag', () => {
    expect(matchesColumnQuery(t({ name: 'Techno Rush.mp3' }), 'title', 'rush')).toBe(true)
  })

  it('bpm: "124" is 123.5 up to, not including, 124.5 — what the table shows as 124', () => {
    expect(matchesColumnQuery(t({ bpm: 123.5 }), 'bpm', '124')).toBe(true)
    expect(matchesColumnQuery(t({ bpm: 124.49 }), 'bpm', '124')).toBe(true)
    expect(matchesColumnQuery(t({ bpm: 124.5 }), 'bpm', '124')).toBe(false)
    expect(matchesColumnQuery(t({ bpm: 123.4 }), 'bpm', '124')).toBe(false)
    expect(matchesColumnQuery(t({}), 'bpm', '124')).toBe(false)
    expect(matchesColumnQuery(t({ bpm: 125 }), 'bpm', '120-130')).toBe(true)
    expect(matchesColumnQuery(t({ bpm: 125 }), 'bpm', 'fast')).toBe(false)
  })

  it('bpm search never matches a title that happens to contain the number', () => {
    expect(matchesColumnQuery(t({ title: '128 Degrees', bpm: 100 }), 'bpm', '128')).toBe(false)
  })

  it('key: exact, in either spelling', () => {
    const am = t({ key: 'Am', camelot: '8A' })
    expect(matchesColumnQuery(am, 'key', '8a')).toBe(true)
    expect(matchesColumnQuery(am, 'key', 'Am')).toBe(true)
    expect(matchesColumnQuery(am, 'key', 'A')).toBe(false)
    expect(matchesColumnQuery(am, 'key', '8')).toBe(false)
  })

  it('an empty query matches everything, like the plain search', () => {
    expect(matchesColumnQuery(t({}), 'bpm', '  ')).toBe(true)
  })

  it('a regex character in the query is text, not a pattern', () => {
    expect(matchesColumnQuery(t({ title: 'What? (Remix)' }), 'title', '(remix')).toBe(true)
    expect(matchesColumnQuery(t({ title: 'Whatever' }), 'title', 'what?')).toBe(false)
  })
})

describe('matchesSearch — what a saved smart crate re-runs (v0.8.25 review)', () => {
  const t = (o: Partial<Track>): Track => ({ id: 'x', name: 'x.mp3', path: 'x.mp3', kind: 'mp3', handle: {} as FileSystemFileHandle, ...o })

  it('a "BPM ▸ 124" search saved as a crate stays a BPM search, not a path search', () => {
    const inPath = t({ path: 'Mixes/124 Special.mp3', bpm: 90 })
    const at124 = t({ path: 'Other.mp3', bpm: 124 })
    expect(matchesSearch(inPath, '124', 'bpm')).toBe(false)
    expect(matchesSearch(at124, '124', 'bpm')).toBe(true)
  })

  it('no column (an older crate) is the plain search it always was', () => {
    const inPath = t({ path: 'Mixes/124 Special.mp3', bpm: 90 })
    expect(matchesSearch(inPath, '124', undefined)).toBe(true)
    expect(matchesSearch(inPath, '124', null)).toBe(matchesQuery(inPath, '124'))
  })
})
