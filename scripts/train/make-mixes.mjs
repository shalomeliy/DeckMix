/**
 * v0.12.15: build training mixes from our own synthesised instrumentals (src/core/sound/synth), with
 * optional vocal clips laid over them and the vocal label read off the vocal stem.
 *
 *   node scripts/train/make-mixes.mjs --count 20 [--seed 1] [--bars 48] [--sr 44100] [--stems]
 *        [--out %TEMP%/deckmix-mixes] [--vocals <dir>] [--max-clips 200] [--excerpt-share 0.5]
 *
 * <dir> holds .wav vocal clips (any depth) plus `sources.json`:
 *   { "_default": { "license": "CC-BY-4.0", "origin": "<url>" }, "<relative/file.wav>": { ...overrides } }.
 * `_default` is for a whole dataset that carries one license (VocalSet); a per-file entry wins over it.
 * A clip with no license at all, or one that is not CC0 / CC BY, is REFUSED and listed — never used quietly.
 * At most --max-clips clips are decoded (chosen by a seeded shuffle): all 3,500 VocalSet files would be ~6 GB of RAM.
 * Output stays outside the repo (the data and its credits are not source code). `manifest.json` records,
 * per mix: seed, tempo, key, the vocal clips used, and the label cells (0 none, 1 voice, 2 ignore).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { loadVocals } from './load-vocals.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const count = Number(arg('count', 10))
const seed0 = Number(arg('seed', 1))
const bars = Number(arg('bars', 48))
const sampleRate = Number(arg('sr', 44100))
const withStems = process.argv.includes('--stems')
const out = path.resolve(arg('out', path.join(os.tmpdir(), 'deckmix-mixes')))
const vocalsDir = arg('vocals', null)

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
try {
  const synth = await server.ssrLoadModule('/src/core/sound/synth/index.ts')
  const clips = []
  const refused = []
  if (vocalsDir) {
    const loaded = loadVocals(synth, vocalsDir, { maxClips: Number(arg('max-clips', 200)), seed: seed0, excerptShare: Number(arg('excerpt-share', 0.5)) })
    clips.push(...loaded.clips)
    refused.push(...loaded.refused)
  }

  fs.mkdirSync(out, { recursive: true })
  const manifest = { made: new Date().toISOString(), sampleRate, bars, refused, mixes: [] }
  const write = (name, chans) => fs.writeFileSync(path.join(out, name), synth.encodeWav16(chans, sampleRate))
  for (let k = 0; k < count; k++) {
    const seed = seed0 + k
    const t0 = performance.now()
    const m = synth.makeMix(seed, clips, { sampleRate, bars })
    const base = `mix-${String(seed).padStart(5, '0')}`
    write(`${base}.wav`, m.mixture)
    if (withStems) for (const [name, s] of Object.entries(m.stems)) write(`${base}.${name}.wav`, s)
    manifest.mixes.push({
      file: `${base}.wav`,
      seed,
      bpm: m.bpm,
      key: m.key,
      seconds: +(m.mixture[0].length / sampleRate).toFixed(1),
      vocalClips: m.vocalIds.map((id) => ({ id, ...(clips.find((c) => c.id === id) && { license: clips.find((c) => c.id === id).license, origin: clips.find((c) => c.id === id).origin }) })),
      labels: Array.from(m.labels).join(''),
    })
    console.log(`${base}  ${m.bpm} BPM  ${m.key}  vocal ${[...m.labels].filter((l) => l === 1).length}/${m.labels.length} cells  ${((performance.now() - t0) / 1000).toFixed(1)}s`)
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1))
  console.log(`wrote ${count} mixes + manifest.json to ${out}`)
} finally {
  await server.close()
}
