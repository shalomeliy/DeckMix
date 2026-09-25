/**
 * v0.8.30 research: does splitting the spectrum into bands, each with its own
 * learned minor profile, find keys better than one chroma for everything?
 *
 *   node scripts/dump-key-features.mjs && node scripts/experiment-key-bands.mjs
 *
 * Score for a key = Σ_band weight × Pearson(band chroma, band profile rotated).
 * Band profiles are learned from the owner's minor-tagged tracks; major keeps
 * Krumhansl-Kessler 1982 in every band (14 major tracks are too few to learn).
 *
 * Honesty: the weights are chosen *inside* each outer fold, by an inner 4-fold
 * on the training part only, so the reported number never saw the tracks it
 * scores. A weight picked on the same tracks it is scored on would be a number
 * that measures the search, not the detector.
 */
import fs from 'node:fs'
import path from 'node:path'

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MAJOR_PC = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
const MINOR_PC = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]
const BANDS = ['55–220', '220–500', '500–1k', '1k–2k']
const cam = (t, m) => `${(m ? MINOR_PC : MAJOR_PC)[t]}${m ? 'A' : 'B'}`
const fromCam = (c) => {
  const m = c.endsWith('A')
  return { t: (m ? MINOR_PC : MAJOR_PC).indexOf(Number(c.slice(0, -1))), m }
}
const norm = (a) => {
  const s = a.reduce((x, y) => x + y, 0) || 1
  return a.map((v) => v / s)
}

/** 120-bin → 12, only bins within ±25 cents of a note (the shipped rule). */
function fold12(h) {
  const c = new Array(12).fill(0)
  for (let p = 0; p < 120; p++) {
    const off = p % 10
    if (off > 2 && off < 8) continue
    c[Math.round(p / 10) % 12] += h[p]
  }
  return c
}

const data = JSON.parse(fs.readFileSync(path.join(process.env.TEMP ?? '.', 'key-features-bands.json'), 'utf8'))
  .filter((r) => r.tag && r.segs?.length)
  .map((r) => ({
    tag: r.tag,
    rel: r.rel,
    // per band: segments each normalised, summed, normalised — every stretch of the track one vote
    bands: BANDS.map((_, k) => norm(r.segs.reduce((a, s) => a.map((v, i) => v + norm(fold12(s[k]))[i]), new Array(12).fill(0)))),
  }))

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

function fitProfiles(train) {
  return BANDS.map((_, k) => {
    const acc = new Array(12).fill(0)
    let n = 0
    for (const d of train) {
      const { t, m } = fromCam(d.tag)
      if (!m) continue
      for (let i = 0; i < 12; i++) acc[i] += d.bands[k][(i + t) % 12]
      n++
    }
    return acc.map((v) => v / n)
  })
}

/** Per track, the 24 keys' per-band correlations — computed once per profile set, reused for every weight. */
function bandScores(d, profiles) {
  const out = []
  for (let t = 0; t < 12; t++) {
    for (const m of [false, true]) {
      out.push({ key: cam(t, m), s: BANDS.map((_, k) => pearson(d.bands[k], m ? profiles[k] : KK_MAJOR, t)) })
    }
  }
  return out
}
const decide = (bs, w) => {
  let best = null
  for (const k of bs) {
    const s = k.s.reduce((a, v, i) => a + w[i] * v, 0)
    if (!best || s > best.s) best = { key: k.key, s }
  }
  return best.key
}

const STEPS = [0, 0.25, 0.5, 1]
const GRID = []
for (const a of STEPS) for (const b of STEPS) for (const c of STEPS) for (const d of STEPS) if (a + b + c + d > 0) GRID.push([a, b, c, d])

/** Best weights on `train`, judged by an inner 4-fold. */
function chooseWeights(train) {
  const hits = new Array(GRID.length).fill(0)
  for (let f = 0; f < 4; f++) {
    const fit = fitProfiles(train.filter((_, i) => i % 4 !== f))
    for (let i = f; i < train.length; i += 4) {
      const bs = bandScores(train[i], fit)
      GRID.forEach((w, g) => {
        if (decide(bs, w) === train[i].tag) hits[g]++
      })
    }
  }
  let g = 0
  for (let i = 1; i < GRID.length; i++) if (hits[i] > hits[g]) g = i
  return GRID[g]
}

function outer(pickWeights) {
  let exact = 0
  let near = 0
  const chosen = []
  for (let f = 0; f < 5; f++) {
    const train = data.filter((_, i) => i % 5 !== f)
    const w = pickWeights(train)
    chosen.push(w.join('/'))
    const fit = fitProfiles(train)
    for (let i = f; i < data.length; i += 5) {
      const det = decide(bandScores(data[i], fit), w)
      const tag = data[i].tag
      if (det === tag) exact++
      const [tn, tl] = [Number(tag.slice(0, -1)), tag.slice(-1)]
      const [dn, dl] = [Number(det.slice(0, -1)), det.slice(-1)]
      if (det === tag || tn === dn || (tl === dl && ((tn - dn + 12) % 12 === 1 || (dn - tn + 12) % 12 === 1))) near++
    }
  }
  return { exact: (100 * exact) / data.length, near: (100 * near) / data.length, chosen }
}

console.log(`${data.length} tagged tracks\n`)
const show = (name, r) =>
  console.log(`${r.exact.toFixed(1).padStart(5)}% exact  ${r.near.toFixed(1).padStart(5)}% near   ${name}${r.chosen ? `   weights per fold: ${r.chosen.join('  ')}` : ''}`)
show('each band alone: bass', outer(() => [1, 0, 0, 0]))
show('each band alone: 220–500', outer(() => [0, 1, 0, 0]))
show('each band alone: 500–1k', outer(() => [0, 0, 1, 0]))
show('each band alone: 1k–2k', outer(() => [0, 0, 0, 1]))
show('all bands equal', outer(() => [1, 1, 1, 1]))
show('weights chosen by inner CV (nested — the honest number)', outer(chooseWeights))
