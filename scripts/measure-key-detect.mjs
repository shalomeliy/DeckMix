/**
 * v0.8.27: how often does the from-scratch key detector agree with the keys
 * already written in the owner's tags? Read-only — files are read, never written.
 *
 *   node scripts/measure-key-detect.mjs [limit] [path-substring]   (against npm run dev on :5173)
 *
 * Runs in real Chrome (`channel: 'chrome'`): Playwright's own Chromium has no
 * AAC decoder, and the m4a/mp4 files are exactly the ones this version is for.
 * Decoding and tag reading use the app's own paths (`decodeAudioData`,
 * `readTags`), so the numbers describe what the app would do, not a copy of it.
 *
 * Buckets, per track with a tag key:
 *   exact     — same Camelot code
 *   relative  — same number, other letter (Am vs C: same notes, different centre)
 *   fifth     — same letter, ±1 on the wheel (a neighbour that still mixes)
 *   other     — wrong
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright'

const ROOT = String.raw`C:\Users\Shalom\Music\Tracks`
const EXT = new Set(['mp3', 'wav', 'flac', 'm4a', 'm4b', 'mp4', 'aac', 'ogg', 'opus', 'aif', 'aiff'])
const limit = Number(process.argv[2]) || Infinity

const files = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full)
    else if (EXT.has(path.extname(e.name).slice(1).toLowerCase())) files.push(full)
  }
})(ROOT)
const only = process.argv[3] // optional substring filter, e.g. "Trance"
if (only) files.splice(0, files.length, ...files.filter((f) => f.includes(only)))
files.splice(limit)
console.log(`${files.length} audio files under ${ROOT}`)

// Files come from a tiny local server, not `page.route`: run 3 showed every WAV
// over 100MB (the Trance originals, up to 164MB) killing the tab, because a
// routed body crosses the DevTools protocol in one piece. A plain HTTP stream
// has no such ceiling.
const server = http.createServer((req, res) => {
  if (req.url === '/__blank') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<!doctype html><title>measure</title>')
    return
  }
  const i = Number(req.url.split('/').pop())
  if (!files[i]) {
    res.writeHead(404) // favicon.ico and anything else that isn't a track index
    res.end()
    return
  }
  res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/octet-stream' })
  fs.createReadStream(files[i]).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const FILE_BASE = `http://127.0.0.1:${server.address().port}`

let browser = await chromium.launch({ channel: 'chrome' })
// A blank page on the dev server's origin, not the app: the modules are
// imported straight from Vite, and the app's own boot (storage migration,
// reloads) has no business running under a measurement. The first full run
// died on track 1 with "Target page … has been closed" while the app was loaded.
async function openPage() {
  const p = await browser.newPage()
  // The page lives on the file server's origin (same-origin fetch of the audio;
  // a cross-origin fetch from :5173 failed outright), and imports the app's
  // modules from Vite, which serves them with CORS open.
  await p.goto(`${FILE_BASE}/__blank`)
  return p
}
let page = await openPage()

const rows = []
const t0 = Date.now()
for (let i = 0; i < files.length; i++) {
  const rel = path.relative(ROOT, files[i])
  let r
  try {
  r = await page.evaluate(async ({ i, name, base }) => {
    const { detectKey, camelotOf } = await import('http://localhost:5173/src/core/key-detect.ts')
    const { readTags } = await import('http://localhost:5173/src/platform/source-fsaccess/tags.ts')
    const bytes = await (await fetch(`${base}/${i}`)).arrayBuffer()
    const tags = await readTags(new File([bytes], name))
    let audio
    try {
      const ctx = new OfflineAudioContext(1, 1, 44100)
      audio = await ctx.decodeAudioData(bytes.slice(0))
    } catch (e) {
      return { tag: tags.camelot ?? null, error: String(e?.message ?? e) }
    }
    const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c))
    const t = performance.now()
    const k = detectKey(channels, audio.sampleRate)
    const ms = performance.now() - t
    // The per-band chroma, from the very code the app runs, so key profiles
    // can be fitted and cross-checked offline (scripts/fit-key-profiles.mjs)
    // without decoding the library again.
    const { bandChroma } = await import('http://localhost:5173/src/core/key-detect.ts')
    const bands = bandChroma(channels, audio.sampleRate).map((b) => Array.from(b))
    return {
      bands,
      tag: tags.camelot ?? null,
      detected: k ? camelotOf(k) : null,
      margin: k ? k.margin : null,
      ms,
    }
  }, { i, name: path.basename(files[i]), base: FILE_BASE })
  } catch (e) {
    // A crashed tab (a huge file running it out of memory) is recorded against
    // that track by name and the run goes on — never dropped from the counts.
    r = { tag: null, error: `page crashed: ${String(e?.message ?? e).split('\n')[0]}` }
    // The 164MB file in Final takes the whole browser down on the second run
    // (the first run lost all 350 finished rows with it), so a dead browser is
    // relaunched, not just the tab.
    await page.close().catch(() => {})
    if (!browser.isConnected()) browser = await chromium.launch({ channel: 'chrome' })
    page = await openPage()
  }
  rows.push({ rel, ...r })
  // Fresh tab every 20 tracks: decoded AudioBuffers are not freed promptly, and
  // run 2 lost all 8 Trance WAVs at the end to a tab that had grown too big.
  if ((i + 1) % 20 === 0) {
    await page.close().catch(() => {})
    page = await openPage()
  }
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${files.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
}
await browser.close()
server.close()

/**
 * Same tonic, other mode (C vs Cm): on the wheel a major nB's parallel minor
 * is (n-3)A. Counted on its own since 28/09, when 6 of 9 keys typed from
 * Beatport disagreed with the detector in exactly this way, every time
 * "major there, minor here" — a one-way split that says one side leans.
 */
