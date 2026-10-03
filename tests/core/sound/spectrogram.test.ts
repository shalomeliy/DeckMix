import { describe, expect, it } from 'vitest'
import { clipSpectrogram, SPEC_ROWS, spectrogramRowHz } from '@/core/sound/spectrogram.ts'

const SR = 22050
const sine = (hz: number, amp: number, sec = 5) => Float32Array.from({ length: SR * sec }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR))
/** The row whose pitch is nearest `hz`. */
const rowOf = (hz: number) => Array.from({ length: SPEC_ROWS }, (_, r) => r).reduce((a, b) => (Math.abs(spectrogramRowHz(b) - hz) < Math.abs(spectrogramRowHz(a) - hz) ? b : a))
/** Mean brightness of a row across the clip. */
const rowMean = (s: ReturnType<typeof clipSpectrogram>, row: number) => {
  let sum = 0
  for (let c = 0; c < s.cols; c++) sum += s.data[c * s.rows + row]
  return sum / s.cols
}

describe('clipSpectrogram', () => {
  it('draws a steady tone as a bright horizontal line at its own pitch', () => {
    const s = clipSpectrogram(sine(880, 0.3), SR)
    expect(s.state).toBe('ok')
    const own = rowMean(s, rowOf(880))
    expect(own).toBeGreaterThan(200)
    expect(rowMean(s, rowOf(300))).toBeLessThan(own - 100)
    expect(rowMean(s, rowOf(2500))).toBeLessThan(own - 100)
  })

  it('draws the same picture whatever the volume (relative to the clip, not absolute)', () => {
    const loud = clipSpectrogram(sine(880, 0.4), SR)
    const quiet = clipSpectrogram(sine(880, 0.1), SR)
    expect(quiet.cols).toBe(loud.cols)
    let worst = 0
    for (let i = 0; i < loud.data.length; i++) worst = Math.max(worst, Math.abs(loud.data[i] - quiet.data[i]))
    expect(worst).toBeLessThanOrEqual(2)
  })

  it('one loud click does not turn the quiet tone black', () => {
    const x = sine(880, 0.0003)
    for (let i = 0; i < 300; i++) x[SR * 2 + i] = Math.sin(i * 2.1) > 0 ? 1 : -1
    const s = clipSpectrogram(x, SR)
    expect(rowMean(s, rowOf(880))).toBeGreaterThan(150)
  })

  it('says silence is silence instead of drawing noise as content', () => {
    const s = clipSpectrogram(new Float32Array(SR * 5), SR)
    expect(s.state).toBe('silent')
    expect(s.data.length).toBe(0)
    expect(clipSpectrogram(Float32Array.from({ length: SR * 5 }, () => 0.0004), SR).state).toBe('silent')
  })

  it('says a clip shorter than one analysis frame is too short', () => {
    expect(clipSpectrogram(sine(440, 0.3, 0).slice(0, 1000), SR).state).toBe('too-short')
    expect(clipSpectrogram(sine(440, 0.3), 0).state).toBe('too-short')
  })

  it('gives about 200 columns for a 5 s clip, every value in 0..255', () => {
    const s = clipSpectrogram(sine(440, 0.3), SR)
    expect(s.cols).toBeGreaterThan(190)
    expect(s.cols).toBeLessThan(210)
    expect(s.data.length).toBe(s.cols * s.rows)
  })
})
