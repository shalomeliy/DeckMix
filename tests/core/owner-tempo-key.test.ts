import { describe, expect, it } from 'vitest'
import { parseBpm, parseKey } from '@/core/key-parse'
import { beatportSearch, searchableFileName } from '@/core/source-lookup'
import { DEFAULTS } from '@/core/settings'
import {
  applyOwnerMeta,
  clearOwnerMeta,
  decksFollowLibraryKeys,
  fillDetectedKey,
  labelAgrees,
  mergeAnalysisPatch,
  mergeTagPatch,
} from '@/core/tag-merge'
import type { Track } from '@/core/types'

const track = (over: Partial<Track> = {}): Track =>
  ({ id: 'a', name: 'a.mp3', path: 'a', kind: 'audio/mpeg', handle: {} as FileSystemFileHandle, ...over }) as Track

const detected = { key: 'Dm', camelot: '7A', keySource: 'detected' as const, keyUncertain: true }

describe('parseKey reads keys the way Beatport prints them (v0.8.38)', () => {
  it('reads capitalised words — "A Minor" used to read as no key at all', () => {
    expect(parseKey('A Minor')).toEqual({ key: 'Am', camelot: '8A' })
    expect(parseKey('E Minor')).toEqual({ key: 'Em', camelot: '9A' })
    expect(parseKey('B♭ Major')).toEqual({ key: 'Bb', camelot: '6B' })
    expect(parseKey('F♯ Minor')).toEqual({ key: 'F#m', camelot: '11A' })
    expect(parseKey('G MAJOR')).toEqual({ key: 'G', camelot: '9B' })
  })

  it('keeps the single-letter meaning: bare m is minor, bare M is major', () => {
    expect(parseKey('Am')?.camelot).toBe('8A')
    expect(parseKey('AM')?.camelot).toBe('11B')
  })

  it('still reads Camelot and Open Key, and refuses what is not a key', () => {
    expect(parseKey('8a')).toEqual({ key: 'Am', camelot: '8A' })
    expect(parseKey('1m')?.camelot).toBe('8A')
    expect(parseKey('Hm')).toBeNull()
    expect(parseKey('13A')).toBeNull()
    expect(parseKey('A Minorx')).toBeNull()
  })
})

describe('parseBpm', () => {
  it('accepts 40–220 with a comma or a point, rounds to 2 places', () => {
    expect(parseBpm('125')).toBe(125)
    expect(parseBpm(' 124,996 ')).toBe(125)
    expect(parseBpm('62.5')).toBe(62.5)
  })
  it('refuses noise', () => {
    for (const bad of ['0', '999', '39.9', 'abc', '', '220.5']) expect(parseBpm(bad)).toBeUndefined()
  })
})

