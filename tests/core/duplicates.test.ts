import { describe, expect, it } from 'vitest'
import { describeDuplicate, findDuplicates, normalizeName, sameSong, songName } from '@/core/duplicates.ts'
import type { Track } from '@/core/types'

let n = 0
function t(over: Partial<Track>): Track {
  n++
  return { id: `t${n}`, name: `file${n}.mp3`, path: `file${n}.mp3`, kind: 'mp3', handle: {} as FileSystemFileHandle, ...over }
}

describe('normalizeName', () => {
  it('meets across track numbers, punctuation, case, extension', () => {
    expect(normalizeName('01 - Daft Punk – One More Time.mp3')).toBe(normalizeName('daft punk one more time.wav'))
  })
  it('keeps Hebrew letters', () => {
    expect(normalizeName('סטטיק - בלנסיאגה.m4a')).toBe('סטטיק בלנסיאגה')
  })
})

describe('findDuplicates', () => {
  it('same content hash under two names is identical', () => {
    const a = t({ name: 'a.mp3', contentHash: 'h1' })
    const b = t({ name: 'copy of a.mp3', contentHash: 'h1' })
    const r = findDuplicates([a, b])
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0].kind).toBe('identical')
    expect(r.byTrack.get(b.id)?.trackIds).toEqual([a.id, b.id])
  })

  it('same artist+title and near length but different bytes is probable', () => {
    const a = t({ artist: 'X', title: 'Song', durationSec: 200, contentHash: 'h1' })
    const b = t({ artist: 'x', title: 'SONG', durationSec: 200.9, contentHash: 'h2' })
    expect(findDuplicates([a, b]).groups[0].kind).toBe('probable')
  })

  it('same title but a very different length is listed as a different version, not a copy', () => {
    const a = t({ artist: 'X', title: 'Song', durationSec: 200 })
    const b = t({ artist: 'X', title: 'Song', durationSec: 320 })
    const r = findDuplicates([a, b])
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0].kind).toBe('version')
  })

  it('falls back to the file name when there are no tags', () => {
    const a = t({ name: '03 - Some Track.mp3', durationSec: 180 })
    const b = t({ name: 'some track.wav', durationSec: 180.2 })
    expect(findDuplicates([a, b]).groups).toHaveLength(1)
  })

  it('never matches on a name too short to mean anything', () => {
    const a = t({ name: '01.mp3', durationSec: 100 })
    const b = t({ name: '01.wav', durationSec: 100 })
    expect(findDuplicates([a, b]).groups).toHaveLength(0)
  })

  it('a hash match and a name match overlapping on one track make one group', () => {
    const a = t({ artist: 'X', title: 'Song', durationSec: 200, contentHash: 'h1' })
    const b = t({ name: 'other.mp3', contentHash: 'h1' })
    const c = t({ artist: 'X', title: 'Song', durationSec: 200.5, contentHash: 'h3' })
    const r = findDuplicates([a, b, c])
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0].trackIds).toHaveLength(3)
    expect(r.groups[0].kind).toBe('probable')
  })

  it('a run of near-equal lengths is one song, but not one version: 6s apart end to end', () => {
    const ts = [100, 101.4, 102.8, 104.2, 105.6].map((d) => t({ artist: 'X', title: 'Song', durationSec: d }))
    const r = findDuplicates(ts)
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0].kind).toBe('version')
  })

  it('a hash group with one unhashed member is probable, not identical', () => {
    const a = t({ artist: 'X', title: 'Song', durationSec: 200, contentHash: 'h1' })
    const b = t({ artist: 'X', title: 'Song', durationSec: 200 })
    expect(findDuplicates([a, b]).groups[0].kind).toBe('probable')
  })

  it('counts tracks it cannot compare yet instead of dropping them', () => {
    const a = t({ name: 'unique song.mp3' }) // no hash, no length yet
    const b = t({ name: 'other thing.mp3', durationSec: 100 })
    expect(findDuplicates([a, b]).unchecked).toBe(1)
  })
})

