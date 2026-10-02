import { describe, expect, it } from 'vitest'
import { findDuplicates, normalizeName } from '@/core/duplicates.ts'
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

  it('same title but a very different length is a different version, not a duplicate', () => {
    const a = t({ artist: 'X', title: 'Song', durationSec: 200 })
    const b = t({ artist: 'X', title: 'Song', durationSec: 320 })
    expect(findDuplicates([a, b]).groups).toHaveLength(0)
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

  it('does not chain a run of near-equal lengths into one group', () => {
    const ts = [100, 101.4, 102.8, 104.2, 105.6].map((d) => t({ artist: 'X', title: 'Song', durationSec: d }))
    const r = findDuplicates(ts)
    expect(r.groups.every((g) => g.trackIds.length <= 2)).toBe(true)
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
