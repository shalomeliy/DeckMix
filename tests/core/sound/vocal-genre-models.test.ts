import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FEATURE_NAMES } from '@/core/sound/cell-features.ts'
import { cellProbabilities, parseVocalModel } from '@/core/sound/vocal-model.ts'

/**
 * The genre models fitted on the owner's own hand marks (04/10, his request: "I marked all the Techno songs in my library — make the Techno
 * analysis follow my marks"). Techno: 42 marked songs, scripts/train/fit-genre-marks.py, leave-one-song-out 75.9% -> 78.3% agreement
 * with his marks (18 songs better, 6 worse). House (05/10, "I finished all the House songs too"): 31 marked songs, fitted with his Techno songs
 * as extra lessons (--pool), 71.5% -> 75.3% (14 better, 11 worse); House alone gave 73.0%. Mizrahi (06/10, v0.9.37, "I finished measuring
 * Mizrahi"): 79 songs after he went through the "maybe you marked this wrong" list and re-exported, his Techno and House songs as extra
 * lessons, read with his new 0.5 s rule: 79.4% -> 88.9% (58 better, 16 worse); alone 86.6% and House-only 86.7% on the earlier marks. The hash makes a refit a decision: new marks -> refit -> new number -> new hash + VOCAL_STRIP_VERSION.
 */
const FILE = 'src/core/sound/vocal-genre-models.json'
const FROZEN_SHA256 = '672169e612bdf7218c99eb57de7024a29d0fdd250c2716560841c1568136e191'

describe('genre models from his marks', () => {
  const raw = readFileSync(FILE)
  const model = parseVocalModel(JSON.parse(readFileSync('src/core/sound/vocal-model.json', 'utf8')), JSON.parse(raw.toString('utf8')))
  it('is byte-for-byte the file that was fitted', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(FROZEN_SHA256)
  })
  it('has Techno, House and Mizrahi, each fitted on his own marked songs in that genre, and records what it was measured at', () => {
    expect(Object.keys(model.genreModels ?? {}).sort()).toEqual(['House', 'Mizrahi', 'Techno'])
    const t = model.genreModels!.Techno.provenance
    expect(t.songs).toBe(42)
    expect(t.looAgreement).toBeGreaterThan(t.frozenAgreement as number)
    const h = model.genreModels!.House.provenance
    expect(h.songs).toBe(31)
    expect(h.pooledFrom).toEqual(['Techno'])
    expect(h.looAgreement).toBeGreaterThan(h.frozenAgreement as number)
    const m = model.genreModels!.Mizrahi.provenance
    expect(m.songs).toBe(79)
    expect(m.pooledFrom).toEqual(['Techno', 'House'])
    expect(m.looAgreement).toBeGreaterThan(m.frozenAgreement as number)
  })
  it('is used for Techno, House and Mizrahi and for nothing else', () => {
    const avg = [...FEATURE_NAMES].map((_, j) => model.mean[j])
    for (const g of ['Techno', 'House', 'Mizrahi']) expect(cellProbabilities([avg], g, model).fromOwnerMarks).toBe(true)
    for (const g of ['Hip Hop', 'Trance']) expect(cellProbabilities([avg], g, model).fromOwnerMarks).toBe(false)
  })
})
