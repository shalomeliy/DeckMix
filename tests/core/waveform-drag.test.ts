import { describe, expect, it } from 'vitest'
import { MAX_RATE, WHEEL_NOTCH_PX, waveformDragRate, wheelSteps } from '@/core/scratch.ts'

describe('waveformDragRate (v0.8.28)', () => {
  it('dragging right plays backwards — the audio follows the hand', () => {
    expect(waveformDragRate(10, 1 / 60, 150, 0)).toBeLessThan(0)
    expect(waveformDragRate(-10, 1 / 60, 150, 0)).toBeGreaterThan(0)
  })

  it('a steady drag at the drawn scale settles at normal speed', () => {
    // 150 px/s is the waveform zoom; dragging left 150 px in a second should
    // carry one second of audio past the playhead, i.e. rate 1.
    let rate = 0
    for (let i = 0; i < 60; i++) rate = waveformDragRate(-2.5, 1 / 60, 150, rate)
    expect(rate).toBeCloseTo(1, 3)
  })

  it('keeps the previous rate on an unusable dt or zoom, and clamps flicks', () => {
    expect(waveformDragRate(10, 0, 150, 0.7)).toBe(0.7)
    expect(waveformDragRate(10, 1 / 60, 0, 0.7)).toBe(0.7)
    expect(waveformDragRate(-5000, 1 / 60, 150, 0, 1)).toBe(MAX_RATE)
  })
})

describe('wheelSteps (v0.8.28)', () => {
  it('one mouse notch is one step, down is forward', () => {
    expect(wheelSteps(0, WHEEL_NOTCH_PX)).toEqual({ steps: 1, carryPx: 0 })
    expect(wheelSteps(0, -WHEEL_NOTCH_PX)).toEqual({ steps: -1, carryPx: 0 })
  })

  it('a stream of small touchpad deltas adds up instead of stepping every event', () => {
    let carry = 0
    let steps = 0
    for (let i = 0; i < 20; i++) {
      const r = wheelSteps(carry, 5)
      carry = r.carryPx
      steps += r.steps
    }
    expect(steps).toBe(1)
    expect(carry).toBe(0)
  })

  it('turning back drops the leftover, so the first notch back is a whole step', () => {
    expect(wheelSteps(60, -WHEEL_NOTCH_PX)).toEqual({ steps: -1, carryPx: 0 })
  })

  it('reads line and page delta modes', () => {
    expect(wheelSteps(0, 3, 1).steps).toBe(0)
    expect(wheelSteps(0, 4, 1).steps).toBe(1)
    expect(wheelSteps(0, 1, 2).steps).toBe(3)
  })
})
