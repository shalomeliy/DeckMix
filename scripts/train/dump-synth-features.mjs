/**
 * v0.12.15: synthetic mixes -> per-cell feature rows + labels, for training the vocal classifier offline.
 *   node scripts/train/dump-synth-features.mjs --count 600 [--seed 1000] [--bars 32] --vocals <dir> [--max-clips 400]
 *   -> %TEMP%/synth-cells.json   { names, mixes: [ { seed, bpm, rows: [[...16]], labels: "0101..." } ] }
 * Runs the app's own `vocalFeatures` (pure TS) through Vite, so no browser is needed. Label 2 (the
 * in-between cells) is kept in the file and dropped by the trainer, where the rule is visible.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { loadVocals } from './load-vocals.mjs'
import { cellFeatureRows, FEATURE_NAMES } from './cell-features.mjs'

const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d)
const count = Number(arg('count', 100))
const seed0 = Number(arg('seed', 1000))
const bars = Number(arg('bars', 32))
const vocals = arg('vocals', null)
if (!vocals) throw new Error('--vocals <dir> is required (a vocal-free set would teach nothing)')
const SR = 22050

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
try {
  const synth = await server.ssrLoadModule('/src/core/sound/synth/index.ts')
  const presence = await server.ssrLoadModule('/src/core/sound/vocal-presence.ts')
  const { clips } = loadVocals(synth, vocals, { maxClips: Number(arg('max-clips', 400)), seed: seed0, excerptShare: Number(arg('excerpt-share', 0.5)) })
  const mixes = []
  const t0 = performance.now()
  for (let k = 0; k < count; k++) {
    const m = synth.makeMix(seed0 + k, clips, { sampleRate: SR, bars })
    const r = presence.vocalFeatures({ channels: m.mixture, sampleRate: SR })
    if (!('features' in r)) {
      console.log(`mix ${seed0 + k}: ${r.result.state} — skipped`)
      continue
    }
    const dur = m.mixture[0].length / SR
    const rows = cellFeatureRows(r.features, dur)
    const n = Math.min(rows.length, m.labels.length)
    mixes.push({ seed: m.seed, bpm: m.bpm, rows: rows.slice(0, n), labels: Array.from(m.labels.slice(0, n)).join('') })
    if ((k + 1) % 25 === 0) console.log(`${k + 1}/${count}  ${((performance.now() - t0) / 1000).toFixed(0)}s`)
  }
  const out = path.join(process.env.TEMP, 'synth-cells.json')
  fs.writeFileSync(out, JSON.stringify({ names: FEATURE_NAMES, sampleRate: SR, mixes }))
  const cells = mixes.reduce((s, m) => s + m.labels.length, 0)
  const yes = mixes.reduce((s, m) => s + [...m.labels].filter((l) => l === '1').length, 0)
  console.log(`wrote ${mixes.length} mixes, ${cells} cells (${yes} vocal) to ${out}`)
} finally {
  await server.close()
}
