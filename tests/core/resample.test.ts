import { describe, expect, it } from 'vitest'
import { resample } from '@/core/resample'

const sine = (hz: number, rate: number, sec: number) => Float32Array.from({ length: Math.round(rate * sec) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate))

describe('resample (v0.9.57)', () => {
  it('the same rate hands the input back untouched', () => {
    const x = sine(440, 48000, 0.1)
    expect(resample(x, 48000, 48000)).toBe(x)
  })

  it('44.1 -> 48 kHz keeps a 1 kHz tone a 1 kHz tone, at the right length, within -60 dB', () => {
    const y = resample(sine(1000, 44100, 1), 44100, 48000)
    expect(y.length).toBe(48000)
    const ideal = sine(1000, 48000, 1)
    let err = 0
    let pow = 0
    for (let n = 1000; n < 47000; n++) {
      err += (y[n] - ideal[n]) ** 2
      pow += ideal[n] ** 2
    }
    expect(10 * Math.log10(pow / err)).toBeGreaterThan(60)
  })

  it('downsampling folds nothing back: a tone above the new Nyquist comes out silent', () => {
    const y = resample(sine(23500, 48000, 0.5), 48000, 44100)
    let peak = 0
    for (let n = 2000; n < y.length - 2000; n++) peak = Math.max(peak, Math.abs(y[n]))
    expect(peak).toBeLessThan(0.01)
  })
})
