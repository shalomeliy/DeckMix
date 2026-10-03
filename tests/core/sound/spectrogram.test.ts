import { describe, expect, it } from 'vitest'
import { clipSpectrogram, markFromFractions, SPEC_ROWS, spectrogramRowHz } from '@/core/sound/spectrogram.ts'

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

  it('the "without drums" view keeps a lasting tone and drops kick smears, more than the plain view does', () => {
    const x = sine(880, 0.15)
    for (let b = 0; b < 10; b++) {
      const at = Math.floor(SR * (0.2 + b * 0.5))
      for (let i = 0; i < 2500; i++) x[at + i] += 0.6 * Math.sin(2 * Math.PI * (55 + 120 * Math.exp(-i / 250)) * (i / SR)) * Math.exp(-i / 800) + 0.3 * (((i * 7919) % 101) / 50 - 1) * Math.exp(-i / 200)
    }
    const s = clipSpectrogram(x, SR)
    const tone = rowOf(880)
    const contrast = (data: Uint8Array) => {
      let t = 0
      let o = 0
      let n = 0
      for (let c = 0; c < s.cols; c++)
        for (let r = 0; r < s.rows; r++) {
          if (Math.abs(r - tone) <= 1) t += data[c * s.rows + r]
          else if (r < tone - 6 || r > tone + 6) {
            o += data[c * s.rows + r]
            n++
          }
        }
      return t / (3 * s.cols) - o / n // how much brighter the tone's rows are than the rest
    }
    expect(s.voices.length).toBe(s.data.length)
    expect(contrast(s.voices)).toBeGreaterThan(contrast(s.data) + 25)
  })
})

describe('markFromFractions (regions the owner draws on the picture)', () => {
  it('turns a drag into clip seconds and Hz on the same log scale as the axis', () => {
    // top of the picture = 4000 Hz, bottom = 100 Hz; a drag from 20% to 60% of the width
    const m = markFromFractions(0.2, 0, 0.6, 1, 5)!
    expect(m.t0).toBeCloseTo(1, 9)
    expect(m.t1).toBeCloseTo(3, 9)
    expect(m.hz0).toBeCloseTo(100, 6)
    expect(m.hz1).toBeCloseTo(4000, 6)
    // the 1 kHz tick sits at (1 - log(10)/log(40)) of the height from the top
    const y1k = 1 - Math.log(10) / Math.log(40)
    const around1k = markFromFractions(0, y1k - 0.1, 1, y1k + 0.1, 5)!
    expect(Math.sqrt(around1k.hz0 * around1k.hz1)).toBeCloseTo(1000, 0)
  })
  it('does not care which corner the drag starts from', () => {
    expect(markFromFractions(0.6, 1, 0.2, 0, 5)).toEqual(markFromFractions(0.2, 0, 0.6, 1, 5))
  })
  it('clamps a drag that leaves the picture', () => {
    const m = markFromFractions(-0.5, -0.5, 1.5, 1.5, 5)!
    expect(m.t0).toBe(0)
    expect(m.t1).toBe(5)
    expect(m.hz0).toBeCloseTo(100, 6)
    expect(m.hz1).toBeCloseTo(4000, 6)
  })
  it('ignores a click or a twitch', () => {
    expect(markFromFractions(0.5, 0.5, 0.5, 0.5, 5)).toBeNull()
    expect(markFromFractions(0.5, 0.2, 0.51, 0.8, 5)).toBeNull() // 0.05 s wide
    expect(markFromFractions(0.2, 0.5, 0.8, 0.5, 5)).toBeNull() // no height
  })
})
