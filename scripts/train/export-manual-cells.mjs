/**
 * v0.9.10b: the owner's HAND-MADE vocal marks as labelled cells — whole songs, not 5 s clips.
 *   node --import ./scripts/train/alias-register.mjs scripts/train/export-manual-cells.mjs
 *   needs: MARKS=<deckmix-vocal-marks-*.json> (the app's "ייצא סימונים") and %TEMP%/vocal-features-manual.json
 *          (MARKS=<same file> node scripts/dump-vocal-features.mjs, with `npm run dev` running)
 *   writes: %TEMP%/manual-cells.json (training pool) and %TEMP%/manual-cells-sealed.json (the sealed songs)
 *
 * What counts as a label (every rule is counted and printed — nothing is dropped silently):
 *  - only songs he marked "finished" AND taught ("למד את המחשב מהשיר הזה" — his explicit "this one is a correct lesson"): from then on EVERYTHING he did not colour is "no voice", so every cell has a label. A draft song labels
 *    only the cells he coloured, which would teach "voice everywhere you looked"; drafts are left out and counted;
 *  - cells within IGNORE_CELLS of the edge of a mark are label 2 = "ignore": his reaction time puts the edge a fraction of a second off, and
 *    the app widens it by half a second on purpose (MARK_LEAD_SEC / MARK_TAIL_SEC), so the cells beside an edge are not an answer;
 *  - Trance is a RULE, not a measurement (HANDOFF.md): its songs are left out and counted;
 *  - SEALED: ~20% of the marked songs, picked by the first byte of the content hash (the same song is always on the same side, whatever else is
 *    added). They go to their own file, which no fit script reads. A held-out test that was looked at while choosing stops being one.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { cellFeatureRows, FEATURE_NAMES } from '../../src/core/sound/cell-features.ts'
import { regionMask } from '../../src/core/sound/vocal-manual.ts'

const IGNORE_CELLS = 2
const SEALED_BELOW = 51 // of 256
const marks = JSON.parse(fs.readFileSync(process.env.MARKS, 'utf8'))
if (marks.kind !== 'vocal-marks' || marks.schema !== 1) throw new Error('MARKS is not a DeckMix vocal-marks file (kind/schema)')
const feats = new Map(JSON.parse(fs.readFileSync(path.join(process.env.TEMP, 'vocal-features-manual.json'), 'utf8')).map((x) => [x.s.hash, x.r]))

const count = { drafts: 0, notTaught: 0, trance: 0, noFeatures: [], songs: 0, sealed: 0 }
const train = []
const sealed = []
for (const m of marks.marks) {
  if (!m.finished) { count.drafts++; continue }
  if (!m.taught) { count.notTaught++; continue }
  if (m.genre === 'Trance') { count.trance++; continue }
  const f = feats.get(m.contentHash)
  if (!f || !f.harmonic) { count.noFeatures.push(m.name); continue }
  const dur = f.harmonic.length * f.frameSec
  const rows = cellFeatureRows(f, dur)
  const mask = regionMask(m.regions, rows.length * 0.5)
  const labels = Array.from(mask)
  const edge = new Array(labels.length).fill(false)
  for (let i = 1; i < labels.length; i++) if (labels[i] !== labels[i - 1]) for (let k = i - IGNORE_CELLS; k < i + IGNORE_CELLS; k++) if (k >= 0 && k < labels.length) edge[k] = true
  for (let i = 0; i < labels.length; i++) if (edge[i]) labels[i] = 2
  const isSealed = parseInt(crypto.createHash('sha256').update(m.contentHash).digest('hex').slice(0, 2), 16) < SEALED_BELOW
  const song = { hash: m.contentHash, name: m.name, genre: m.genre ?? '', rows, labels, stereo: !!f.stereo }
  ;(isSealed ? sealed : train).push(song)
  count.songs++
  if (isSealed) count.sealed++
}
const out = (name, songs) => fs.writeFileSync(path.join(process.env.TEMP, name), JSON.stringify({ names: [...FEATURE_NAMES], songs }))
out('manual-cells.json', train)
out('manual-cells-sealed.json', sealed)
const cells = (ss) => ss.reduce((a, s) => a + s.labels.length, 0)
const voice = train.reduce((a, s) => a + s.labels.filter((l) => l === 1).length, 0)
const ign = train.reduce((a, s) => a + s.labels.filter((l) => l === 2).length, 0)
console.log(`marked songs in the file: ${marks.marks.length}`)
console.log(`  left out: ${count.drafts} not finished, ${count.notTaught} finished but not taught (press "למד את המחשב מהשיר הזה" on them), ${count.trance} Trance (rule), ${count.noFeatures.length} without features${count.noFeatures.length ? ': ' + count.noFeatures.join(', ') : ''}`)
console.log(`  training pool: ${train.length} songs, ${cells(train)} cells (voice ${voice}, ignored near edges ${ign}) -> manual-cells.json`)
console.log(`  sealed (not read by any fit): ${sealed.length} songs -> manual-cells-sealed.json`)
