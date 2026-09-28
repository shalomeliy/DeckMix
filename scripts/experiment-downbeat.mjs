/**
 * v0.9.5 research harness, step 2: which beat of the detector's bar is the
 * real "1"? Scored against Shalom's final answers (28/09): the waveform round
 * (`mark`) where both rounds agreed, the blind tie-break (`decide`) where they
 * did not — 105 songs, see docs/handoff/v0.12.8.md.
 *
 *   node scripts/experiment-downbeat.mjs            train songs only (75)
 *   node scripts/experiment-downbeat.mjs --holdout  the sealed 30 — once, at the end
 *
 * Reads the features `dump-downbeat-features.mjs` wrote. Every method returns
 * four scores, one per candidate phase p (bar lines on beats ≡ p mod 4);
 * the highest wins. Baseline: "the first beat of the grid" — what the app does today.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOLDOUT = process.argv.includes('--holdout')
const TAGS = path.join(os.homedir(), 'Downloads', 'deckmix-tags-2026-09-28 - 26 songs.json')
const tags = JSON.parse(fs.readFileSync(TAGS, 'utf8'))
const decide = new Map(tags.decide.filter((d) => d.answer === 'marked').map((d) => [d.contentHash, d.markSec]))
const feats = JSON.parse(fs.readFileSync(path.join(process.env.TEMP ?? '.', 'downbeat-features.json'), 'utf8'))

const beatOf = (sec, g) => {
  const n = Math.round((sec - g.offsetSec) / (60 / g.bpm))
  return ((n % 4) + 4) % 4
}
const markBy = new Map(tags.mark.map((m) => [m.contentHash, m.markSec]))
for (const f of feats) f.truth = beatOf(decide.get(f.contentHash) ?? markBy.get(f.contentHash), f.grid)
// The listening round (28/09, listen-downbeat.mjs): where he picked the other
// click over his earlier answer, the ears-only answer wins. Controls came back
// 10/10, so the round itself is trusted. Only disagreements were re-asked, so
// this can only move the truth toward the detector — say so when reporting.
const LISTEN = path.join(os.homedir(), 'Downloads', 'deckmix-listen-2026-09-28.json')
let relistened = 0
if (fs.existsSync(LISTEN)) {
  for (const it of JSON.parse(fs.readFileSync(LISTEN, 'utf8')).items) {
    const v = it.answer?.value
    if (v !== 'a' && v !== 'b' || (v === 'a') === it.mineIsA) continue
    const f = feats.find((x) => x.contentHash === it.contentHash)
    f.truth = beatOf(v === 'a' ? it.a : it.b, f.grid)
    relistened++
  }
}
const songs = feats.filter((f) => f.holdout === HOLDOUT)

// ---- helpers
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length)
const norm = (v) => {
  const s = Math.hypot(...v)
  return s ? v.map((x) => x / s) : v
}
const cosDist = (a, b) => {
  let d = 0
  for (let i = 0; i < 12; i++) d += a[i] * b[i]
  return 1 - d
}
const zscore = (s) => {
  const m = mean(s)
  const sd = Math.sqrt(mean(s.map((v) => (v - m) ** 2))) || 1
  return s.map((v) => (v - m) / sd)
}
/** total energy per beat, all four bands */
const energy = (f) => f.e[0].map((_, k) => f.e[0][k] + f.e[1][k] + f.e[2][k] + f.e[3][k])
/** sum over beats k ≡ p (mod 4) of x[k], p = 0..3, averaged */
const byPhase = (x, from = 0) => [0, 1, 2, 3].map((p) => mean(x.filter((_, k) => k >= from && k % 4 === p)))

// ---- methods
const M = {}
M.baseline = () => [1, 0, 0, 0]

