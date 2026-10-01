/**
 * v0.12.15: build training mixes from our own synthesised instrumentals (src/core/sound/synth), with
 * optional vocal clips laid over them and the vocal label read off the vocal stem.
 *
 *   node scripts/train/make-mixes.mjs --count 20 [--seed 1] [--bars 48] [--sr 44100] [--stems]
 *        [--out %TEMP%/deckmix-mixes] [--vocals <dir>]
 *
 * <dir> holds .wav vocal clips plus `sources.json`: { "<file.wav>": { "license": "CC-BY-4.0", "origin": "<url>" } }.
 * A clip with no entry, or a license that is not CC0 / CC BY, is REFUSED and listed — never used quietly.
 * Output stays outside the repo (the data and its credits are not source code). `manifest.json` records,
 * per mix: seed, tempo, key, the vocal clips used, and the label cells (0 none, 1 voice, 2 ignore).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'

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
    const declared = JSON.parse(fs.readFileSync(path.join(vocalsDir, 'sources.json'), 'utf8'))
    const files = fs.readdirSync(vocalsDir).filter((f) => f.toLowerCase().endsWith('.wav'))
    const records = files.map((f) => ({ id: f, license: declared[f]?.license ?? '', origin: declared[f]?.origin ?? '' }))
    const vetted = synth.vetSources(records)
    refused.push(...vetted.refused.map((x) => `${x.source.id}: ${x.reason}`))
    for (const s of vetted.ok) {
      try {
        const w = synth.decodeWav(new Uint8Array(fs.readFileSync(path.join(vocalsDir, s.id))))
        const mono = new Float32Array(w.channels[0].length)
        for (const ch of w.channels) for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / w.channels.length
        clips.push({ id: s.id, samples: mono, sampleRate: w.sampleRate, license: s.license, origin: s.origin })
      } catch (e) {
        refused.push(`${s.id}: ${e.message}`)
      }
    }
    console.log(`vocal clips: ${clips.length} used, ${refused.length} refused`)
    for (const r of refused) console.log(`  REFUSED ${r}`)
    if (!clips.length) throw new Error('--vocals was given but no clip could be used; refusing to make vocal-free data by accident')
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
