import { describe, expect, it } from 'vitest'
import { createFft } from '@/core/sound/fft.ts'

describe('createFft', () => {
  it('puts a sine in its own bin', () => {
    const n = 1024
    const fft = createFft(n)
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 37 * i) / n)
    fft.forward(re, im)
    const mag = (k: number) => Math.hypot(re[k], im[k])
    expect(mag(37)).toBeCloseTo(n / 2, 3)
    expect(mag(36)).toBeLessThan(1e-6)
    expect(mag(100)).toBeLessThan(1e-6)
  })
  it('conserves energy (Parseval)', () => {
    const n = 512
    const fft = createFft(n)
    const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.3) + ((i * 7919) % 13) / 13)
    const im = new Float64Array(n)
    const timeE = re.reduce((s, v) => s + v * v, 0)
    fft.forward(re, im)
    let freqE = 0
    for (let k = 0; k < n; k++) freqE += re[k] * re[k] + im[k] * im[k]
    expect(freqE / n).toBeCloseTo(timeE, 6)
  })
  it('refuses a size that is not a power of two', () => {
    expect(() => createFft(1000)).toThrow()
  })
})