/** harmonic change: the chord changes on the 1 */
M.chord = (f) => {
  const c = f.chroma.map(norm)
  const d = c.map((v, k) => (k ? cosDist(v, c[k - 1]) : 0))
  return byPhase(d, 1)
}
/** bar-sized chroma change: chroma of the bar starting at k vs the bar before */
M.chordBar = (f) => {
  const c = f.chroma
  const n = c.length
  const d = new Array(n).fill(0)
  for (let k = 4; k + 4 <= n; k++) {
    const a = new Array(12).fill(0)
    const b = new Array(12).fill(0)
    for (let j = 0; j < 4; j++) for (let i = 0; i < 12; i++) {
      a[i] += c[k - 4 + j][i]
      b[i] += c[k + j][i]
    }
    d[k] = cosDist(norm(a), norm(b))
  }
  return byPhase(d, 4)
}
/** spectral flux on the beat */
M.flux = (f) => byPhase(f.flux, 1)
/** energy novelty: next W beats vs previous W beats, taken as |jump| — structure changes land on bar lines */
const novelty = (x, W) => {
  const n = x.length
  const out = new Array(n).fill(0)
  for (let k = W; k + W <= n; k++) {
    let a = 0
    let b = 0
    for (let j = 0; j < W; j++) {
      a += x[k - W + j]
      b += x[k + j]
    }
    out[k] = Math.abs(b - a) / W
  }
  return out
}
/** novelty peaks: top-N energy jumps vote for their phase, weighted by size */
const peakVote = (nov, topN) => {
  const idx = nov.map((v, k) => [v, k]).sort((a, b) => b[0] - a[0])
  const votes = [0, 0, 0, 0]
  const taken = []
  for (const [v, k] of idx) {
    if (taken.length >= topN) break
    if (taken.some((t) => Math.abs(t - k) < 8)) continue
    taken.push(k)
    votes[k % 4] += v
  }
  return votes
}
for (const W of [4, 8, 16])
  for (const band of ['all', 0, 1, 2, 3]) {
    const x = (f) => (band === 'all' ? energy(f) : f.e[band])
    M[`novMean_${band}_${W}`] = (f) => byPhase(novelty(x(f), W))
    for (const top of [4, 8])
      M[`novPeak_${band}_${W}_${top}`] = (f) => peakVote(novelty(x(f), W), top)
  }
/** crash/cymbal: high-band rise on the beat, relative to the other three beats */
M.hiOn = (f) => byPhase(f.on[3], 0)
M.kickOn = (f) => byPhase(f.on[0], 0)
M.bassOn = (f) => byPhase(f.on[1], 0)
/** kick returns after a gap: low-band beat energy vs the previous 4 beats' mean */
M.kickReturn = (f) => {
  const x = f.e[0]
  const d = x.map((v, k) => (k >= 4 ? Math.max(0, v - mean(x.slice(k - 4, k))) : 0))
  return byPhase(d)
}

/**
 * Kick entry (the best so far, 28/09): the beat where the kick band's rise
 * comes back after a stretch without it — mean of the next 8 beats minus the
 * previous 8, times the one-beat jump — top 8 entries ≥16 beats apart vote for
 * their phase, share-normalised, plus a prior of 0.3 on "the first beat".
 */
const pctOf = (a, q) => [...a].sort((x, y) => x - y)[Math.floor(q * (a.length - 1))] || 1
export function kickEntryVotes(f, W = 8, top = 8) {
  const pk = pctOf(f.on[0], 0.9)
  const K = f.on[0].map((v) => v / pk)
  const sc = K.map((_, k) => {
    if (k < W || k + W > K.length) return 0
    const r = mean(K.slice(k, k + W)) - mean(K.slice(k - W, k))
    return Math.max(0, r) * Math.max(0, K[k] - K[k - 1])
  })
  const idx = sc.map((v, k) => [v, k]).sort((a, b) => b[0] - a[0])
  const v = [0, 0, 0, 0]
  const taken = []
  for (const [s, k] of idx) {
    if (taken.length >= top || s <= 0) break
    if (taken.some((j) => Math.abs(j - k) < 16)) continue
    taken.push(k)
    v[k % 4] += s
  }
  return v
}
/**
 * The same, at half-beat resolution: the kick rise on the beat (`on`) and at
 * the half-beat (`oh`) interleaved. Shalom (28/09): when the kick sits half-way
 * between two lines he marks the beat *before* it — PINKED PANTHER's drop
 * kick lands on 239.5 and his "1" is 239. So an entry at k+½ votes for k.
 */
