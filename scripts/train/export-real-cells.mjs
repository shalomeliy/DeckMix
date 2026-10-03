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
// v0.9.11: the owner's blind re-check answers REPLACE his first-pass answer for the same clip. On 03/10, 47% of his earlier 'no' in
// House/Techno (46 of 98) turned out to be 'unsure' or 'yes' on a second look, while 37 of 39 'yes' held — so the first-pass 'no' is the
// noisy label. A re-check 'unsure' is not a label to learn from; it is counted below, never dropped silently.
const review = new Map((tags.vocalReview ?? []).map((r) => [`${r.contentHash}:${r.clipIndex}`, r]))
let reviewed = 0
let reviewDiffers = 0
const rowsBySong = new Map()
const unsure = {}
const noFeatures = new Set()
const clips = []
for (const v of tags.vocal) {
  if (v.holdout) continue // sealed: never read
  let answer = v.answer
  const r = review.get(`${v.contentHash}:${v.clipIndex ?? 0}`)
  if (r) {
    reviewed++
    if (r.answer !== v.answer) reviewDiffers++
    answer = r.answer
  }
  if (answer !== 'yes' && answer !== 'no') {
    // 'unsure' is a real answer the owner can give; it is not a label to learn from, but it is counted, never dropped silently.
    unsure[v.genre] = (unsure[v.genre] ?? 0) + 1
    continue
  }
  const f = feats.get(v.contentHash)
  if (!f || !f.harmonic) {
    // A song whose features failed (e.g. it would not decode) takes its clips with it: say so.
    noFeatures.add(v.trackId)
    continue
  }
  if (!rowsBySong.has(v.contentHash)) rowsBySong.set(v.contentHash, cellFeatureRows(f, f.harmonic.length * f.frameSec))
  const rows = rowsBySong.get(v.contentHash)
  const a = Math.floor(v.atSec / CELL_SEC)
  const b = Math.min(rows.length, Math.ceil((v.atSec + CLIP) / CELL_SEC))
  clips.push({ genre: v.genre, answer, pick: v.pick ?? 'random', hash: v.contentHash.slice(0, 8), mono: !f.stereo, rows: rows.slice(a, b) })
}
const out = path.join(process.env.TEMP, 'real-cells.json')
fs.writeFileSync(out, JSON.stringify({ names: FEATURE_NAMES, clips }))
console.log(`re-check answers used instead of the first pass: ${reviewed} clips, ${reviewDiffers} of them differ`)
const unsureTotal = Object.values(unsure).reduce((a, b) => a + b, 0)
console.log(`unsure answers left out (sealed clips excluded): ${unsureTotal}${unsureTotal ? ' (' + Object.entries(unsure).map(([g, n]) => `${g} ${n}`).join(', ') + ')' : ''}`)
if (noFeatures.size) console.log(`WARNING ${noFeatures.size} song(s) have no features and are left out: ${[...noFeatures].join(' | ')}`)
console.log(`${clips.length} training clips (yes ${clips.filter((c) => c.answer === 'yes').length}, no ${clips.filter((c) => c.answer === 'no').length}) -> ${out}`)
