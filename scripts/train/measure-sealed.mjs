/**
 * v0.9.11: open the SEALED clips — once. The frozen model (src/core/sound/vocal-model.json) scores the 10 songs / 30 clips the owner
 * tagged and that no fit, no threshold and no choice of variant ever saw.
 *
 *   node --import ./scripts/train/alias-register.mjs scripts/train/measure-sealed.mjs
 *
 * Reads %TEMP%/vocal-features.json (scripts/dump-vocal-features.mjs) and the newest tags file (TAGS=...). It refuses to run when
 * docs/handoff/sealed-result-v0.9.11.json exists: the result is the record, and measuring again after seeing it is tuning on the test.
 * To run it again on purpose, delete that file in the open — that is the named exemption. Labels: the first-pass answers (sealed
 * clips are never re-asked), "unsure" counted as "no" like in training. Trance is a rule here too: always "no vocal".
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { cellFeatureRows, CELL_SEC } from '../../src/core/sound/cell-features.ts'
import { cellProbabilities, meanProbability, parseVocalModel } from '../../src/core/sound/vocal-model.ts'

const OUT = process.env.SEALED_RESULT ?? new URL('../../docs/handoff/sealed-result-v0.9.11.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
if (fs.existsSync(OUT)) {
  console.log(`REFUSED: ${OUT} already exists — the sealed clips were opened. Read that file instead of measuring again.`)
  process.exit(1)
}
const modelPath = new URL('../../src/core/sound/vocal-model.json', import.meta.url)
const modelBytes = fs.readFileSync(modelPath)
const model = parseVocalModel(JSON.parse(modelBytes.toString('utf8')))
const tags = JSON.parse(fs.readFileSync(process.env.TAGS ?? path.join(os.homedir(), 'Downloads', 'tags.json'), 'utf8'))
const feats = new Map(JSON.parse(fs.readFileSync(path.join(process.env.TEMP, 'vocal-features.json'), 'utf8')).map((x) => [x.s.hash, x.r]))

const rowsBySong = new Map()
const clips = []
const skipped = []
for (const v of tags.vocal) {
  if (!v.holdout) continue
  const f = feats.get(v.contentHash)
  if (!f || !f.harmonic) {
    skipped.push(`${v.trackId} (no features)`)
    continue
  }
  if (!rowsBySong.has(v.contentHash)) rowsBySong.set(v.contentHash, cellFeatureRows(f, f.harmonic.length * f.frameSec))
  const rows = rowsBySong.get(v.contentHash)
  const a = Math.floor(v.atSec / CELL_SEC)
  const b = Math.min(rows.length, Math.ceil((v.atSec + 5) / CELL_SEC))
  const { probs, genreKnown } = cellProbabilities(rows, v.genre, model)
  const p = meanProbability(probs, a, b)
  const truth = v.answer === 'yes' ? 'yes' : 'no' // "unsure" counts as "no", like in training
  const rule = v.genre === 'Trance'
  const predicted = rule ? 'no' : p >= 0.5 ? 'yes' : 'no'
  clips.push({ name: v.name, genre: v.genre, clipIndex: v.clipIndex ?? 0, atSec: v.atSec, answer: v.answer, truth, p: Math.round(p * 1000) / 1000, predicted, byRule: rule, genreKnown })
}
const n = clips.length
const right = clips.filter((c) => c.truth === c.predicted).length
const yes = clips.filter((c) => c.truth === 'yes').length
const confusion = { yesAsYes: 0, yesAsNo: 0, noAsYes: 0, noAsNo: 0 }
for (const c of clips) confusion[`${c.truth}As${c.predicted === 'yes' ? 'Yes' : 'No'}`]++
const byGenre = {}
for (const c of clips) {
  const g = (byGenre[c.genre] ??= { n: 0, right: 0 })
  g.n++
  if (c.truth === c.predicted) g.right++
}
const result = {
  openedAt: new Date().toISOString(),
  model: { sha256: crypto.createHash('sha256').update(modelBytes).digest('hex'), provenance: model.provenance },
  clips: n, songs: new Set(clips.map((c) => c.name)).size, agreement: n ? right / n : null,
  alwaysNoBase: n ? 1 - yes / n : null, alwaysYesBase: n ? yes / n : null,
  confusion, byGenre, skipped, perClip: clips,
}
console.log(`sealed: ${n} clips from ${result.songs} songs; model sha256 ${result.model.sha256.slice(0, 12)}…`)
console.log(`agreement ${right}/${n} = ${(100 * result.agreement).toFixed(0)}%   (always "yes" would be ${(100 * result.alwaysYesBase).toFixed(0)}%, always "no" ${(100 * result.alwaysNoBase).toFixed(0)}%)`)
console.log('confusion', JSON.stringify(confusion))
for (const [g, v] of Object.entries(byGenre)) console.log(`  ${g}: ${v.right}/${v.n}`)
if (skipped.length) console.log(`SKIPPED ${skipped.length}: ${skipped.join(' | ')}`)
for (const c of clips) console.log(`  ${c.genre.padEnd(8)} ${String(c.p).padEnd(5)} said ${c.predicted.padEnd(3)} truth ${c.truth.padEnd(3)} (${c.answer}) ${c.name.slice(0, 40)}${c.byRule ? ' [rule]' : ''}`)
fs.writeFileSync(OUT, JSON.stringify(result, null, 1))
console.log(`written ${OUT}`)
