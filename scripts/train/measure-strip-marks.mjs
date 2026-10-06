/**
 * How close is the vocal strip the app draws to the owner's hand marks? Runs the SHIPPED cellsFromProbabilities (core/sound/vocal-strip.ts)
 * on the output of dump-strip-probs.mjs and scores it against his marks, read with his rule: a stop of MAX_GAP_SEC or less inside his singing
 * is still singing (2 s from 03/10, 0.5 s from 06/10).
 *   node --import ./scripts/train/alias-register.mjs scripts/train/measure-strip-marks.mjs <probs.json>
 * Prints per song and in total: agreement per half second, misses (his voice drawn as none), false alarms, how many voice sections were
 * drawn against how many he has, and how many of his section edges have one drawn within 2 s.
 * 04/10, his 20 songs: the old strip 71.6% / 287 sections ("unsure" counted as none, as here) against 78 of his; the rework 75.3% / 84. (The
 * edge figure falls with the rework: the old strip put an edge beside nearly every word, so most of his edges had one near by luck.)
 */
import fs from 'node:fs'
import { MAX_GAP_SEC, cellsFromProbabilities } from '../../src/core/sound/vocal-strip.ts'
import { manualLabels } from '../../src/core/sound/vocal-manual.ts'
import { CELL_NONE, CELL_VOCAL } from '../../src/core/sound/vocal-timeline.ts'

const GAP_CELLS = Math.round(MAX_GAP_SEC / 0.5) // his rule, in half seconds — the shipped one, so the score never uses a rule the app does not
const songs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const runs = (x) => { const r = []; let s = 0; for (let i = 1; i <= x.length; i++) if (i === x.length || x[i] !== x[s]) { r.push([s, i, x[s]]); s = i } return r }
function hisTruth(s) {
  const t = Uint8Array.from(manualLabels(s.regions, s.probs.length * 0.5)).slice(0, s.probs.length)
  const rs = runs(t)
  rs.forEach(([a, b, v], k) => { if (v === CELL_NONE && k > 0 && k < rs.length - 1 && b - a <= GAP_CELLS) t.fill(CELL_VOCAL, a, b) })
  return t
}
const edges = (x) => { const e = []; for (let i = 1; i < x.length; i++) if (x[i] !== x[i - 1]) e.push(i); return e }
const tot = { n: 0, ok: 0, miss: 0, fa: 0, drawn: 0, his: 0, edges: 0, near: 0 }
for (const s of songs) {
  const t = hisTruth(s)
  const c = cellsFromProbabilities(s.probs)
  let ok = 0, miss = 0, fa = 0
  for (let i = 0; i < t.length; i++) {
    const v = c[i] === CELL_VOCAL ? 1 : 0, h = t[i] === CELL_VOCAL ? 1 : 0
    if (v === h) ok++; else if (h) miss++; else fa++
  }
  const drawn = runs(c).filter((r) => r[2] === CELL_VOCAL).length, his = runs(t).filter((r) => r[2] === CELL_VOCAL).length
  const ce = edges(c), te = edges(t)
  const near = te.filter((e) => ce.some((d) => Math.abs(d - e) <= 4)).length
  Object.entries({ n: t.length, ok, miss, fa, drawn, his, edges: te.length, near }).forEach(([k, v]) => (tot[k] += v))
  console.log(`${s.name.slice(0, 44).padEnd(44)} ${((100 * ok) / t.length).toFixed(0).padStart(3)}%  sections ${drawn}/${his}`)
}
const pc = (a, b) => `${((100 * a) / b).toFixed(1)}%`
console.log(`\n${songs.length} songs: agreement ${pc(tot.ok, tot.n)} (misses ${pc(tot.miss, tot.n)}, false alarms ${pc(tot.fa, tot.n)}), sections ${tot.drawn} drawn / ${tot.his} his, his edges with one within 2 s ${pc(tot.near, tot.edges)}`)
