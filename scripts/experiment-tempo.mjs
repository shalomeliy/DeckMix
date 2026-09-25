/**
 * v0.8.34: try blind tempo estimators offline on the envelopes
 * dump-onset-bands.mjs wrote, scored against each track's BPM tag.
 *
 *   node scripts/experiment-tempo.mjs
 *
 * Each estimator is written here from first principles, not from any other
 * product's code — src/core/tempo-estimate.ts is the app's copy of the winner,
 * and this file's copy can drift from it. "exact" = within 1% of the tag;
 * 2x is counted as a miss because the grid would be drawn at that tempo, even
 * though a DJ may call 85 and 170 the same song. The first one reproduces what the app does today so the others
 * are compared against a measured baseline, not a remembered one.
 */
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.join(process.env.TEMP ?? '.', 'onset-bands')
const FPS = 200
const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8')).filter((x) => x.tag)
const tracks = index.map((x) => {
  const buf = fs.readFileSync(path.join(DIR, `${x.i}.bin`))
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  const n = all.length / 4
  const bands = [0, 1, 2, 3].map((b) => {
    const a = new Float32Array(n)
    for (let f = 0; f < n; f++) a[f] = all[f * 4 + b]
    return a
  })
  return { ...x, bands, n }
})
console.log(`${tracks.length} tracks`)

// ── onset functions ──────────────────────────────────────────────────────────
const rise = (env) => {
  const o = new Float32Array(env.length)
  for (let i = 1; i < env.length; i++) o[i] = Math.max(0, env[i] - env[i - 1])
  return o
}
/** Log-compressed rise per band, each band normalised to unit mean, summed. */
function multiBandOnset(bands, weights) {
  const n = bands[0].length
  const out = new Float32Array(n)
  bands.forEach((env, b) => {
    if (!weights[b]) return
    const o = new Float32Array(n)
    let sum = 0
    for (let i = 1; i < n; i++) {
      const d = Math.log1p(1000 * env[i]) - Math.log1p(1000 * env[i - 1])
      o[i] = d > 0 ? d : 0
      sum += o[i]
    }
    const inv = sum > 0 ? n / sum : 0
    for (let i = 0; i < n; i++) out[i] += weights[b] * o[i] * inv
  })
  return out
}
/** Subtract a ~0.5s moving average, keep the positive part — onsets above the local level. */
function localPeaks(o) {
  const w = 50
  const out = new Float32Array(o.length)
  let acc = 0
  for (let i = 0; i < o.length; i++) {
    acc += o[i]
    if (i >= 2 * w) acc -= o[i - 2 * w]
    const c = i - w
    if (c >= 0) out[c] = Math.max(0, o[c] - acc / (2 * w + 1))
  }
  return out
}

// ── scoring ──────────────────────────────────────────────────────────────────
/** Integer-lag autocorrelation up to `maxLag`, once per onset function; fractional lags interpolate it. */
function acfTable(o, maxLag) {
  const t = new Float64Array(maxLag + 2)
  for (let l = 1; l <= maxLag + 1; l++) {
    let s = 0
    for (let i = l; i < o.length; i++) s += o[i] * o[i - l]
    t[l] = s / (o.length - l)
  }
  return t
}
const acfAt = (t, lag) => {
  const l0 = Math.floor(lag), fr = lag - l0
  return t[l0] * (1 - fr) + t[l0 + 1] * fr
}
/** The app today: integer-lag ACF over 80–180 in 0.5 steps, argmax. */
function baseline(o) {
  let best = 0, bpmBest = 0
  for (let bpm = 80; bpm <= 180; bpm += 0.5) {
    const lag = Math.round((60 / bpm) * FPS)
    let s = 0
    for (let i = lag; i < o.length; i++) s += o[i] * o[i - lag]
    s /= o.length - lag
    if (s > best) [best, bpmBest] = [s, bpm]
  }
  return bpmBest
}
/**
 * Best-phase comb: fold the onset function at the candidate period and read
 * how much energy lands on the beat, and on its half-beat (the "and") — a real
 * tempo stacks hits on the beat across the whole track; a 4/3 or 3/2 one
 * drifts through the pattern and smears.
 */
