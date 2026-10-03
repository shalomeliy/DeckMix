import { describe, expect, it } from 'vitest'
import { clipWindow, windowPosition } from '@/core/playback-window.ts'

describe('playback window (the vocal clip progress line, v0.9.11)', () => {
  it('moves through the clip while it plays, then reports null', () => {
    const w = clipWindow(10, 0.02, 60, 5, 200)
    expect(windowPosition(w, 10.02 + 2)).toBeCloseTo(62, 9)
    expect(windowPosition(w, 10.02 + 5.5)).toBeNull()
  })
  it('sits at the clip start before the sound begins, and is null with nothing scheduled', () => {
    const w = clipWindow(10, 0.02, 60, 5, 200)
    expect(windowPosition(w, 10)).toBe(60)
    expect(windowPosition(null, 10)).toBeNull()
  })
  it('a clip that would run past the end of the track is shortened, not extended', () => {
    const w = clipWindow(0, 0, 198, 5, 200)
    expect(w.len).toBe(2)
    expect(windowPosition(w, 2.5)).toBeNull()
  })
})