// v0.9.24: the owner's screenshot (05/10) — two remixes of one song, no artist
// tag, that v0.8.45's exact-name match never put together.
describe('wider matching (v0.9.24)', () => {
  const byId = (ts: Track[]) => new Map(ts.map((x) => [x.id, x]))

  it('two remixes of one song meet, as a different version', () => {
    const a = t({ name: 'עדן חסון - צוחקת ובוכה (Dj Camelion Extended Remix) V2.mp3', durationSec: 372, sizeBytes: 372 * 40_000 })
    const b = t({ name: 'עדן חסון - צוחקת ובוכה (Hasod Remix).mp3', durationSec: 220, sizeBytes: 220 * 24_000 })
    const r = findDuplicates([a, b])
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0].kind).toBe('version')
    const na = describeDuplicate(a, r.groups[0], byId([a, b]))
    const nb = describeDuplicate(b, r.groups[0], byId([a, b]))
    expect(na.short).toEqual(['other mix', 'longer', 'best quality'])
    expect(nb.short).toEqual(['other mix', 'shorter', 'lower quality'])
    expect(na.detail).toContain('6:12')
    expect(na.detail).toContain('~320 kbps')
    expect(nb.detail).toContain('Hasod Remix')
  })

  it('a file name and a tagged twin meet, and "(Original Mix)" is no version at all', () => {
    const a = t({ name: 'Artist - Track (Original Mix).mp3', durationSec: 300 })
    const b = t({ name: 'whatever.wav', artist: 'Artist', title: 'Track', durationSec: 300.4 })
    expect(findDuplicates([a, b]).groups[0].kind).toBe('probable')
  })

  it('a word added to the name still matches; a lossless twin is the better one', () => {
    const a = t({ name: 'Eden Hason - Tzocheket Uvocha.mp3', kind: 'mp3', durationSec: 200, sizeBytes: 200 * 16_000 })
    const b = t({ name: 'Eden Hason - Tzocheket Uvocha Extended.wav', kind: 'wav', durationSec: 290 })
    const r = findDuplicates([a, b])
    expect(r.groups[0].kind).toBe('version')
    expect(describeDuplicate(b, r.groups[0], byId([a, b])).short).toEqual(['other mix', 'longer', 'best quality'])
    expect(describeDuplicate(a, r.groups[0], byId([a, b])).short).toEqual(['plain version', 'shorter', 'lower quality'])
  })

  it('same version, different quality only: says quality, not mix or length', () => {
    const a = t({ artist: 'X', title: 'Long Song Name', durationSec: 200, sizeBytes: 200 * 40_000 })
    const b = t({ artist: 'X', title: 'Long Song Name', durationSec: 200.5, sizeBytes: 200.5 * 16_000 })
    const r = findDuplicates([a, b])
    expect(r.groups[0].kind).toBe('probable')
    expect(describeDuplicate(b, r.groups[0], byId([a, b])).short).toEqual(['lower quality'])
  })

  it('sameSong: word order, a spelling letter, a featured artist', () => {
    expect(sameSong('a b song title', 'b a song title')).toBe(true)
    expect(sameSong('עדן חסון צוחקת ובוכה', 'עדן חסון צוחקות ובוכה')).toBe(true)
    expect(songName('Artist feat. Guest - Title').song).toBe(songName('Artist - Title').song)
  })

  it('does not join different songs that share an artist or a word', () => {
    expect(sameSong('avicii wake me up', 'avicii wake')).toBe(false)
    expect(sameSong('avicii levels', 'avicii hey brother')).toBe(false)
    const a = t({ name: 'Eden Hason - Tzocheket Uvocha.mp3', durationSec: 200 })
    const b = t({ name: 'Eden Hason - Ahava Shel Kayitz.mp3', durationSec: 200 })
    expect(findDuplicates([a, b]).groups).toHaveLength(0)
  })

  it('a two-part name whose last part is a title is not mistaken for a mix tag', () => {
    expect(songName('Artist - Live Your Life').song).toBe('artist live your life')
    expect(songName('Artist - Title - Radio Edit').version).toBe('edit radio')
    expect(songName('Artist - Title - Extended Mix').song).toBe('artist title')
  })

  // Both from the owner's Music folder, 05/10 (480 files, 48 groups after the fix).
  it('a YouTube id, a "(1)", "- Copy" and a BPM tag are not a mix', () => {
    expect(songName('Korolova - Me And You [bAGbhJHw7iI].mp3')).toMatchObject({ song: 'korolova me and you', version: '' })
    expect(songName('Cyber Samurai (1) - Copy.wav')).toMatchObject({ song: 'cyber samurai', version: '' })
    expect(songName('אושר כהן - מנגן ושר (Hasod Remix) - 132 BPM.mp3').song).toBe('אושר כהן מנגן ושר')
    expect(songName('Song (Vocal-Remix).mp3').version).toBe('remix vocal')
  })

  it('two unrelated "YouTube [id]" downloads are not one song', () => {
    const a = t({ name: 'YouTube [0ohuSUNHePA].mp3', durationSec: 100 })
    const b = t({ name: 'YouTube [kivuDS-6HbQ].mp3', durationSec: 200 })
    expect(findDuplicates([a, b]).groups).toHaveLength(0)
  })
})
