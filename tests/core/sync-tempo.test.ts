import { describe, expect, it } from 'vitest'
import { syncTempoFor, tempoToRate } from '@/core/constants'

const RANGE = 0.08

describe('syncTempoFor', () => {
  it('matches the master exactly when its fader is at zero', () => {
    const t = syncTempoFor(125, 0, 119, RANGE)
    expect(119 * tempoToRate(t, RANGE)).toBeCloseTo(125, 6)
  })

  it('follows the master AUDIBLE bpm, not its native bpm, when the master is tempo-shifted', () => {
    // The reported bug: master native 125 at -4.8% plays at ~119; the old code
    // synced to 125 and left the decks 6 BPM apart.
    const masterTempo = -0.048 / RANGE
    const t = syncTempoFor(125, masterTempo, 119, RANGE)
    const masterAudible = 125 * tempoToRate(masterTempo, RANGE)
    expect(119 * tempoToRate(t, RANGE)).toBeCloseTo(masterAudible, 6)
    expect(masterAudible).toBeCloseTo(119, 1)
  })
})
