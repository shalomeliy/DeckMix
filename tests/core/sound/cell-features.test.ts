import { describe, expect, it } from 'vitest'
import { CELL_SEC, FEATURE_NAMES, cellFeatureRows, type CellFeatureInput } from '@/core/sound/cell-features.ts'

/**
 * The golden numbers below were produced by the original scripts/train/cell-features.mjs on this exact input, before it was
 * moved into core/ (v0.9.11). A trained vocal model is only meaningful on rows built the way its training rows were; if this test
 * has to change, every stored model has to be retrained.
 */
const n = 240
const frameSec = 0.05
const f = (k: number) => Array.from({ length: n }, (_, i) => Math.abs(Math.sin(i * 0.13 * k + k)))
const input: CellFeatureInput = {
  frameSec,
  stereo: true,
  harmonic: f(1),
  centre: f(2),
  bright: f(3),
  motion: f(4),
  level: f(5).map((v) => v * 3 - 20),
  cues: { mfcc: Array.from({ length: n * 5 }, (_, i) => Math.cos(i * 0.07)), fluct: f(6), consist: f(7), flat: f(8) },
}
const GOLD = {"names": ["harmonic_mean", "harmonic_std", "harmonic_ctx5", "centre_mean", "centre_std", "centre_ctx5", "bright_mean", "bright_std", "bright_ctx5", "motion_mean", "motion_std", "motion_ctx5", "rel_level_mean", "rel_level_std", "rel_level_ctx5", "stereo", "fluct_mean", "fluct_std", "fluct_ctx5", "consist_mean", "consist_std", "consist_ctx5", "flat_mean", "flat_std", "flat_ctx5", "mfcc_motion_mean", "mfcc_motion_std", "mfcc_motion_ctx5"], "row0": [0.93162, 0.05986, 0.69693, 0.56482, 0.28438, 0.60865, 0.55219, 0.32399, 0.6375, 0.72113, 0.26133, 0.64432, -1.08076, 0.99072, -1.05657, 1, 0.59585, 0.27386, 0.63343, 0.66231, 0.28487, 0.64997, 0.69346, 0.25665, 0.66267, 0.69766, 0.02372, 0.69509], "row7": [0.88714, 0.12334, 0.64672, 0.59965, 0.32874, 0.63374, 0.66431, 0.29118, 0.63187, 0.5739, 0.31661, 0.64147, -1.12502, 0.91165, -1.13204, 1, 0.67687, 0.31784, 0.63411, 0.63632, 0.29648, 0.63045, 0.6346, 0.33087, 0.61252, 0.69523, 0.0213, 0.69443], "last": [0.314, 0.18247, 0.57556, 0.5613, 0.29747, 0.62223, 0.69445, 0.31708, 0.64233, 0.69816, 0.29705, 0.63355, -1.14608, 0.97269, -1.13942, 1, 0.56205, 0.36895, 0.60721, 0.62908, 0.3046, 0.63515, 0.61363, 0.38079, 0.61061, 0.63673, 0.07333, 0.67241]}

describe('cellFeatureRows', () => {
  const rows = cellFeatureRows(input, n * frameSec)
  it('has 28 named columns and one row per half second', () => {
    expect(FEATURE_NAMES).toHaveLength(28)
    expect(FEATURE_NAMES).toEqual(GOLD.names)
    expect(rows).toHaveLength(Math.floor((n * frameSec) / CELL_SEC))
    expect(rows.every((r) => r.length === 28)).toBe(true)
  })
  it('matches the original implementation number for number', () => {
    expect(rows[0]).toEqual(GOLD.row0)
    expect(rows[7]).toEqual(GOLD.row7)
    expect(rows[rows.length - 1]).toEqual(GOLD.last)
  })
  it('puts the stereo flag at its own column', () => {
    const i = FEATURE_NAMES.indexOf('stereo')
    expect(rows.every((r) => r[i] === 1)).toBe(true)
    expect(cellFeatureRows({ ...input, stereo: false }, n * frameSec).every((r) => r[i] === 0)).toBe(true)
  })
  it('refuses features without voice cues instead of padding zeros', () => {
    expect(() => cellFeatureRows({ ...input, cues: undefined }, n * frameSec)).toThrow(/cues/)
  })
  it('stops at a non-finite feature, where the cause is', () => {
    const bad = { ...input, harmonic: f(1).map((v, i) => (i === 3 ? NaN : v)) }
    expect(() => cellFeatureRows(bad, n * frameSec)).toThrow(/non-finite/)
  })
})
