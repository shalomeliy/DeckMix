import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FEATURE_NAMES } from '@/core/sound/cell-features.ts'
import { cellProbabilities, parseVocalModel } from '@/core/sound/vocal-model.ts'

/**
 * The frozen vocal model (v0.9.11, 03/10): "synthetic + real x10 + genre offset", fitted on 957 of the owner's clips (319 songs, his
 * blind re-check answers over his first ones, "unsure" counted as "no") plus 62,070 synthetic cells. The 10 sealed songs were never read.
 * The hash makes a change to this file a decision: a new model means a new measurement, and the sealed songs are opened ONCE.
 */
const FILE = 'src/core/sound/vocal-model.json'
const FROZEN_SHA256 = 'b5a8ae3474645c446f62bfef39568e1f4e3148e5de2b1f9565ecf69c69b1cae9'

describe('frozen vocal model', () => {
  const raw = readFileSync(FILE)
  it('is byte-for-byte the file that was frozen', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(FROZEN_SHA256)
  })
  const model = parseVocalModel(JSON.parse(raw.toString('utf8')))
  it('loads, and was trained on exactly the features this build computes', () => {
    expect(model.featureNames).toEqual([...FEATURE_NAMES])
    expect(model.genres).toEqual(['Hip Hop', 'House', 'Mizrahi', 'Techno', 'Trance'])
    expect(model.provenance.realClips).toBe(957)
  })
  it('gives a probability in (0,1) for an average row in every genre, and says when a genre is unknown', () => {
    const avg = [...FEATURE_NAMES].map((_, j) => model.mean[j])
    for (const g of model.genres) {
      const r = cellProbabilities([avg], g, model)
      expect(r.genreKnown).toBe(true)
      expect(r.probs[0]).toBeGreaterThan(0)
      expect(r.probs[0]).toBeLessThan(1)
    }
    expect(cellProbabilities([avg], 'Jazz', model).genreKnown).toBe(false)
  })
  it('scores a clearly voiced-looking row above a clearly empty one (the level cues carry most of the weight)', () => {
    const idx = (n: string) => FEATURE_NAMES.indexOf(n)
    const quiet = [...FEATURE_NAMES].map((_, j) => model.mean[j])
    const loud = [...quiet]
    for (const n of ['rel_level_mean', 'rel_level_ctx5']) loud[idx(n)] = model.mean[idx(n)] + 2 * model.scale[idx(n)]
    for (const n of ['rel_level_mean', 'rel_level_ctx5']) quiet[idx(n)] = model.mean[idx(n)] - 2 * model.scale[idx(n)]
    expect(cellProbabilities([loud], 'House', model).probs[0]).toBeGreaterThan(cellProbabilities([quiet], 'House', model).probs[0])
  })
})
