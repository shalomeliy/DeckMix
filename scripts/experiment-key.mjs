/**
 * v0.8.30 research: try key-detection variants offline on the features
 * `dump-key-features.mjs` wrote, scored against the owner's tags, 5-fold held
 * out (every track scored by a minor profile fitted on the other four fifths).
 *
 *   node scripts/experiment-key.mjs
 *
 * Nothing here ships. It exists so a change to `core/key-detect.ts` is chosen by
 * a number, and so the number can be reproduced.
 */
import fs from 'node:fs'
import path from 'node:path'

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MAJOR_PC = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
const MINOR_PC = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]
const cam = (t, m) => `${(m ? MINOR_PC : MAJOR_PC)[t]}${m ? 'A' : 'B'}`
const fromCam = (c) => {
  const m = c.endsWith('A')
  return { t: (m ? MINOR_PC : MAJOR_PC).indexOf(Number(c.slice(0, -1))), m }
}

const rows = JSON.parse(fs.readFileSync(path.join(process.env.TEMP ?? '.', 'key-features.json'), 'utf8')).filter(
  (r) => r.tag && r.segs?.length,
)

/** 120-bin histogram → 12 pitch classes. Bin p is (p/10) semitones above C; `shift` in bins (10 cents). */
function fold(h, shift, width) {
  const c = new Float64Array(12)
  for (let p = 0; p < 120; p++) {
    const semis = (p - shift) / 10
    const near = Math.round(semis)
    if (Math.abs(semis - near) * 100 > width) continue
    c[((near % 12) + 12) % 12] += h[p]
  }
  return c
}
/** Tuning = which of the 10 sub-semitone offsets holds the most energy, as a signed shift in bins. */
function tuning(h) {
  const byOff = new Float64Array(10)
  for (let p = 0; p < 120; p++) byOff[p % 10] += h[p]
  let best = 0
  for (let o = 1; o < 10; o++) if (byOff[o] > byOff[best]) best = o
  return best > 5 ? best - 10 : best
}
const add = (a, b, w = 1) => a.map((v, i) => v + w * b[i])
const norm = (a) => {
  const s = a.reduce((x, y) => x + y, 0) || 1
  return a.map((v) => v / s)
}

function pearson(a, b, rot) {
  let ma = 0
  let mb = 0
  for (let i = 0; i < 12; i++) {
    ma += a[(i + rot) % 12]
    mb += b[i]
  }
  ma /= 12
  mb /= 12
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < 12; i++) {
    const x = a[(i + rot) % 12] - ma
    const y = b[i] - mb
    num += x * y
    da += x * x
    db += y * y
  }
  return da < 1e-12 ? 0 : num / Math.sqrt(da * db)
}
function scores(c, minor, major) {
  const s = []
  for (let t = 0; t < 12; t++) {
    s.push({ t, m: false, s: pearson(c, major, t) })
    s.push({ t, m: true, s: pearson(c, minor, t) })
  }
  return s
}

/**
 * One variant = how a track's segments become the thing that is matched.
 * Returns per track either one 12-chroma (`mode: 'sum'`) or the list of
 * per-segment chromas (`mode: 'vote'`).
 */
function features(r, v) {
  const allFull = r.segs.reduce((a, s) => add(a, s[0]), new Array(120).fill(0))
  const shift = v.tune ? tuning(allFull) : 0
  const seg = (s) => {
    let c = norm(fold(s[0], shift, v.width))
    if (v.bass) c = add(c, norm(fold(s[1], shift, v.width)), v.bass)
    return norm(c)
  }
  const segs = r.segs.map(seg)
  const sumOf = (k) => norm(r.segs.reduce((a, s) => add(a, norm(fold(s[k], shift, v.width))), new Array(12).fill(0)))
  return { sum: norm(segs.reduce((a, c) => add(a, c), new Array(12).fill(0))), segs, full: sumOf(0), bassOnly: sumOf(1) }
}

function fitMinor(train, field = 'sum') {
  const acc = new Array(12).fill(0)
  let n = 0
  for (const { f, tag } of train) {
    const { t, m } = fromCam(tag)
    if (!m) continue
    const c = f[field]
    for (let i = 0; i < 12; i++) acc[i] += c[(i + t) % 12]
    n++
  }
  return acc.map((v) => v / n)
}

function decide(f, minor, v, dual) {
  if (v.mode === 'dual') {
    // no learned bass major (14 tracks): KK major for both bands
    const a = scores(f.full, dual.full, KK_MAJOR)
    const b = scores(f.bassOnly, dual.bass, KK_MAJOR)
    const s = a.map((k, i) => ({ ...k, s: k.s + v.w * b[i].s })).sort((p, q) => q.s - p.s)
    return cam(s[0].t, s[0].m)
  }
  if (v.mode === 'vote') {
    const tot = new Map()
    for (const c of f.segs) {
      for (const k of scores(c, minor, KK_MAJOR)) {
        const key = cam(k.t, k.m)
        tot.set(key, (tot.get(key) ?? 0) + k.s)
      }
    }
    return [...tot.entries()].sort((a, b) => b[1] - a[1])[0][0]
  }
  const s = scores(f.sum, minor, KK_MAJOR).sort((a, b) => b.s - a.s)
  return cam(s[0].t, s[0].m)
}

function evaluate(v) {
  const data = rows.map((r) => ({ tag: r.tag, f: features(r, v) }))
  let exact = 0
  let near = 0
  for (let fold_ = 0; fold_ < 5; fold_++) {
    const train = data.filter((_, i) => i % 5 !== fold_)
    const minor = fitMinor(train)
    const dual = { full: fitMinor(train, 'full'), bass: fitMinor(train, 'bassOnly') }
    for (let i = fold_; i < data.length; i += 5) {
      const det = decide(data[i].f, minor, v, dual)
      const tag = data[i].tag
      if (det === tag) exact++
      const [tn, tl] = [Number(tag.slice(0, -1)), tag.slice(-1)]
      const [dn, dl] = [Number(det.slice(0, -1)), det.slice(-1)]
      if (det === tag || tn === dn || (tl === dl && ((tn - dn + 12) % 12 === 1 || (dn - tn + 12) % 12 === 1))) near++
    }
  }
  return { exact: (100 * exact) / data.length, near: (100 * near) / data.length }
}

console.log(`${rows.length} tagged tracks with features\n`)
const variants = [
  { name: 'baseline (≈ shipped: centre ±25c, no tuning, sum)', width: 25 },
  { name: 'centre ±15c', width: 15 },
  { name: 'centre ±35c', width: 35 },
  { name: 'segment vote', width: 25, mode: 'vote' },
  { name: 'bass 0.25', width: 25, bass: 0.25 },
  { name: 'bass 0.5', width: 25, bass: 0.5 },
  { name: 'bass 0.5 + vote', width: 25, bass: 0.5, mode: 'vote' },
  { name: 'bass 0.75', width: 25, bass: 0.75 },
  { name: 'dual profiles, bass w 0.3', width: 25, mode: 'dual', w: 0.3 },
  { name: 'dual profiles, bass w 0.5', width: 25, mode: 'dual', w: 0.5 },
  { name: 'dual profiles, bass w 1', width: 25, mode: 'dual', w: 1 },
  { name: 'tuning estimate (peaks too coarse below ~200 Hz — measured worse)', width: 25, tune: true },
]
for (const v of variants) {
  const r = evaluate(v)
  console.log(`${r.exact.toFixed(1).padStart(5)}% exact  ${r.near.toFixed(1).padStart(5)}% near   ${v.name}`)
}
