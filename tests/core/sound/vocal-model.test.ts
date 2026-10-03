import { describe, expect, it } from 'vitest'
import { FEATURE_NAMES } from '@/core/sound/cell-features.ts'
import { cellProbabilities, meanProbability, parseVocalModel, VOCAL_MODEL_SCHEMA } from '@/core/sound/vocal-model.ts'

const NF = FEATURE_NAMES.length
/** A model that looks only at column 0, with a +2 offset for "House" and a -1 offset for "Techno". */
function model(over: Record<string, unknown> = {}) {
  const genres = ['House', 'Techno']
  const n = NF + genres.length
  const coef = new Array(n).fill(0)
  coef[0] = 1
  coef[NF] = 2
  coef[NF + 1] = -1
  return {
    schema: VOCAL_MODEL_SCHEMA,
    featureNames: [...FEATURE_NAMES],
    genres,
    mean: new Array(n).fill(0),
    scale: new Array(n).fill(1),
    coef,
    intercept: 0,
    provenance: { variant: 'test' },
    ...over,
  }
}
const row = (v0: number) => [v0, ...new Array(NF - 1).fill(0)]
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z))

describe('vocal model', () => {
  it('computes sigmoid(coef · standardised row) with the genre column as an offset', () => {
    const m = parseVocalModel(model())
    expect(cellProbabilities([row(0.5)], 'House', m).probs[0]).toBeCloseTo(sigmoid(0.5 + 2), 5)
    expect(cellProbabilities([row(0.5)], 'Techno', m).probs[0]).toBeCloseTo(sigmoid(0.5 - 1), 5)
  })
  it('standardises with the stored mean and scale, and leaves a zero scale alone', () => {
    const base = model()
    const mean = [...base.mean]
    const scale = [...base.scale]
    mean[0] = 1
    scale[0] = 4
    const m = parseVocalModel({ ...base, mean, scale })
    expect(cellProbabilities([row(5)], 'Techno', m).probs[0]).toBeCloseTo(sigmoid((5 - 1) / 4 - 1 - 0), 5)
    scale[0] = 0
    expect(cellProbabilities([row(5)], 'Techno', parseVocalModel({ ...base, mean, scale })).probs[0]).toBeCloseTo(sigmoid(5 - 1 - 1), 5)
  })
  it('says when the genre is not one it was trained with, instead of quietly using no offset', () => {
    const m = parseVocalModel(model())
    const r = cellProbabilities([row(0.5)], 'Jazz', m)
    expect(r.genreKnown).toBe(false)
    expect(r.probs[0]).toBeCloseTo(sigmoid(0.5), 5)
    expect(cellProbabilities([row(0.5)], 'House', m).genreKnown).toBe(true)
  })
  it('refuses a model trained on different features, with the wrong number of weights, or with a non-finite weight', () => {
    expect(() => parseVocalModel(model({ featureNames: [...FEATURE_NAMES].reverse() }))).toThrow(/different features/)
    expect(() => parseVocalModel(model({ coef: [1, 2, 3] }))).toThrow(/finite numbers/)
    const bad = model()
    bad.mean[3] = NaN
    expect(() => parseVocalModel(bad)).toThrow(/finite numbers/)
    expect(() => parseVocalModel(model({ schema: 99 }))).toThrow(/schema/)
    expect(() => parseVocalModel(null)).toThrow()
  })
  it('refuses a row with the wrong number of features', () => {
    expect(() => cellProbabilities([[1, 2, 3]], 'House', parseVocalModel(model()))).toThrow(/expected/)
  })
  it('scores a clip as the mean over its cells', () => {
    expect(meanProbability([0.2, 0.4, 0.9, 1], 1, 3)).toBeCloseTo(0.65, 9)
    expect(meanProbability([0.2, 0.4], 5, 9)).toBeNaN()
  })
})
