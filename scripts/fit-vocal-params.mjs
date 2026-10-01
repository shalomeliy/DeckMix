/**
 * v0.9.10 research (01/10): look at, and fit, the vocal score on the owner's TRAINING clips only.
 *   node scripts/fit-vocal-params.mjs            feature separation on the training clips
 *   node scripts/fit-vocal-params.mjs --search   grid search of the weights and thresholds
 *
 * Reads %TEMP%/vocal-features.json (scripts/dump-vocal-features.mjs). Sealed songs (`holdout`) are dropped
 * the moment the labels are read: this script has no flag that opens them, on purpose. The sealed
 * measurement is scripts/measure-vocal-timeline.mjs, run once, after the constants are committed.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tags = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Downloads', 'deckmix-tags-2026-10-01 - vocal.json'), 'utf8'))
const feats = new Map(JSON.parse(fs.readFileSync(path.join(process.env.TEMP, 'vocal-features.json'), 'utf8')).map((x) => [x.s.hash, x.r]))
const DANCE = new Set(['House', 'Techno', 'Trance'])
const CLIP = 5

const clips = tags.vocal
  .filter((v) => !v.holdout) // sealed: never read
  .filter((v) => v.answer === 'yes' || v.answer === 'no')
  .map((v) => ({ ...v, f: feats.get(v.contentHash) }))
  .filter((c) => c.f && c.f.harmonic)

const win = (c) => {
  const f = c.f
  const a = Math.floor(c.atSec / f.frameSec)
  const b = Math.min(f.harmonic.length, Math.ceil((c.atSec + CLIP) / f.frameSec))
  return [a, b]
}
const mean = (x, a, b) => {
  let s = 0
  for (let i = a; i < b; i++) s += x[i]
  return s / Math.max(1, b - a)
}
for (const c of clips) {
  const [a, b] = win(c)
  c.m = { harmonic: mean(c.f.harmonic, a, b), centre: mean(c.f.centre, a, b), bright: mean(c.f.bright, a, b), motion: mean(c.f.motion, a, b), level: mean(c.f.level, a, b) }
}

const yes = clips.filter((c) => c.answer === 'yes')
const no = clips.filter((c) => c.answer === 'no')
console.log(`training clips: ${clips.length} (yes ${yes.length}, no ${no.length}); always-yes baseline ${(yes.length / clips.length * 100).toFixed(0)}%`)
console.log(`dance: ${clips.filter((c) => DANCE.has(c.genre)).length}; mono songs: ${new Set(clips.filter((c) => !c.f.stereo).map((c) => c.contentHash)).size}`)
const q = (x, p) => [...x].sort((a, b) => a - b)[Math.floor(p * (x.length - 1))]
for (const k of ['harmonic', 'centre', 'bright', 'motion']) {
  const y = yes.map((c) => c.m[k])
  const n = no.map((c) => c.m[k])
  console.log(`${k.padEnd(9)} yes p25/50/75 ${[0.25, 0.5, 0.75].map((p) => q(y, p).toFixed(2)).join('/')}   no ${[0.25, 0.5, 0.75].map((p) => q(n, p).toFixed(2)).join('/')}`)
}
if (!process.argv.includes('--search')) process.exit(0)

// the same score + cell rules as src/core/sound/vocal-presence.ts, over just the clip window
function evaluate(p) {
  let right = 0
  let wrong = 0
  let abstain = 0
  for (const c of clips) {
    const f = c.f
    const [a, b] = win(c)
    const wSum = p.wH + p.wB + p.wM + (f.stereo ? p.wC : 0)
    let vocal = 0
    let none = 0
    const nCells = Math.round(CLIP / 0.5)
    const per = (b - a) / nCells
    const cellScore = []
    for (let k = 0; k < nCells; k++) {
      let s = 0
      let n = 0
      for (let t = Math.floor(a + k * per); t < Math.max(Math.floor(a + k * per) + 1, Math.floor(a + (k + 1) * per)); t++) {
        const m = Math.min(1, f.motion[t] / p.motionScale)
        s += (p.wH * f.harmonic[t] + p.wB * f.bright[t] + p.wM * m + (f.stereo ? p.wC * f.centre[t] : 0)) / wSum
        n++
      }
      cellScore.push(s / n)
    }
    for (let k = 0; k < nCells; k++) {
      let s = [cellScore[Math.max(0, k - 1)], cellScore[k], cellScore[Math.min(nCells - 1, k + 1)]].sort((x, y) => x - y)[1]
      if (!f.stereo) s = Math.min(Math.max(s, 0.5 - p.monoCap), 0.5 + p.monoCap)
      if (s >= p.hi) vocal++
      else if (s <= p.lo) none++
    }
    if (vocal === none) {
      abstain++
      continue
    }
    const pred = vocal > none ? 'yes' : 'no'
    if (pred === c.answer) right++
    else wrong++
  }
  return { right, wrong, abstain, acc: right / Math.max(1, right + wrong) }
}

let best = null
const grid = [0, 0.5, 1, 2]
for (const wH of grid) for (const wB of grid) for (const wM of grid) for (const wC of grid) {
  if (wH + wB + wM + wC === 0) continue
  for (const motionScale of [0.25, 0.5, 1]) for (const lo of [0.3, 0.4, 0.45, 0.5]) for (const hi of [0.5, 0.55, 0.6, 0.7]) {
    if (hi <= lo) continue
    const p = { wH, wB, wM, wC, motionScale, lo, hi, monoCap: 0.1 }
    const r = evaluate(p)
    // prefer accuracy, then fewer abstentions
    const score = r.acc - 0.15 * (r.abstain / clips.length)
    if (!best || score > best.score) best = { score, p, r }
  }
}
console.log('best on training clips:', JSON.stringify(best, null, 1))
console.log('default weights:', JSON.stringify(evaluate({ wH: 1, wB: 1, wM: 1, wC: 1, motionScale: 0.5, lo: 0.4, hi: 0.6, monoCap: 0.1 })))
