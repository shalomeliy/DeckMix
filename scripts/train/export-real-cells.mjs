/**
 * v0.12.15: the owner's TRAINING clips as per-cell feature rows, for measuring the classifier.
 *   node scripts/train/export-real-cells.mjs  ->  %TEMP%/real-cells.json
 * Reads %TEMP%/vocal-features.json (scripts/dump-vocal-features.mjs). Sealed (`holdout`) clips are
 * dropped the moment the tags are read — the same rule as scripts/fit-vocal-params.mjs, and for the same
 * reason: this file has no flag that opens them.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cellFeatureRows, FEATURE_NAMES, CELL_SEC } from './cell-features.mjs'

const tags = JSON.parse(fs.readFileSync(process.env.TAGS ?? path.join(os.homedir(), 'Downloads', 'deckmix-tags-2026-10-02- 100 vocals.json'), 'utf8'))
const feats = new Map(JSON.parse(fs.readFileSync(path.join(process.env.TEMP, 'vocal-features.json'), 'utf8')).map((x) => [x.s.hash, x.r]))
const CLIP = 5
const rowsBySong = new Map()
const clips = []
for (const v of tags.vocal) {
  if (v.holdout) continue // sealed: never read
  if (v.answer !== 'yes' && v.answer !== 'no') continue
  const f = feats.get(v.contentHash)
  if (!f || !f.harmonic) continue
  if (!rowsBySong.has(v.contentHash)) rowsBySong.set(v.contentHash, cellFeatureRows(f, f.harmonic.length * f.frameSec))
  const rows = rowsBySong.get(v.contentHash)
  const a = Math.floor(v.atSec / CELL_SEC)
  const b = Math.min(rows.length, Math.ceil((v.atSec + CLIP) / CELL_SEC))
  clips.push({ genre: v.genre, answer: v.answer, pick: v.pick ?? 'random', hash: v.contentHash.slice(0, 8), mono: !f.stereo, rows: rows.slice(a, b) })
}
const out = path.join(process.env.TEMP, 'real-cells.json')
fs.writeFileSync(out, JSON.stringify({ names: FEATURE_NAMES, clips }))
console.log(`${clips.length} training clips (yes ${clips.filter((c) => c.answer === 'yes').length}, no ${clips.filter((c) => c.answer === 'no').length}) -> ${out}`)
