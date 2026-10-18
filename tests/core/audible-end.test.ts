import { describe, expect, it } from 'vitest'
import { MIN_DEAD_TAIL_SEC, audibleEndSec, songEndSec } from '@/core/audible-end'

const SR = 1000

/** `loudSec` of full-scale signal, then `tailSec` of silence, as two identical channels. */
function song(loudSec: number, tailSec: number, tailLevel = 0): Float32Array[] {
  const a = new Float32Array(Math.round((loudSec + tailSec) * SR))
  a.fill(0.5, 0, loudSec * SR)
  if (tailLevel) a.fill(tailLevel, loudSec * SR)
  return [a, a.slice()]
}

describe('audibleEndSec', () => {
  it('moves the end back past a long silent tail', () => {
    expect(audibleEndSec(song(30, 69), SR, 99)).toBeCloseTo(30, 3)
  })

  it('leaves a tail shorter than the dead-air threshold alone, exactly the file length', () => {
    expect(audibleEndSec(song(30, MIN_DEAD_TAIL_SEC - 0.5), SR, 31.5)).toBe(31.5)
    expect(audibleEndSec(song(30, 0), SR, 30)).toBe(30)
  })

  it('moves the end for a tail of exactly the threshold', () => {
    expect(audibleEndSec(song(30, MIN_DEAD_TAIL_SEC), SR, 32)).toBeCloseTo(30, 3)
  })

  it('counts a very quiet tail (-70 dBFS) as silence but a fade at -40 dBFS as music', () => {
    expect(audibleEndSec(song(30, 10, 10 ** (-70 / 20)), SR, 40)).toBeCloseTo(30, 3)
    expect(audibleEndSec(song(30, 10, 10 ** (-40 / 20)), SR, 40)).toBe(40)
  })

  it('hears sound on either channel', () => {
    const [l, r] = song(30, 10)
    r.fill(0.5, 35 * SR, 36 * SR)
    expect(audibleEndSec([l, r], SR, 40)).toBeCloseTo(36, 3)
  })

  it('works on mono, and a real 44.1 kHz tail of 1.99 s stays put while 2.01 s moves', () => {
    const sr = 44100
    const make = (tail: number) => { const a = new Float32Array(Math.round((10 + tail) * sr)); a.fill(0.5, 0, 10 * sr); return [a] }
    expect(audibleEndSec(make(1.99), sr, 11.99)).toBe(11.99)
    expect(audibleEndSec(make(2.01), sr, 12.01)).toBeCloseTo(10, 3)
  })

  it('treats a NaN sample as silence, so a corrupt tail cannot hold the end open', () => {
    const [l, r] = song(30, 10)
    l.fill(NaN, 31 * SR)
    expect(audibleEndSec([l, r], SR, 40)).toBeCloseTo(30, 3)
  })

  it('never reports an end past the duration it was given', () => {
    expect(audibleEndSec(song(30, 10), SR, 20)).toBeLessThanOrEqual(20)
  })

  it('does not call a wholly silent or empty file "0 seconds long"', () => {
    expect(audibleEndSec([new Float32Array(10 * SR)], SR, 10)).toBe(10)
    expect(audibleEndSec([], SR, 10)).toBe(10)
    expect(audibleEndSec([new Float32Array(0)], SR, 10)).toBe(10)
    expect(audibleEndSec(song(1, 1), 0, 2)).toBe(2)
  })
})

describe('songEndSec', () => {
  it('falls back to the file length while nothing is measured', () => {
    expect(songEndSec(0, 200)).toBe(200)
    expect(songEndSec(undefined, 200)).toBe(200)
  })
  it('ignores a negative or NaN measurement', () => {
    expect(songEndSec(-5, 200)).toBe(200)
    expect(songEndSec(NaN, 200)).toBe(200)
  })
  it('never goes past the file length', () => {
    expect(songEndSec(250, 200)).toBe(200)
  })
  it('uses the measured end when it is earlier', () => {
    expect(songEndSec(131, 200)).toBe(131)
  })
})
