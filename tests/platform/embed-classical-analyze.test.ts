import { describe, expect, it } from 'vitest'
import { computeClassicalEmbedding, CLASSICAL_EMBEDDING_LENGTH } from '@/platform/embed-classical/analyze'
import type { PcmData } from '@/core/ports/analyzer'

const SAMPLE_RATE = 44100

/** A few seconds of a pure tone — enough frames for a stable average, synthetic so no real audio file is needed (`workshop-output/PLAN.md`'s smoke-test step, but as a permanent test since Meyda needs no browser API). */
function sineTone(freqHz: number, seconds = 3): PcmData {
  const length = Math.floor(SAMPLE_RATE * seconds)
  const samples = new Float32Array(length)
  for (let i = 0; i < length; i++) samples[i] = Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE)
  return { channels: [samples], sampleRate: SAMPLE_RATE }
}

describe('computeClassicalEmbedding', () => {
  it('refuses silent audio instead of returning a zero vector (23/09: 349 zero vectors in the real library)', async () => {
    const silent: PcmData = { channels: [new Float32Array(SAMPLE_RATE * 2)], sampleRate: SAMPLE_RATE }
    await expect(computeClassicalEmbedding(silent)).rejects.toThrow(/no usable signal/)
  })

  it('returns a fixed-length vector with no NaN/Infinity', async () => {
    const vector = await computeClassicalEmbedding(sineTone(440))
    expect(vector.length).toBe(CLASSICAL_EMBEDDING_LENGTH)
    for (const v of vector) {
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('produces different vectors for clearly different tones', async () => {
    const low = await computeClassicalEmbedding(sineTone(220))
    const high = await computeClassicalEmbedding(sineTone(4000))
    expect(Array.from(low)).not.toEqual(Array.from(high))
  })

  it('is stable across repeated runs on the same input', async () => {
    const a = await computeClassicalEmbedding(sineTone(440))
    const b = await computeClassicalEmbedding(sineTone(440))
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('downmixes multi-channel input instead of only reading channel 0', async () => {
    const left = sineTone(220).channels[0]
    const right = sineTone(4000).channels[0]
    const stereo: PcmData = { channels: [left, right], sampleRate: SAMPLE_RATE }
    const mono = await computeClassicalEmbedding({ channels: [left], sampleRate: SAMPLE_RATE })
    const result = await computeClassicalEmbedding(stereo)
    expect(Array.from(result)).not.toEqual(Array.from(mono))
  })

  it('throws on a track shorter than one frame', async () => {
    const tiny: PcmData = { channels: [new Float32Array(100)], sampleRate: SAMPLE_RATE }
    await expect(computeClassicalEmbedding(tiny)).rejects.toThrow(/too short/)
  })
})
