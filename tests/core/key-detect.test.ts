import { describe, expect, it } from 'vitest'
import { BANDS, FFT_SIZE, KK_MAJOR, UNCERTAIN_MARGIN, bandChroma, camelotOf, detectKey, detectedKeyFields, fft, keyFromBands, keyNameOf } from '@/core/key-detect.ts'
import { parseKey } from '@/platform/source-fsaccess/tags'

const RATE = 44100
/** Sine tones at the given MIDI notes, summed, `sec` long. */
function tones(midi: number[], sec = 6): Float32Array {
  const out = new Float32Array(Math.round(sec * RATE))
  for (const m of midi) {
    const f = 440 * 2 ** ((m - 69) / 12)
    for (let i = 0; i < out.length; i++) out[i] += 0.2 * Math.sin((2 * Math.PI * f * i) / RATE)
  }
  return out
}

describe('fft', () => {
  it('puts a pure bin-aligned tone in its bin', () => {
    const n = 64
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 5 * i) / n)
    fft(re, im)
    const mags = Array.from(re, (r, i) => Math.hypot(r, im[i]))
    expect(mags[5]).toBeCloseTo(n / 2, 6)
    expect(mags[10]).toBeCloseTo(0, 6)
  })
})

describe('keyFromBands', () => {
  const rotate = (p: readonly number[], tonic: number) => Array.from({ length: 12 }, (_, i) => p[(i - tonic + 12) % 12])

  it('bands shaped like the profiles come back as that key, at any tonic', () => {
    for (let tonic = 0; tonic < 12; tonic++) {
      expect(keyFromBands(BANDS.map(() => rotate(KK_MAJOR, tonic)))).toMatchObject({ tonic, minor: false })
      expect(keyFromBands(BANDS.map((b) => rotate(b.minor, tonic)))).toMatchObject({ tonic, minor: true })
    }
  })

  it('flat bands are no key, not a guess', () => {
    expect(keyFromBands(BANDS.map(() => new Array(12).fill(1)))).toBeNull()
  })
})

describe('bandChroma', () => {
  it('one chroma per band, each summing to 1', () => {
    const c = bandChroma([tones([45, 57, 60, 64])], RATE)
    expect(c).toHaveLength(BANDS.length)
    for (const band of c) expect(band.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 6)
  })

  it('a note is counted in the band its frequency is in', () => {
    // A4 = 440 Hz. (Window leakage into the other bands is normalised up like
    // any quiet band — measured that way, so not asserted away here.)
    const c = bandChroma([tones([69])], RATE)
    const k = BANDS.findIndex((b) => b.loHz <= 440 && 440 < b.hiHz)
    expect(c[k][9]).toBeGreaterThan(0.9)
  })
})

describe('detectKey on synthetic audio', () => {
  it('A minor tones → 8A', () => {
    const k = detectKey([tones([45, 57, 60, 64, 69, 71, 62])], RATE)
    expect(k && camelotOf(k)).toBe('8A')
  })

  it('C major tones → 8B', () => {
    const k = detectKey([tones([48, 60, 64, 67, 55, 72, 65, 62])], RATE)
    expect(k && camelotOf(k)).toBe('8B')
  })

  it('no bass at all, with noise underneath, still finds the key (v0.8.30 review)', () => {
    // Every band is normalised to a full vote, so a track with an empty bass
    // band sends noise there at full weight. Flat noise correlates with no
    // key in particular, so it must not be able to move the answer.
    const noisy = (midi: number[]) => {
      const x = tones(midi, 20)
      let seed = 1
      for (let i = 0; i < x.length; i++) {
        seed = (seed * 16807) % 2147483647
        x[i] += 0.01 * ((seed / 2147483647) * 2 - 1)
      }
      return x
    }
    // every note between 500 and 1000 Hz: C5 D5 E5 G5/A5 B5
    const am = detectKey([noisy([72, 74, 76, 81, 83])], RATE)
    const c = detectKey([noisy([72, 74, 76, 77, 79])], RATE)
    expect(am && camelotOf(am)).toBe('8A')
    expect(c && camelotOf(c)).toBe('8B')
  })

  it('too short or silent says nothing', () => {
    expect(detectKey([new Float32Array(FFT_SIZE - 1)], RATE)).toBeNull()
    expect(detectKey([new Float32Array(RATE * 5)], RATE)).toBeNull()
  })
})

describe('camelotOf', () => {
  it('uses the same wheel as the tags', () => {
    expect(camelotOf({ tonic: 9, minor: true })).toBe('8A')
    expect(camelotOf({ tonic: 0, minor: false })).toBe('8B')
    expect(camelotOf({ tonic: 4, minor: true })).toBe('9A')
    expect(camelotOf({ tonic: 7, minor: false })).toBe('9B')
  })
})

describe('keyNameOf / detectedKeyFields (v0.8.27)', () => {
  it('spells every key exactly as a tag with the same Camelot code is spelled', () => {
    for (let tonic = 0; tonic < 12; tonic++) {
      for (const minor of [false, true]) {
        const code = camelotOf({ tonic, minor })
        expect(keyNameOf({ tonic, minor })).toBe(parseKey(code)?.key)
      }
    }
  })

  it('marks a key the audio barely picked as uncertain', () => {
    const k = { tonic: 9, minor: true, score: 0.8 }
    expect(detectedKeyFields({ ...k, margin: UNCERTAIN_MARGIN - 0.001 })).toEqual({ key: 'Am', camelot: '8A', keySource: 'detected', keyUncertain: true })
    expect(detectedKeyFields({ ...k, margin: UNCERTAIN_MARGIN }).keyUncertain).toBe(false)
  })
})