describe('the owner’s own BPM/key beats tag and detection (v0.8.38)', () => {
  const owner = { bpm: 125, key: 'Am', camelot: '8A' }

  it('replaces a detected key, drops its * and ? marks, and marks both as the owner’s', () => {
    const t = applyOwnerMeta(track({ bpm: 124.8, ...detected }), owner)
    expect(t).toMatchObject({ bpm: 125, bpmSource: 'owner', key: 'Am', camelot: '8A', keySource: 'owner' })
    expect(t.keyUncertain).toBeUndefined()
  })

  it('holds when the tag pass lands afterwards', () => {
    const t = mergeTagPatch(applyOwnerMeta(track(), owner), { bpm: 128, key: 'Gm', camelot: '6A', artist: 'X' })
    expect(t).toMatchObject({ bpm: 125, key: 'Am', keySource: 'owner', artist: 'X' })
  })

  it('holds when the analysis lands afterwards', () => {
    const t = mergeAnalysisPatch(applyOwnerMeta(track(), owner), { bpm: 124.93, ...detected, analysisState: 'analyzed' })
    expect(t).toMatchObject({ bpm: 125, key: 'Am', keySource: 'owner', analysisState: 'analyzed' })
    expect(fillDetectedKey(t, detected).key).toBe('Am')
  })

  it('only the field the owner typed changes', () => {
    const t = applyOwnerMeta(track({ bpm: 128, key: 'Gm', camelot: '6A' }), { key: 'Am', camelot: '8A' })
    expect(t.bpm).toBe(128)
    expect(t.bpmSource).toBeUndefined()
    expect(t.keySource).toBe('owner')
  })

  it('nothing to apply returns the same track', () => {
    const t = track({ bpm: 128 })
    expect(applyOwnerMeta(t, undefined)).toBe(t)
    expect(applyOwnerMeta(t, {})).toBe(t)
  })

  it('reaches a deck holding the track', () => {
    const decks: Record<'A' | 'B', { track: Track | null }> = { A: { track: track({ ...detected }) }, B: { track: null } }
    expect(decksFollowLibraryKeys(decks, [applyOwnerMeta(track(), owner)]).A.track?.keySource).toBe('owner')
  })

  it('back to original puts the tag or detected values back, only for the fields asked', () => {
    const owned = applyOwnerMeta(track(), owner)
    const back = clearOwnerMeta(owned, { bpm: 124.93, ...detected }, { bpm: true, key: true })
    expect(back).toMatchObject({ bpm: 124.93, key: 'Dm', camelot: '7A', keySource: 'detected', keyUncertain: true })
    expect(back.bpmSource).toBeUndefined()
    const keyOnly = clearOwnerMeta(owned, { key: 'Gm', camelot: '6A' }, { bpm: false, key: true })
    expect(keyOnly).toMatchObject({ bpm: 125, bpmSource: 'owner', key: 'Gm' })
    expect(keyOnly.keySource).toBeUndefined()
  })

  it('back to original with no tag and no analysis leaves the field empty, not the owner’s value', () => {
    const back = clearOwnerMeta(applyOwnerMeta(track(), owner), {}, { bpm: true, key: true })
    expect(back.bpm).toBeUndefined()
    expect(back.key).toBeUndefined()
  })
})

describe('the Beatport link', () => {
  it('searches artist and title, encoded, and nothing else', () => {
    const s = beatportSearch({ artist: 'Alar, KOROLOVA', title: 'Without You (Extended Mix) & #1', name: 'x.m4a' })
    expect(s.basis).toBe('artist and title')
    expect(s.url).toBe(
      'https://www.beatport.com/search?q=' + encodeURIComponent('Alar, KOROLOVA Without You (Extended Mix) & #1'),
    )
    expect(new URL(s.url).searchParams.get('q')).toBe('Alar, KOROLOVA Without You (Extended Mix) & #1')
  })

  it('says when it had less to go on', () => {
    expect(beatportSearch({ title: 'Voyager', name: 'v.mp3' }).basis).toBe('title only')
    const byName = beatportSearch({ name: '07 - Abbale_Remix.wav' })
    expect(byName.basis).toBe('file name')
    expect(new URL(byName.url).searchParams.get('q')).toBe('Abbale Remix')
    expect(beatportSearch({ artist: 'שלום', title: 'שיר', name: 'x' }).url).toContain(encodeURIComponent('שלום שיר'))
  })

  it('file names lose extension and leading track number only', () => {
    expect(searchableFileName('01 Some Track (Extended Mix).mp3')).toBe('Some Track (Extended Mix)')
    expect(searchableFileName('1999.flac')).toBe('1999')
  })
})

it('the ↗ is off until the owner turns it on (Shalom, 25/09)', () => {
  expect(DEFAULTS.sourceCheck).toBe(false)
})

describe('labelAgrees: when the deck may play the refined tempo (v0.8.38 review)', () => {
  it('a tag within 2% lets detection refine it, as before', () => {
    expect(labelAgrees({ bpm: 128 }, 127.9)).toBe(true)
    expect(labelAgrees({ bpm: 126 }, 127.9)).toBe(true)
  })
  it('an owner BPM only yields to a rounding-sized gap — a wrong tag steering detection does not win', () => {
    expect(labelAgrees({ bpm: 126, bpmSource: 'owner' }, 127.9)).toBe(false)
    expect(labelAgrees({ bpm: 125, bpmSource: 'owner' }, 124.93)).toBe(true)
  })
  it('nothing to compare → the label stands', () => {
    expect(labelAgrees({ bpm: undefined }, 128)).toBe(false)
    expect(labelAgrees({ bpm: 128 }, null)).toBe(false)
  })
})