export function kickEntryVotesHalf(f, W = 16, top = 8, sharp = 1) {
  const n = f.on[0].length
  const x = new Array(2 * n)
  for (let k = 0; k < n; k++) {
    x[2 * k] = f.on[0][k]
    x[2 * k + 1] = f.oh[0][k]
  }
  const pk = pctOf(x, 0.9)
  const K = x.map((v) => v / pk)
  const sc = K.map((_, k) => {
    if (k < W || k + W > K.length) return 0
    const r = mean(K.slice(k, k + W)) - mean(K.slice(k - W, k))
    return Math.max(0, r) * (sharp ? Math.max(0, K[k] - Math.max(K[k - 1], K[k - 2])) : 1)
  })
  const idx = sc.map((v, k) => [v, k]).sort((a, b) => b[0] - a[0])
  const v = [0, 0, 0, 0]
  const taken = []
  for (const [s, k] of idx) {
    if (taken.length >= top || s <= 0) break
    if (taken.some((j) => Math.abs(j - k) < 32)) continue
    taken.push(k)
    v[Math.floor(k / 2) % 4] += s
  }
  return v
}
const withPrior = (v, lam = 0.3) => {
  const tot = v.reduce((a, b) => a + b, 0) || 1
  return v.map((x, p) => x / tot + (p === 0 ? lam : 0))
}
for (const W of [8, 16]) for (const sharp of [0, 1]) for (const lam of [0.2, 0.3, 0.4])
  M[`kickHalf_W${W}_s${sharp}_l${lam}`] = (f) => withPrior(kickEntryVotesHalf(f, W, 8, sharp), lam)
M.kickPrior = (f) => {
  const v = kickEntryVotes(f)
  const tot = v.reduce((a, b) => a + b, 0) || 1
  return v.map((x, p) => x / tot + (p === 0 ? 0.3 : 0))
}

// ---- scoring
const genres = ['House', 'Techno', 'Trance', 'Hip Hop', 'Mizrahi']
const DANCE = new Set(['House', 'Techno', 'Trance'])
function evaluate(fn) {
  const r = { all: [0, 0], dance: [0, 0], g: Object.fromEntries(genres.map((g) => [g, [0, 0]])) }
  const out = []
  for (const f of songs) {
    const s = fn(f)
    const best = s.indexOf(Math.max(...s))
    const ok = best === f.truth
    r.all[0] += ok
    r.all[1]++
    r.g[f.genre][0] += ok
    r.g[f.genre][1]++
    if (DANCE.has(f.genre)) {
      r.dance[0] += ok
      r.dance[1]++
    }
    const sorted = [...s].sort((a, b) => b - a)
    out.push({ f, best, ok, margin: sorted[0] - sorted[1], scores: s })
  }
  return { r, out }
}
const isMain = process.argv[1] != null && import.meta.url.endsWith(path.basename(process.argv[1]))
const fmt = ([a, b]) => `${a}/${b}`.padStart(6)
if (isMain) console.log(`${relistened} answers changed by the listening round
`)
if (isMain) console.log(`${songs.length} songs (${HOLDOUT ? 'SEALED HOLDOUT' : 'train'}); truth beat distribution: ${[0, 1, 2, 3].map((p) => songs.filter((s) => s.truth === p).length).join(' ')}\n`)
if (isMain) console.log(`${'method'.padEnd(26)}   all  dance   ${genres.map((g) => g.slice(0, 6).padStart(6)).join(' ')}`)
const results = isMain ? Object.entries(M).map(([name, fn]) => [name, evaluate(fn)]) : []
results.sort((a, b) => b[1].r.dance[0] - a[1].r.dance[0] || b[1].r.all[0] - a[1].r.all[0])
for (const [name, { r }] of results)
  console.log(`${name.padEnd(26)} ${fmt(r.all)} ${fmt(r.dance)}   ${genres.map((g) => fmt(r.g[g])).join(' ')}`)

export { M, songs, evaluate, energy, novelty, peakVote, byPhase, zscore }
