import { describe, expect, it } from 'vitest'
import { mergeTagPatch } from '@/core/tag-merge'
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