function combScore(o, periodFrames) {
  const nb = Math.max(8, Math.round(periodFrames))
  const bins = new Float64Array(nb)
  for (let i = 0; i < o.length; i++) {
    if (!o[i]) continue
    const ph = (i / periodFrames) % 1
    bins[Math.floor(ph * nb) % nb] += o[i]
  }
  // smooth ±1 bin so a frame of jitter doesn't split a peak
  let best = 0, bestB = 0
  for (let b = 0; b < nb; b++) {
    const v = bins[(b + nb - 1) % nb] + bins[b] + bins[(b + 1) % nb]
    if (v > best) [best, bestB] = [v, b]
  }
  const half = (bestB + Math.round(nb / 2)) % nb
  const vHalf = bins[(half + nb - 1) % nb] + bins[half] + bins[(half + 1) % nb]
  let total = 0
  for (const v of bins) total += v
  return { on: best / total, half: vHalf / total, nb }
}
const logPrior = (bpm, centre, sigmaOct) => Math.exp(-0.5 * (Math.log2(bpm / centre) / sigmaOct) ** 2)

function estimate(o, { prior = null, comb = 0, multiples = [1] } = {}) {
  const table = acfTable(o, Math.ceil((60 / 70) * FPS * Math.max(...multiples)) + 1)
  let best = -Infinity, bpmBest = 0
  for (let bpm = 70; bpm <= 185; bpm += 0.25) {
    const lag = (60 / bpm) * FPS
    let s = 0
    multiples.forEach((k, j) => (s += acfAt(table, lag * k) / (j + 1)))
    if (comb) {
      const c = combScore(o, lag)
      s *= 1 + comb * (c.on + 0.5 * c.half)
    }
    if (prior) s *= logPrior(bpm, prior.centre, prior.sigma)
    if (s > best) [best, bpmBest] = [s, bpm]
  }
  return bpmBest
}

// ── evaluate ─────────────────────────────────────────────────────────────────
function evaluate(name, fn) {
  const t = Date.now()
  let exact = 0
  const ratios = {}
  for (const tr of tracks) {
    const bpm = fn(tr)
    const r = bpm / tr.tag
    if (Math.abs(r - 1) <= 0.01) exact++
    else {
      const key = [[2, '2'], [0.5, '1/2'], [4 / 3, '4/3'], [3 / 4, '3/4'], [1.5, '3/2'], [2 / 3, '2/3']].find(([x]) => Math.abs(r - x) / x < 0.02)?.[1] ?? 'other'
      ratios[key] = (ratios[key] ?? 0) + 1
    }
  }
  console.log(`${name.padEnd(46)} exact ${((100 * exact) / tracks.length).toFixed(1).padStart(5)}%  ${JSON.stringify(ratios)}  ${((Date.now() - t) / 1000).toFixed(0)}s`)
}

const only = process.argv[2]
const runs = {
  'baseline (app today)': (t) => baseline(rise(t.bands[0])),
  'low band, fine ACF': (t) => estimate(rise(t.bands[0])),
  'multiband': (t) => estimate(localPeaks(multiBandOnset(t.bands, [1, 1, 1, 1]))),
  'multiband + prior 120/1oct': (t) => estimate(localPeaks(multiBandOnset(t.bands, [1, 1, 1, 1])), { prior: { centre: 120, sigma: 1 } }),
  'multiband + comb': (t) => estimate(localPeaks(multiBandOnset(t.bands, [1, 1, 1, 1])), { comb: 4 }),
  'multiband + multiples 1,2,4': (t) => estimate(localPeaks(multiBandOnset(t.bands, [1, 1, 1, 1])), { multiples: [1, 2, 4] }),
  'multiband + multiples + comb + prior': (t) =>
    estimate(localPeaks(multiBandOnset(t.bands, [1, 1, 1, 1])), { multiples: [1, 2, 4], comb: 4, prior: { centre: 120, sigma: 1 } }),
}
for (const [name, fn] of Object.entries(runs)) if (!only || name.includes(only)) evaluate(name, fn)
