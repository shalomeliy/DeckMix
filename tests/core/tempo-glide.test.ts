import { describe, expect, it } from 'vitest'
import { GLIDE_BACK_SEC, glideTempoAt, masterHasGone } from '@/core/tempo-glide'

const heard = { playing: true, channelVolume: 0.9, crossfader: 0 }

describe('masterHasGone', () => {
  it('a playing, audible master has not gone', () => {
    expect(masterHasGone('A', heard)).toBe(false)
    expect(masterHasGone('B', heard)).toBe(false)
  })
  it('a stopped master has gone', () => {
    expect(masterHasGone('A', { ...heard, playing: false })).toBe(true)
  })
  it('a channel fader pulled down (to a hair above zero) counts as gone', () => {
    expect(masterHasGone('A', { ...heard, channelVolume: 0.01 })).toBe(true)
    expect(masterHasGone('A', { ...heard, channelVolume: 0.2 })).toBe(false)
  })
  it('the crossfader fully on the other side counts as gone — for that side only', () => {
    expect(masterHasGone('A', { ...heard, crossfader: 1 })).toBe(true)
    expect(masterHasGone('B', { ...heard, crossfader: 1 })).toBe(false)
    expect(masterHasGone('B', { ...heard, crossfader: -0.99 })).toBe(true)
    expect(masterHasGone('A', { ...heard, crossfader: 0.9 })).toBe(false)
  })
})

describe('glideTempoAt', () => {
  it('starts at from, ends at to, straight line between', () => {
    expect(glideTempoAt(0.2, 0, 0, GLIDE_BACK_SEC)).toBe(0.2)
    expect(glideTempoAt(0.2, 0, GLIDE_BACK_SEC / 2, GLIDE_BACK_SEC)).toBeCloseTo(0.1)
    expect(glideTempoAt(0.2, 0, GLIDE_BACK_SEC, GLIDE_BACK_SEC)).toBe(0)
  })
  it('never overshoots on a late or early tick', () => {
    expect(glideTempoAt(-0.3, 0, 99, GLIDE_BACK_SEC)).toBe(0)
    expect(glideTempoAt(-0.3, 0, -1, GLIDE_BACK_SEC)).toBe(-0.3)
  })
})
