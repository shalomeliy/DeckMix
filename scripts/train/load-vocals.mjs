/**
 * Vocal clips for the training mixes (v0.12.15): read a folder at any depth, vet every file's licence,
 * decode at most `maxClips` (seeded shuffle), and say what was refused. Shared by make-mixes and
 * dump-synth-features so the two can never disagree about what counts as a usable clip.
 *
 * `excerptShare` leans the pick towards files under an `excerpts/` folder. VocalSet is 96% scales and
 * arpeggios and 4% actual songs; picked at random, a classifier would learn "someone drilling a scale".
 */
import fs from 'node:fs'
import path from 'node:path'

export function loadVocals(synth, dir, { maxClips, seed, excerptShare }) {
  const declared = JSON.parse(fs.readFileSync(path.join(dir, 'sources.json'), 'utf8'))
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  const all = walk(dir)
    .map((f) => path.relative(dir, f).split(path.sep).join('/'))
    .filter((f) => f.toLowerCase().endsWith('.wav'))
  const records = all.map((f) => ({ id: f, license: declared[f]?.license ?? declared._default?.license ?? '', origin: declared[f]?.origin ?? declared._default?.origin ?? '' }))
  const vetted = synth.vetSources(records)
  const refused = vetted.refused.map((x) => `${x.source.id}: ${x.reason}`)

  let a = seed >>> 0
  const rnd = () => (a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 4294967296
  const shuffle = (xs) => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[xs[i], xs[j]] = [xs[j], xs[i]]
    }
    return xs
  }
  const songs = shuffle(vetted.ok.filter((s) => s.id.includes('/excerpts/')))
  const drills = shuffle(vetted.ok.filter((s) => !s.id.includes('/excerpts/')))
  const wantSongs = Math.min(songs.length, Math.round(maxClips * excerptShare))
  const picked = [...songs.slice(0, wantSongs), ...drills.slice(0, Math.max(0, maxClips - wantSongs))]
  if (vetted.ok.length > picked.length) console.log(`using ${picked.length} of ${vetted.ok.length} usable clips (${wantSongs} songs, ${picked.length - wantSongs} scales/arpeggios/long tones)`)

  const clips = []
  for (const s of picked) {
    try {
      const w = synth.decodeWav(new Uint8Array(fs.readFileSync(path.join(dir, s.id))))
      const mono = new Float32Array(w.channels[0].length)
      for (const ch of w.channels) for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / w.channels.length
      clips.push({ id: s.id, samples: mono, sampleRate: w.sampleRate, license: s.license, origin: s.origin })
    } catch (e) {
      refused.push(`${s.id}: ${e.message}`)
    }
  }
  console.log(`vocal clips: ${clips.length} used, ${refused.length} refused`)
  for (const r of refused.slice(0, 20)) console.log(`  REFUSED ${r}`)
  if (refused.length > 20) console.log(`  … and ${refused.length - 20} more refused`)
  if (!clips.length) throw new Error('a vocals folder was given but no clip could be used; refusing to make vocal-free data by accident')
  return { clips, refused }
}
