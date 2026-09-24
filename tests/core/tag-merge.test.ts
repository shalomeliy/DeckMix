import { describe, expect, it } from 'vitest'
import { fillDetectedKey, mergeAnalysisPatch, mergeTagPatch, withLatestKey } from '@/core/tag-merge'
import type { Track } from '@/core/types'

const track = (over: Partial<Track> = {}): Track =>
  ({ id: 'a', name: 'a', path: 'a', kind: 'audio/mpeg', handle: {} as FileSystemFileHandle, ...over }) as Track

describe('mergeTagPatch', () => {
  it('fills the Time from the tag when a failed decode left an explicit undefined', () => {
    const afterFailedAnalysis = track({ analysisState: 'failed', durationSec: undefined, bpm: undefined })
    const merged = mergeTagPatch(afterFailedAnalysis, { durationSec: 505, bpm: 136, artist: 'Ace Ventura' })
    expect(merged.durationSec).toBe(505)
    expect(merged.bpm).toBe(136)
    expect(merged.artist).toBe('Ace Ventura')
    expect(merged.analysisState).toBe('failed')
  })

  it('never lets a tag overwrite a value analysis already produced', () => {
    const analyzed = track({ durationSec: 300.4, bpm: 127.9 })
    const merged = mergeTagPatch(analyzed, { durationSec: 301, bpm: 128 })
    expect(merged.durationSec).toBe(300.4)
    expect(merged.bpm).toBe(127.9)
  })

  it('keeps a defined falsy value (0, empty string) over the tag', () => {
    const merged = mergeTagPatch(track({ durationSec: 0, artist: '' }), { durationSec: 505, artist: 'Tag' })
    expect(merged.durationSec).toBe(0)
    expect(merged.artist).toBe('')
  })
})

describe('detected key vs key tag (v0.8.27)', () => {
  const detected = { key: 'Dm', camelot: '7A', keySource: 'detected' as const, keyUncertain: false }

  it('a detected key fills a track with no key', () => {
    expect(fillDetectedKey(track(), detected)).toMatchObject(detected)
  })

  it('a detected key never replaces a tag the other pass read first', () => {
    const tagged = track({ key: 'Am', camelot: '8A' })
    expect(fillDetectedKey(tagged, detected)).toBe(tagged)
  })

  it('an unparsed tag spelling (bare key, no camelot) still wins', () => {
    const odd = track({ key: 'weird' })
    expect(fillDetectedKey(odd, detected).key).toBe('weird')
  })

  it('a tag read after detection replaces it and clears the mark', () => {
    const merged = mergeTagPatch(track(detected), { key: 'Am', camelot: '8A', bpm: 124 })
    expect(merged).toMatchObject({ key: 'Am', camelot: '8A', bpm: 124 })
    expect(merged.keySource).toBeUndefined()
    expect(merged.keyUncertain).toBeUndefined()
  })

  it('a tag patch with no key leaves the detected key alone', () => {
    expect(mergeTagPatch(track(detected), { bpm: 124 })).toMatchObject(detected)
  })
})

describe('both merge orders (v0.8.27 review)', () => {
  const analysisPatch = { contentHash: 'h', analysisState: 'analyzed' as const, bpm: 127.9, key: 'Dm', camelot: '7A', keySource: 'detected' as const, keyUncertain: true }
  const tagPatch = { key: 'Am', camelot: '8A', bpm: 128 }

  it('tag first, then analysis: the tag key and bpm stay', () => {
    const t = mergeAnalysisPatch(mergeTagPatch(track(), tagPatch), analysisPatch)
    expect(t).toMatchObject({ key: 'Am', camelot: '8A', bpm: 128, contentHash: 'h' })
    expect(t.keySource).toBeUndefined()
  })

  it('analysis first, then tag: the tag key replaces the detected one', () => {
    const t = mergeTagPatch(mergeAnalysisPatch(track(), analysisPatch), tagPatch)
    expect(t).toMatchObject({ key: 'Am', camelot: '8A' })
    expect(t.keySource).toBeUndefined()
  })

  it('no tag at all: the detected key lands, marked', () => {
    expect(mergeAnalysisPatch(track(), analysisPatch)).toMatchObject({ key: 'Dm', keySource: 'detected', keyUncertain: true })
  })

  it('a deck snapshot takes the key the library read since, so detection cannot beat it', () => {
    const deckSnapshot = track()
    const libraryNow = track({ key: 'Am', camelot: '8A' })
    const onDeck = fillDetectedKey(withLatestKey(deckSnapshot, libraryNow), analysisPatch)
    expect(onDeck).toMatchObject({ key: 'Am', camelot: '8A' })
    expect(onDeck.keySource).toBeUndefined()
  })
})
