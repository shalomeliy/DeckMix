import { describe, expect, it } from 'vitest'
import { estimateTempo, multiBandOnset } from '@/core/tempo-estimate'

const FPS = 200

/** Band envelopes with a hit (a one-frame jump, decaying) at each given beat position, per band. */
function envelopes(bpm: number, seconds: number, pattern: { band: number; beats: number[] }[]): Float32Array[] {
  const n = seconds * FPS
  const bands = [0, 1, 2, 3].map(() => new Float32Array(n).fill(0.001))
  const barFrames = (4 * 60 * FPS) / bpm
  for (const { band, beats } of pattern) {
    for (let bar = 0; bar * barFrames < n; bar++) {
      for (const b of beats) {
        const start = Math.round(bar * barFrames + (b * barFrames) / 4)
        for (let k = 0; k < 20 && start + k < n; k++) bands[band][start + k] += 0.5 * Math.exp(-k / 5)
      }
    }
  }
  return bands
}

describe('estimateTempo', () => {
  it('four-on-the-floor at 128', () => {
    const bands = envelopes(128, 60, [
      { band: 0, beats: [0, 1, 2, 3] },
      { band: 3, beats: [0.5, 1.5, 2.5, 3.5] },
    ])
    expect(Math.abs(estimateTempo(multiBandOnset(bands), FPS)!.bpm - 128)).toBeLessThan(1)
  })

  // The 25/09 failure shape: a kick on 1 and the "and" of 2 (a dembow) makes
  // its own strong periodicity. Snare on 2 and 4 and steady hats carry the
  // beat, which a low-band-only estimate never heard.
  it('a dembow at 105 is 105, not 4/3 of it', () => {
    const bands = envelopes(105, 60, [
      { band: 0, beats: [0, 1.5, 2, 3.5] },
      { band: 2, beats: [0.75, 1, 2.75, 3] },
      { band: 3, beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] },
    ])
    expect(Math.abs(estimateTempo(multiBandOnset(bands), FPS)!.bpm - 105)).toBeLessThan(1)
  })

  it('says nothing for silence rather than guessing', () => {
    const silent = [0, 1, 2, 3].map(() => new Float32Array(60 * FPS))
    expect(estimateTempo(multiBandOnset(silent), FPS)).toBeNull()
  })

  it('says nothing for a clip too short to hold a bar', () => {
    const short = envelopes(128, 2, [{ band: 0, beats: [0, 1, 2, 3] }])
    expect(estimateTempo(multiBandOnset(short), FPS)).toBeNull()
  })
})
