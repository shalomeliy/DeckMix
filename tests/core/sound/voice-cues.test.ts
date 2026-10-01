import { describe, expect, it } from 'vitest'
import { MFCC_COUNT, voiceCues } from '@/core/sound/voice-cues.ts'
import { createRng } from '@/core/sound/synth/rng.ts'

const HZ = 10.77
const KLO = 9
const B = 455
const FRAMES = 60

/** A spectrogram of `partials` sharp peaks whose frequency at frame t is f0(t) × partial number. */
function spectrogram(f0: (t: number) => number, partials = 4): Float32Array {
  const mag = new Float32Array(FRAMES * B)
  for (let t = 0; t < FRAMES; t++) {
    for (let p = 1; p <= partials; p++) {
      const bin = (f0(t) * p) / HZ - KLO
      const j = Math.round(bin)
      // Peak plus a skirt, with the fractional position showing in the skirt so interpolation can see it.
      for (let d = -2; d <= 2; d++) {
        if (j + d >= 0 && j + d < B) mag[t * B + j + d] = Math.exp(-((j + d - bin) ** 2) / 0.5) / p
      }
    }
  }
  return mag
}
const avg = (x: Float32Array, a = 5): number => x.slice(a).reduce((s, v) => s + v, 0) / (x.length - a)

describe('voiceCues', () => {
  it('sees a held note as steady and a wobbling one as moving', () => {
    const held = voiceCues(spectrogram(() => 220), FRAMES, B, KLO, HZ)
    const wobble = voiceCues(spectrogram((t) => 220 * Math.pow(2, (25 * Math.sin(t * 0.9)) / 1200)), FRAMES, B, KLO, HZ)
    expect(avg(held.consist)).toBeGreaterThan(0.8)
    expect(avg(held.fluct)).toBeLessThan(3)
    expect(avg(wobble.consist)).toBeGreaterThan(0.6)
    expect(avg(wobble.fluct)).toBeGreaterThan(avg(held.fluct) + 3)
  })

  it('does not call noise a voice: peaks do not survive from frame to frame', () => {
    const r = createRng(5)
    const noise = Float32Array.from({ length: FRAMES * B }, () => r())
    const cues = voiceCues(noise, FRAMES, B, KLO, HZ)
    expect(avg(cues.consist)).toBeLessThan(0.5)
    expect(avg(cues.flat)).toBeGreaterThan(0.4)
  })

  it('gives a peaky spectrum a lower flatness than noise', () => {
    const peaky = voiceCues(spectrogram(() => 220), FRAMES, B, KLO, HZ)
    const r = createRng(6)
    const noise = voiceCues(Float32Array.from({ length: FRAMES * B }, () => 0.5 + r()), FRAMES, B, KLO, HZ)
    expect(avg(peaky.flat)).toBeLessThan(avg(noise.flat))
  })

  it('returns finite numbers and the right shapes, even for an all-zero spectrogram', () => {
    const c = voiceCues(new Float32Array(FRAMES * B), FRAMES, B, KLO, HZ)
    expect(c.mfcc.length).toBe(FRAMES * MFCC_COUNT)
    for (const a of [c.fluct, c.consist, c.flat, c.mfcc]) expect(a.every(Number.isFinite)).toBe(true)
  })
})
