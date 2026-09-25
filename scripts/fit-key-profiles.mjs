/**
 * Build the per-band minor key profiles from the owner's own tagged tracks,
 * and say honestly how well they do on tracks they were not built from.
 *
 *   node scripts/measure-key-detect.mjs        (writes %TEMP%/key-detect-rows.json, per-band chroma)
 *   node scripts/fit-key-profiles.mjs          (reads it, prints profiles + accuracy)
 *
 * The owner's decision (24/09): learn the profiles from the keys already written
 * in his files, rather than use the 1982 classical-music profiles alone. Nothing
 * is copied from any program — only the statistics of answers already sitting in
 * his tags. Major keeps Krumhansl-Kessler in every band: 14 major tracks were all
 * the library had on 24/09, too few to learn from without learning their quirks.
 *
 * Profile (per band) = the average chroma of all minor-tagged tracks, rotated so
 * the tagged tonic is index 0. Scoring mirrors `keyFromBands` in
 * `core/key-detect.ts` exactly — band weights are read from that file, so this
 * script and the app cannot drift apart silently.
 *
 * Accuracy is 5-fold held out: every track is scored by profiles fitted on the
 * other four fifths. A score on tracks the profile was built from would be a
 * number that only measures memory.
 */
import fs from 'node:fs'
import path from 'node:path'

const FOLDS = 5
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MAJOR_PC = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
const MINOR_PC = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]

// the weights the app uses, read from its source
const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'core', 'key-detect.ts'), 'utf8')
const WEIGHTS = [...src.matchAll(/loHz: \d+, hiHz: \d+, weight: ([\d.]+)/g)].map((m) => Number(m[1]))
if (!WEIGHTS.length) throw new Error('could not read BANDS weights from core/key-detect.ts')

const rows = JSON.parse(fs.readFileSync(path.join(process.env.TEMP ?? '.', 'key-detect-rows.json'), 'utf8')).filter(
  (r) => r.tag && r.bands,
)
if (rows[0].bands.length !== WEIGHTS.length) throw new Error(`rows have ${rows[0].bands.length} bands, the app has ${WEIGHTS.length} — re-run measure-key-detect.mjs`)
const cam = (t, m) => `${(m ? MINOR_PC : MAJOR_PC)[t]}${m ? 'A' : 'B'}`
const fromCam = (c) => {
  const m = c.endsWith('A')
  return { t: (m ? MINOR_PC : MAJOR_PC).indexOf(Number(c.slice(0, -1))), m }
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
  const acc = WEIGHTS.map(() => new Array(12).fill(0))
  let n = 0
  for (const r of train) {
    const { t, m } = fromCam(r.tag)
    if (!m) continue
    r.bands.forEach((c, k) => {
      for (let i = 0; i < 12; i++) acc[k][i] += c[(i + t) % 12]
    })
    n++
  }
  return { minor: acc.map((a) => a.map((x) => x / n)), n }
}
function detect(bands, minor) {
  const wsum = WEIGHTS.reduce((a, b) => a + b, 0)
  const s = []
  for (let t = 0; t < 12; t++) {
    for (const m of [false, true]) {
      let score = 0
      WEIGHTS.forEach((w, k) => (score += w * pearson(bands[k], m ? minor[k] : KK_MAJOR, t)))
      s.push({ t, m, s: score / wsum })
    }
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
  for (const r of rows.filter((_, i) => i % FOLDS === f)) scored.push({ ...detect(r.bands, p.minor), tag: r.tag })
}
const pct = (a, b) => `${((100 * a) / b).toFixed(1)}%`
console.log(`${rows.length} tagged tracks, ${FOLDS}-fold held out, band weights ${WEIGHTS.join('/')}`)
console.log(`  exact ${pct(scored.filter((s) => s.key === s.tag).length, scored.length)}   exact-or-neighbour ${pct(scored.filter((s) => near(s.key, s.tag)).length, scored.length)}`)
for (const cut of [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.08]) {
  const s = scored.filter((x) => x.margin >= cut)
  const below = scored.filter((x) => x.margin < cut)
  console.log(
    `  margin ≥ ${cut.toFixed(2)}: ${pct(s.length, scored.length)} of tracks, exact ${pct(s.filter((x) => x.key === x.tag).length, s.length)}` +
      (below.length ? `   (below: exact ${pct(below.filter((x) => x.key === x.tag).length, below.length)})` : ''),
  )
}

const final = fit(rows)
const fmt = (a) => `[${a.map((x) => Number(x.toFixed(4))).join(', ')}]`
console.log(`\nFitted on all ${rows.length} (minor n=${final.n}) — paste into BANDS in core/key-detect.ts:`)
final.minor.forEach((m, k) => console.log(`  band ${k}: minor: ${fmt(m)}`))
