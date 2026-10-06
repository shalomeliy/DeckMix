/**
 * The frozen vocal model's per-half-second probabilities for every song in a vocal-marks file, next to the owner's marks for that song.
 *   node --import ./scripts/train/alias-register.mjs scripts/train/dump-strip-probs.mjs <marks.json> <music dir> <out.json> [--rows]
 * Decodes with ffmpeg (44.1 kHz stereo float), finds each marked song in <music dir> by its contentHash (the SHA-256 of the whole file,
 * as the app keys it), else by its name. A song it cannot find or decode is printed by name and counted — never dropped silently.
 * 06/10 (v0.9.37): the name in the export is the song's tag title ("... (Dj Camelion Extended Mix) - 128 BPM"), and 62 of his Mizrahi
 * files are named otherwise on disk, so name-only matching found none of them. A song he has not finished marking is skipped by name. With --rows it also writes the 28 feature numbers and his labels per cell (manualLabels:
 * his marks painted in the order he made them) — the input of fit-genre-marks.py. The probabilities are the FROZEN model's alone, without any
 * genre model on top, so a genre model is always fitted against the same base.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import { cellFeatureRows } from '../../src/core/sound/cell-features.ts'
import { cellProbabilities, parseVocalModel } from '../../src/core/sound/vocal-model.ts'
import { vocalFeatures } from '../../src/core/sound/vocal-presence.ts'
import { manualLabels } from '../../src/core/sound/vocal-manual.ts'

const [marksPath, musicDir, outPath, rowsFlag] = process.argv.slice(2)
const withRows = rowsFlag === '--rows' // the 28 feature numbers per cell too, for fitting on his marks
const marks = JSON.parse(fs.readFileSync(marksPath, 'utf8'))
const model = parseVocalModel(JSON.parse(fs.readFileSync(new URL('../../src/core/sound/vocal-model.json', import.meta.url), 'utf8')))
const files = []
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else files.push(path.join(d, e.name)) } }
walk(musicDir)
const SR = 44100
const out = []
const missing = []
const unfinished = []
let byHash = null // contentHash -> path, built on the first song a name does not find
for (const m of marks.marks) {
  if (m.finished === false) { unfinished.push(m.name); continue }
  let f = null
  if (m.contentHash) {
    byHash ??= new Map(files.map((p) => [crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), p]))
    f = byHash.get(m.contentHash) ?? null
  }
  f ??= files.find((p) => path.parse(p).name === m.name)
  if (!f) { missing.push(m.name); continue }
  let raw
  try {
    raw = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'f32le', '-ac', '2', '-ar', String(SR), '-'], { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    // 05/10: two of his House WAVs carry a tag chunk ffmpeg refuses ("too short LIST tag") and the whole run died on the first one. Named and
    // counted instead; a copy with only its fmt + data chunks decodes (the audio is the same bytes).
    missing.push(`${m.name} (ffmpeg: ${String(err.stderr ?? err).trim().split('\n')[0]})`)
    continue
  }
  const inter = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
  const n = inter.length / 2
  const L = new Float32Array(n), R = new Float32Array(n)
  for (let i = 0; i < n; i++) { L[i] = inter[2 * i]; R[i] = inter[2 * i + 1] }
  const r = vocalFeatures({ channels: [L, R], sampleRate: SR })
  if ('result' in r) { missing.push(`${m.name} (${r.result.state})`); continue }
  const durationSec = n / SR
  const rows = cellFeatureRows(r.features, durationSec)
  const { probs, genreKnown } = cellProbabilities(rows, m.genre ?? "", model)
  out.push({ name: m.name, genre: m.genre ?? '', durationSec, genreKnown, regions: m.regions, probs: Array.from(probs, (p) => +p.toFixed(4)), ...(withRows ? { rows: rows.map((r) => r.map((v) => +v.toFixed(5))), labels: Array.from(manualLabels(m.regions, durationSec)).slice(0, probs.length) } : {}) })
  console.log(`${m.name}: ${durationSec.toFixed(1)} s, ${probs.length} cells`)
}
fs.writeFileSync(outPath, JSON.stringify(out))
console.log(`${out.length} of ${marks.marks.length} songs written${missing.length ? `; not found or not analysed (${missing.length}): ${missing.join(', ')}` : ''}${unfinished.length ? `; not finished marking (${unfinished.length}): ${unfinished.join(', ')}` : ''}`)
