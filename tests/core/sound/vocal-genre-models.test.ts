import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FEATURE_NAMES } from '@/core/sound/cell-features.ts'
import { cellProbabilities, parseVocalModel } from '@/core/sound/vocal-model.ts'

/**
 * The genre models fitted on the owner's own hand marks (04/10, his request: "I marked all the Techno songs in my library — make the Techno
 * analysis follow my marks"). Techno only: 42 marked songs, scripts/train/fit-genre-marks.py, leave-one-song-out 75.9% -> 78.3% agreement
 * with his marks (18 songs better, 6 worse). The hash makes a refit a decision: new marks -> refit -> new number -> new hash + VOCAL_STRIP_VERSION.
 */
const FILE = 'src/core/sound/vocal-genre-models.json'
const FROZEN_SHA256 = '885fb724bcadfe12aa079d68fe22061841b87d264e86378ac60ab12d4dfb9051'

describe('genre models from his marks', () => {
  const raw = readFileSync(FILE)
  const model = parseVocalModel(JSON.parse(readFileSync('src/core/sound/vocal-model.json', 'utf8')), JSON.parse(raw.toString('utf8')))
  it('is byte-for-byte the file that was fitted', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(FROZEN_SHA256)
  })
  it('has Techno only, fitted on his 42 marked Techno songs, and records what it was measured at', () => {
    expect(Object.keys(model.genreModels ?? {})).toEqual(['Techno'])
    const p = model.genreModels!.Techno.provenance
    expect(p.songs).toBe(42)
    expect(p.looAgreement).toBeGreaterThan(p.frozenAgreement as number)
  })
  it('is used for Techno and for nothing else', () => {
    const avg = [...FEATURE_NAMES].map((_, j) => model.mean[j])
    expect(cellProbabilities([avg], 'Techno', model).fromOwnerMarks).toBe(true)
    for (const g of ['House', 'Hip Hop', 'Mizrahi', 'Trance']) expect(cellProbabilities([avg], g, model).fromOwnerMarks).toBe(false)
  })
})
