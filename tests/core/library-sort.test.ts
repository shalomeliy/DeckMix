import { describe, expect, it } from 'vitest'
import { sortTracks } from '@/core/library-sort'
import type { Track } from '@/core/types'

const track = (id: string, over: Partial<Track> = {}): Track =>
  ({
    id,
    name: id,
    path: id,
    kind: 'audio/mpeg',
    handle: {} as FileSystemFileHandle,
    ...over,
  }) as Track

describe('sortTracks', () => {
  it('returns the input order unchanged when sortKey is null', () => {
    const tracks = [track('b'), track('a'), track('c')]
    expect(sortTracks(tracks, null, 'asc')).toEqual(tracks)
  })

  it('sorts ascending by bpm', () => {
    const tracks = [track('a', { bpm: 128 }), track('b', { bpm: 100 }), track('c', { bpm: 140 })]
    expect(sortTracks(tracks, 'bpm', 'asc').map((t) => t.id)).toEqual(['b', 'a', 'c'])
  })

  it('sorts descending by bpm', () => {
    const tracks = [track('a', { bpm: 128 }), track('b', { bpm: 100 }), track('c', { bpm: 140 })]
    expect(sortTracks(tracks, 'bpm', 'desc').map((t) => t.id)).toEqual(['c', 'a', 'b'])
  })

  /** A track missing the sorted value is not "the fastest" just because the column reversed. */
  it('puts a missing bpm last in both directions', () => {
    const tracks = [track('has', { bpm: 120 }), track('missing')]
    expect(sortTracks(tracks, 'bpm', 'asc').map((t) => t.id)).toEqual(['has', 'missing'])
    expect(sortTracks(tracks, 'bpm', 'desc').map((t) => t.id)).toEqual(['has', 'missing'])
  })

  it('sorts key by Camelot wheel position, independent of display spelling', () => {
    const tracks = [track('a', { camelot: '9A' }), track('b', { camelot: '2A' }), track('c', { camelot: '2B' })]
    expect(sortTracks(tracks, 'key', 'asc').map((t) => t.id)).toEqual(['b', 'c', 'a'])
  })

  it('puts an unparsable camelot code last, same as a missing one', () => {
    const tracks = [track('has', { camelot: '5A' }), track('garbled', { camelot: 'nope' })]
    expect(sortTracks(tracks, 'key', 'asc').map((t) => t.id)).toEqual(['has', 'garbled'])
  })

  it('sorts title case-insensitively, falling back to name', () => {
    const tracks = [track('a', { title: 'zeta' }), track('b', { name: 'alpha' })]
    expect(sortTracks(tracks, 'title', 'asc').map((t) => t.id)).toEqual(['b', 'a'])
  })

  it('sorts note and lastPlayedAt too, missing values last', () => {
    const tracks = [track('a', { note: 'zzz' }), track('b', { note: 'aaa' }), track('c')]
    expect(sortTracks(tracks, 'note', 'asc').map((t) => t.id)).toEqual(['b', 'a', 'c'])

    const played = [track('old', { lastPlayedAt: 100 }), track('new', { lastPlayedAt: 200 }), track('never')]
    expect(sortTracks(played, 'lastPlayedAt', 'desc').map((t) => t.id)).toEqual(['new', 'old', 'never'])
  })

  it('sorts genre A→Z, case-insensitively, a track with no genre last in both directions, ties by artist then title', () => {
    const tracks = [
      track('c', { genre: 'techno', artist: 'Zed' }),
      track('none', { artist: 'Aaa' }),
      track('a', { genre: 'House', artist: 'Mia' }),
      track('b', { genre: 'house', artist: 'Abe' }),
    ]
    expect(sortTracks(tracks, 'genre', 'asc').map((t) => t.id)).toEqual(['b', 'a', 'c', 'none'])
    expect(sortTracks(tracks, 'genre', 'desc').map((t) => t.id)).toEqual(['c', 'b', 'a', 'none'])
  })

  it('does not mutate the input array', () => {
    const tracks = [track('b', { bpm: 2 }), track('a', { bpm: 1 })]
    const original = [...tracks]
    sortTracks(tracks, 'bpm', 'asc')
    expect(tracks).toEqual(original)
  })
})

describe('sortTracks tie-breaks (v0.8.17)', () => {
  it('ties on the main column break by artist A→Z', () => {
    const tracks = [
      track('1', { bpm: 128, artist: 'Zedd' }),
      track('2', { bpm: 128, artist: 'Avicii' }),
      track('3', { bpm: 128, artist: 'Martin Garrix' }),
    ]
    expect(sortTracks(tracks, 'bpm', 'asc').map((t) => t.id)).toEqual(['2', '3', '1'])
  })

  it('then by title A→Z when the artist is the same too', () => {
    const tracks = [
      track('1', { bpm: 128, artist: 'Avicii', title: 'Wake Me Up' }),
      track('2', { bpm: 128, artist: 'Avicii', title: 'Levels' }),
    ]
    expect(sortTracks(tracks, 'bpm', 'asc').map((t) => t.id)).toEqual(['2', '1'])
  })

  it('tie-breaks stay A→Z when the main column is descending', () => {
    const tracks = [
      track('1', { bpm: 128, artist: 'Zedd' }),
      track('2', { bpm: 140, artist: 'Zedd' }),
      track('3', { bpm: 128, artist: 'Avicii' }),
    ]
    expect(sortTracks(tracks, 'bpm', 'desc').map((t) => t.id)).toEqual(['2', '3', '1'])
  })

  it('a track with no artist goes after the named ones in its tie', () => {
    const tracks = [track('1', { bpm: 128 }), track('2', { bpm: 128, artist: 'Zedd' })]
    expect(sortTracks(tracks, 'bpm', 'asc').map((t) => t.id)).toEqual(['2', '1'])
  })

  it('tracks missing the main value still go last, ordered by artist among themselves', () => {
    const tracks = [
      track('1', { artist: 'Zedd' }),
      track('2', { bpm: 100, artist: 'Zedd' }),
      track('3', { artist: 'Avicii' }),
    ]
    expect(sortTracks(tracks, 'bpm', 'desc').map((t) => t.id)).toEqual(['2', '3', '1'])
  })

  it('falls back to the file name when a track has no title tag', () => {
    const tracks = [
      track('b-song.mp3', { bpm: 128, artist: 'Avicii' }),
      track('a-song.mp3', { bpm: 128, artist: 'Avicii' }),
    ]
    expect(sortTracks(tracks, 'bpm', 'asc').map((t) => t.id)).toEqual(['a-song.mp3', 'b-song.mp3'])
  })

  it('ignores letter case and orders numbers naturally', () => {
    const tracks = [
      track('1', { bpm: 128, artist: 'avicii', title: 'Track 10' }),
      track('2', { bpm: 128, artist: 'Avicii', title: 'Track 2' }),
    ]
    expect(sortTracks(tracks, 'bpm', 'asc').map((t) => t.id)).toEqual(['2', '1'])
  })
})
