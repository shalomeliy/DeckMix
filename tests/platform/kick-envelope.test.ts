import { describe, expect, it } from 'vitest'
import { buildOnsetEnvelope, kickEnvelope } from '@/platform/analyzer-js/beat'

/**
 * `core/downbeat.ts` was measured (v0.9.5) on `buildOnsetEnvelope`'s lowest
 * band; the deck computes it with the faster `kickEnvelope`. If the two drift,
 * the 53/61 that justified shipping no longer describes what ships.
 */
describe('kickEnvelope', () => {
  it('is exactly buildOnsetEnvelope bands[0], mono, stereo and 3 channels', () => {
    const sr = 44100
    const n = sr * 3
    const a = new Float32Array(n)
    const b = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const t = i / sr
      a[i] = Math.sin(2 * Math.PI * 55 * t) * Math.exp(-((t % 0.5) * 8)) + 0.2 * Math.sin(2 * Math.PI * 3000 * t)
      b[i] = 0.5 * Math.sin(2 * Math.PI * 90 * t)
    }
    for (const channels of [[a], [a, b], [a, b, a.map((v) => -v)]]) {
      const pcm = { channels, sampleRate: sr }
      const { low, framesPerSec } = kickEnvelope(pcm)
      const ref = buildOnsetEnvelope(pcm)
      expect(framesPerSec).toBe(ref.framesPerSec)
      expect(low.length).toBe(ref.bands[0].length)
      let worst = 0
      for (let i = 0; i < low.length; i++) worst = Math.max(worst, Math.abs(low[i] - ref.bands[0][i]))
      expect(worst).toBeLessThan(1e-6)
    }
  })
})
