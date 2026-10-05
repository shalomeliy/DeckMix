import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FEATURE_NAMES } from '@/core/sound/cell-features.ts'
import { cellProbabilities, parseVocalModel } from '@/core/sound/vocal-model.ts'

/**
 * The genre models fitted on the owner's own hand marks (04/10, his request: "I marked all the Techno songs in my library — make the Techno
 * analysis follow my marks"). Techno: 42 marked songs, scripts/train/fit-genre-marks.py, leave-one-song-out 75.9% -> 78.3% agreement
 * with his marks (18 songs better, 6 worse). House (05/10, "I finished all the House songs too"): 31 marked songs, fitted with his Techno songs
 * as extra lessons (--pool), 71.5% -> 75.3% (14 better, 11 worse); House alone gave 73.0%. The hash makes a refit a decision: new marks -> refit -> new number -> new hash + VOCAL_STRIP_VERSION.
 */
const FILE = 'src/core/sound/vocal-genre-models.json'
const FROZEN_SHA256 = 'f35d106df8edefebfd805c27bd8e7053b76febb67b8507a30c7ec8cb8594599b'

describe('genre models from his marks', () => {
  const raw = readFileSync(FILE)
  const model = parseVocalModel(JSON.parse(readFileSync('src/core/sound/vocal-model.json', 'utf8')), JSON.parse(raw.toString('utf8')))
  it('is byte-for-byte the file that was fitted', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(FROZEN_SHA256)
  })
  it('has Techno and House, each fitted on his own marked songs in that genre, and records what it was measured at', () => {
    expect(Object.keys(model.genreModels ?? {}).sort()).toEqual(['House', 'Techno'])
    const t = model.genreModels!.Techno.provenance
    expect(t.songs).toBe(42)
    expect(t.looAgreement).toBeGreaterThan(t.frozenAgreement as number)
    const h = model.genreModels!.House.provenance
    expect(h.songs).toBe(31)
    expect(h.pooledFrom).toEqual(['Techno'])
    expect(h.looAgreement).toBeGreaterThan(h.frozenAgreement as number)
  })
  it('is used for Techno and House and for nothing else', () => {
    const avg = [...FEATURE_NAMES].map((_, j) => model.mean[j])
    for (const g of ['Techno', 'House']) expect(cellProbabilities([avg], g, model).fromOwnerMarks).toBe(true)
    for (const g of ['Hip Hop', 'Mizrahi', 'Trance']) expect(cellProbabilities([avg], g, model).fromOwnerMarks).toBe(false)
  })
})
