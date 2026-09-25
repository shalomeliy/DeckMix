import { describe, expect, it } from 'vitest'
import { detectBeatGrid } from '@/platform/analyzer-js/beat'

/** A kick-like click train: a decaying 60Hz burst on every beat. */
function clicks(bpm: number, sampleRate: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(sampleRate * seconds))
  const beat = (60 / bpm) * sampleRate
  const burst = Math.round(sampleRate * 0.05)
  for (let b = 0; b * beat < out.length; b++) {
    const start = Math.round(b * beat)
    for (let i = 0; i < burst && start + i < out.length; i++) {
      out[start + i] = Math.sin((2 * Math.PI * 60 * i) / sampleRate) * Math.exp(-i / (burst / 4))
    }
  }
  return out
}

// 25/09: the envelope's frames were floor(sampleRate / 200) samples long but
// the tempo maths was told there were exactly 200 of them a second. True at
// 48kHz (240 samples); at 44.1kHz a frame is 220 samples, 200.45 frames a
// second, and every tempo came out 0.23% slow — 128 read as 127.7. Measured
// over the owner's library (scripts/measure-bpm-blind.mjs): mean error
// -0.196% decoded at 44.1kHz against -0.004% at 48kHz.
describe('detectBeatGrid does not depend on the decode rate', () => {
  for (const sampleRate of [44100, 48000, 96000]) {
    it(`finds 128 BPM at ${sampleRate}Hz`, () => {
      const g = detectBeatGrid({ channels: [clicks(128, sampleRate, 60)], sampleRate })
      expect(g).not.toBeNull()
      expect(Math.abs(g!.grid.bpm - 128)).toBeLessThan(0.05)
    })
    it(`refines a tag of 128 to 128 at ${sampleRate}Hz`, () => {
      const g = detectBeatGrid({ channels: [clicks(128, sampleRate, 60)], sampleRate }, { hintBpm: 128 })
      expect(Math.abs(g!.grid.bpm - 128)).toBeLessThan(0.05)
    })
  }
})
