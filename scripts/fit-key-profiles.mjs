/**
 * v0.8.27: build the key profiles from the owner's own tagged tracks, and say
 * honestly how well they do on tracks they were not built from.
 *
 *   node scripts/measure-key-detect.mjs        (writes %TEMP%/key-detect-rows.json)
 *   node scripts/fit-key-profiles.mjs          (reads it, prints profiles + accuracy)
 *
 * The owner's decision (24/09): learn the profiles from the keys already written
 * in his files, rather than use the 1982 classical-music profiles alone (those
 * scored 51% exact on the same tracks, these ~70%). Nothing is copied from any
 * program — only the statistics of answers already sitting in his tags.
 *
 * Profile = the average chroma of all tracks tagged in that mode, rotated so the
 * tagged tonic is index 0 and normalised to sum 1 first (a long track must not
 * outweigh a short one). A mode with fewer than MIN_MODE_TRACKS examples keeps
 * the published Krumhansl-Kessler profile — 14 major tracks were all the library
 * had on 24/09, too few to learn from without learning their quirks.
 *
 * Accuracy is 5-fold held out: every track is scored by profiles fitted on the
 * other four fifths. A score on tracks the profile was built from would be a
 * number that only measures memory.
 */
import fs from 'node:fs'
import path from 'node:path'

const MIN_MODE_TRACKS = 30
const FOLDS = 5
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
const MAJOR_PC = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
const MINOR_PC = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]

const rows = JSON.parse(fs.readFileSync(path.join(process.env.TEMP ?? '.', 'key-detect-rows.json'), 'utf8')).filter(
  (r) => r.tag && r.chroma,
)
const cam = (t, m) => `${(m ? MINOR_PC : MAJOR_PC)[t]}${m ? 'A' : 'B'}`
const fromCam = (c) => {
  const m = c.endsWith('A')
  return { t: (m ? MINOR_PC : MAJOR_PC).indexOf(Number(c.slice(0, -1))), m }
}
const norm = (c) => {
  const s = c.reduce((a, b) => a + b, 0) || 1
  return c.map((x) => x / s)
}
function pearson(a, b, rot) {
  let ma = 0, mb = 0
  for (let i = 0; i < 12; i++) { ma += a[(i + rot) % 12]; mb += b[i] }
  ma /= 12; mb /= 12
  let n = 0, da = 0, db = 0
  for (let i = 0; i < 12; i++) {
    const x = a[(i + rot) % 12] - ma, y = b[i] - mb
    n += x * y; da += x * x; db += y * y
  }
  return da < 1e-12 ? 0 : n / Math.sqrt(da * db)
}
function fit(train) {
  const acc = { true: new Array(12).fill(0), false: new Array(12).fill(0) }
  const n = { true: 0, false: 0 }
  for (const r of train) {
    const { t, m } = fromCam(r.tag)
    const c = norm(r.chroma)
    for (let i = 0; i < 12; i++) acc[m][i] += c[(i + t) % 12]
    n[m]++
  }
  const avg = (m, fallback) => (n[m] >= MIN_MODE_TRACKS ? acc[m].map((x) => x / n[m]) : fallback)
  return { major: avg(false, KK_MAJOR), minor: avg(true, KK_MINOR), n }
}
function detect(c, p) {
  const s = []
  for (let t = 0; t < 12; t++) {
    s.push({ t, m: false, s: pearson(c, p.major, t) })
    s.push({ t, m: true, s: pearson(c, p.minor, t) })
  }
  s.sort((a, b) => b.s - a.s)
  return { key: cam(s[0].t, s[0].m), margin: s[0].s - s[1].s }
}
const near = (d, t) => {
  const [tn, tl] = [Number(t.slice(0, -1)), t.slice(-1)]
  const [dn, dl] = [Number(d.slice(0, -1)), d.slice(-1)]
  return d === t || tn === dn || (tl === dl && Math.min((tn - dn + 12) % 12, (dn - tn + 12) % 12) === 1)
}

const scored = []
for (let f = 0; f < FOLDS; f++) {
  const p = fit(rows.filter((_, i) => i % FOLDS !== f))
  for (const r of rows.filter((_, i) => i % FOLDS === f)) scored.push({ ...detect(r.chroma, p), tag: r.tag })
}
const pct = (a, b) => `${((100 * a) / b).toFixed(1)}%`
console.log(`${rows.length} tagged tracks, ${FOLDS}-fold held out`)
console.log(`  exact ${pct(scored.filter((s) => s.key === s.tag).length, scored.length)}   exact-or-neighbour ${pct(scored.filter((s) => near(s.key, s.tag)).length, scored.length)}`)
for (const cut of [0, 0.01, 0.02, 0.03, 0.05, 0.08]) {
  const s = scored.filter((x) => x.margin >= cut)
  console.log(`  margin ≥ ${cut.toFixed(2)}: ${pct(s.length, scored.length)} of tracks, exact ${pct(s.filter((x) => x.key === x.tag).length, s.length)}`)
}
const kk = rows.map((r) => ({ ...detect(r.chroma, { major: KK_MAJOR, minor: KK_MINOR }), tag: r.tag }))
console.log(`  (published KK profiles on the same chroma: exact ${pct(kk.filter((s) => s.key === s.tag).length, kk.length)})`)

const final = fit(rows)
const fmt = (a) => `[${a.map((x) => x.toFixed(4)).join(', ')}]`
console.log(`\nFitted on all ${rows.length} (minor n=${final.n.true}, major n=${final.n.false}):`)
console.log(`export const LIBRARY_MINOR = ${fmt(final.minor)}`)
console.log(`export const LIBRARY_MAJOR = ${final.n.false >= MIN_MODE_TRACKS ? fmt(final.major) : 'KK_MAJOR // too few major tracks'}`)