function parallel(a, b) {
  const [an, al] = [Number(a.slice(0, -1)), a.slice(-1)]
  const [bn, bl] = [Number(b.slice(0, -1)), b.slice(-1)]
  if (al === bl) return false
  const [maj, min] = al === 'B' ? [an, bn] : [bn, an]
  return (maj - 3 - min + 12) % 12 === 0
}

function compare(tag, det) {
  if (!tag || !det) return null
  if (tag === det) return 'exact'
  const [tn, tl] = [Number(tag.slice(0, -1)), tag.slice(-1)]
  const [dn, dl] = [Number(det.slice(0, -1)), det.slice(-1)]
  if (parallel(tag, det)) return 'parallel'
  if (tn === dn) return 'relative'
  if (tl === dl && ((tn - dn + 12) % 12 === 1 || (dn - tn + 12) % 12 === 1)) return 'fifth'
  return 'other'
}

const tagged = rows.filter((r) => r.tag && r.detected)
const buckets = { exact: 0, parallel: 0, relative: 0, fifth: 0, other: 0 }
for (const r of tagged) buckets[compare(r.tag, r.detected)]++
const pct = (n) => `${((100 * n) / tagged.length).toFixed(1)}%`
console.log(`\nTracks with a tag key and a detection: ${tagged.length}`)
for (const [k, n] of Object.entries(buckets)) console.log(`  ${k.padEnd(9)} ${String(n).padStart(4)}  ${pct(n)}`)
console.log(`  exact+relative+fifth: ${pct(buckets.exact + buckets.relative + buckets.fifth)}`)

// Which way does the mode lean? Overall, and inside the parallel misses.
const isMinor = (c) => c.endsWith('A')
const par = tagged.filter((r) => compare(r.tag, r.detected) === 'parallel')
console.log(`\nMode: tags say minor ${tagged.filter((r) => isMinor(r.tag)).length}/${tagged.length}, detector says minor ${tagged.filter((r) => isMinor(r.detected)).length}/${tagged.length}`)
console.log(`  parallel misses: tag major -> detected minor ${par.filter((r) => !isMinor(r.tag)).length}, tag minor -> detected major ${par.filter((r) => isMinor(r.tag)).length}`)
const tagMajor = tagged.filter((r) => !isMinor(r.tag))
console.log(`  of the ${tagMajor.length} tag-major tracks: detector exact ${tagMajor.filter((r) => r.tag === r.detected).length}, parallel-minor ${tagMajor.filter((r) => compare(r.tag, r.detected) === 'parallel').length}`)

// Does the margin separate right from wrong? Exact-rate above each margin cut.
for (const cut of [0, 0.02, 0.05, 0.08, 0.1, 0.15]) {
  const s = tagged.filter((r) => r.margin >= cut)
  const ex = s.filter((r) => r.tag === r.detected).length
  console.log(`  margin ≥ ${cut.toFixed(2)}: ${s.length} tracks, exact ${s.length ? ((100 * ex) / s.length).toFixed(1) : '-'}%`)
}

const untagged = rows.filter((r) => !r.tag)
console.log(`\nNo tag key: ${untagged.length}`)
for (const r of untagged) console.log(`  ${r.detected ?? '—'}  margin ${r.margin?.toFixed(3) ?? '-'}  ${r.error ? 'ERROR ' + r.error + '  ' : ''}${r.rel}`)
const errors = rows.filter((r) => r.error)
console.log(`\nDecode errors: ${errors.length}`)
for (const r of errors) console.log(`  ${r.rel}: ${r.error}`)
const ms = rows.filter((r) => r.ms).map((r) => r.ms)
console.log(`\nDetector time per track: mean ${(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(0)}ms, max ${Math.max(...ms).toFixed(0)}ms`)
fs.writeFileSync(path.join(process.env.TEMP ?? '.', 'key-detect-rows.json'), JSON.stringify(rows, null, 1))
