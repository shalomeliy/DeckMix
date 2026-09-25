/**
 * v0.8.37: which energy measure agrees with Shalom's ear? Offline, on the
 * envelopes dump-waveform-bands.mjs wrote (the app's own `analysis.bands`).
 *
 *   node scripts/experiment-energy.mjs <ratings.json>
 *
 * ratings.json: { "<path relative to Tracks>": 1..10, ... } — Shalom's own
 * ratings of 20 tracks (25/09), the only ground truth there is: 5 of 362
 * files carry another app's energy tag.
 *
 * Agreement is Spearman's rank correlation (order, not scale: "is 7 more
 * energetic than 4" is what a rating means). With 20 ratings anything fitted
 * to them would score itself, so every candidate below is written down
 * before seeing the ratings, and the one kept is the best of a handful —
 * reported as in-sample.
 */
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.join(process.env.TEMP ?? '.', 'waveform-bands')
const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8')).filter((x) => !x.error)
const ratings = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))

/** Per-second [low, mid, high] RMS, from ~200 buckets/s. */
function perSecond(x) {
  const buf = fs.readFileSync(path.join(DIR, `${x.i}.bin`))
  const b = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  const n = b.length / 3
  const perSec = n / x.dur
  const secs = Math.floor(x.dur)
  const out = []
  for (let s = 0; s < secs; s++) {
    const a = Math.floor(s * perSec), e = Math.min(n, Math.floor((s + 1) * perSec))
    let l = 0, m = 0, h = 0, rise = 0
    for (let i = a; i < e; i++) {
      l += b[i * 3]; m += b[i * 3 + 1]; h += b[i * 3 + 2]
      if (i > 0) rise += Math.max(0, b[i * 3] - b[(i - 1) * 3])
    }
    const k = Math.max(1, e - a)
    out.push({ l: l / k, m: m / k, h: h / k, rise, t: (l + m + h) / k })
  }
  return out
}
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))]
const db = (v) => 20 * Math.log10(Math.max(v, 1e-6))

function features(x) {
  const s = perSecond(x)
  const peak = pct(s.map((q) => q.t), 0.9)
  const full = s.filter((q) => q.t >= 0.5 * peak) // the "on" part: drops, choruses
  const avg = (f, a = full) => a.reduce((acc, q) => acc + f(q), 0) / Math.max(1, a.length)
  return {
    loud: db(peak),
    fullShare: full.length / s.length,
    punch: avg((q) => q.rise) / Math.max(1e-6, avg((q) => q.l)),
    high: avg((q) => q.h / q.t),
    low: avg((q) => q.l / q.t),
    bpm: x.bpm ?? x.tag ?? 120,
  }
}

function spearman(a, b) {
  const rank = (v) => {
    const o = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0])
    const r = new Array(v.length)
    for (let i = 0; i < o.length; ) {
      let j = i
      while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++
      for (let k = i; k <= j; k++) r[o[k][1]] = (i + j) / 2
      i = j + 1
    }
    return r
  }
  const ra = rank(a), rb = rank(b)
  const n = a.length, ma = ra.reduce((s, x) => s + x, 0) / n, mb = rb.reduce((s, x) => s + x, 0) / n
  let num = 0, da = 0, dbb = 0
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb)
    da += (ra[i] - ma) ** 2
    dbb += (rb[i] - mb) ** 2
  }
  return num / Math.sqrt(da * dbb)
}

// library-wide z-scores, so a combination weighs each feature on the same scale
const all = index.map((x) => ({ x, f: features(x) }))
const keys = Object.keys(all[0].f)
const stats = Object.fromEntries(
  keys.map((k) => {
    const v = all.map((r) => r.f[k])
    const m = v.reduce((s, x) => s + x, 0) / v.length
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length) || 1
    return [k, { m, sd }]
  }),
)
const z = (r, k) => (r.f[k] - stats[k].m) / stats[k].sd

const rated = all.filter((r) => ratings[r.x.rel] != null)
const missing = Object.keys(ratings).filter((k) => !rated.some((r) => r.x.rel === k))
console.log(`${all.length} tracks, ${rated.length} rated${missing.length ? `, NOT FOUND: ${missing.join(' | ')}` : ''}`)
const truth = rated.map((r) => ratings[r.x.rel])

console.log('\nsingle features (Spearman vs rating):')
for (const k of keys) console.log(`  ${k.padEnd(9)} ${spearman(rated.map((r) => r.f[k]), truth).toFixed(2)}`)

const candidates = {
  'loud + fullShare + punch': (r) => z(r, 'loud') + z(r, 'fullShare') + z(r, 'punch'),
  'loud + fullShare + punch + bpm': (r) => z(r, 'loud') + z(r, 'fullShare') + z(r, 'punch') + z(r, 'bpm'),
  'fullShare + punch + high': (r) => z(r, 'fullShare') + z(r, 'punch') + z(r, 'high'),
  'all six, equal': (r) => z(r, 'loud') + z(r, 'fullShare') + z(r, 'punch') + z(r, 'high') + z(r, 'low') + z(r, 'bpm'),
}
console.log('\ncombinations (written before the ratings were seen):')
for (const [name, fn] of Object.entries(candidates)) console.log(`  ${name.padEnd(34)} ${spearman(rated.map(fn), truth).toFixed(2)}`)

console.log('\nper track (rating, then each feature):')
for (const r of rated.sort((a, b) => ratings[a.x.rel] - ratings[b.x.rel]))
  console.log(`  ${String(ratings[r.x.rel]).padStart(2)}  ${keys.map((k) => `${k}=${r.f[k].toFixed(2)}`).join(' ')}  ${r.x.rel.slice(0, 50)}`)
