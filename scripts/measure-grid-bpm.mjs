/**
 * Prints the tag BPM vs the grid BPM the app settles on for one real track.
 *   node scripts/measure-grid-bpm.mjs hermetico   (against npm run dev on :5173)
 */
import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ── one small, real, decodable WAV file (silence) — content doesn't matter,
// only that `decodeAudioData` accepts it and it's long enough to seek/play
// into without hitting the end.
function makeWav(durationSec, sampleRate) {
  const numSamples = Math.round(durationSec * sampleRate)
  const dataSize = numSamples * 2 // 16-bit mono
  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)
  return Buffer.from(buf)
}


import fs from 'node:fs'
import path from 'node:path'
function find(dir, needle) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { const r = find(full, needle); if (r) return r }
    else if (e.name.toLowerCase().includes(needle)) return full
  }
}
const file = find(String.raw`C:\Users\Shalom\Music\Tracks`, process.argv[2] || 'hermetico')
console.log('file:', file)
const b64 = fs.readFileSync(file).toString('base64')
const name = path.basename(file)
const init = `(() => {
  const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
  const makeFile = (n) => ({ kind: 'file', name: n, getFile: async () => new File([bytes], n) });
  const makeDir = (n) => ({ kind: 'directory', name: n, queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    entries: async function* () { yield [${JSON.stringify(name)}, makeFile(${JSON.stringify(name)})]; } });
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => makeDir('Tracks') });
  const mem = new Map(); mem.set('deckmix:libraryDir', makeDir('Tracks'));
  const fire = (o, p, v) => setTimeout(() => { o.result = v; o[p] && o[p](); }, 0);
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: { open() { const req = {}; setTimeout(() => {
    const db = { transaction: () => { const tx = {}; tx.objectStore = () => ({ transaction: tx,
      get: (k) => { const r = {}; fire(r, 'onsuccess', mem.get(k)); return r; },
      put: (v, k) => { mem.set(k, v); const r = {}; fire(r, 'onsuccess', undefined); return r; } });
      setTimeout(() => tx.oncomplete && tx.oncomplete(), 1); return tx; } };
    req.result = db; req.onsuccess && req.onsuccess(); }, 0); return req; } } });
})()`
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined })
const page = await browser.newPage({ viewport: VIEWPORT })
await page.addInitScript(init)
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1000)
const r = await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  const ctl = await import('/src/controls.ts')
  const deadline = Date.now() + 20_000
  let t
  while (Date.now() < deadline) { t = useStore.getState().library.tracks[0]; if (t) break; await new Promise((r) => setTimeout(r, 100)) }
  await ctl.loadTrackToDeck('A', t)
  const d2 = Date.now() + 90_000
  while (Date.now() < d2 && !useStore.getState().decks.A.beatGrid) await new Promise((r) => setTimeout(r, 300))
  const d = useStore.getState().decks.A
  const { engine } = await import('/src/platform/audio-webaudio/engine.ts')
  const { analyzeTrack, pcmFromAudioBuffer } = await import('/src/platform/analyzer-js/analyze.ts')
  const buf = await engine.decode(await (await t.handle.getFile()).arrayBuffer())
  const raw = analyzeTrack(pcmFromAudioBuffer(buf))
  const { buildOnsetEnvelope } = await import('/src/platform/analyzer-js/analyze.ts')
  const { onsets, framesPerSec } = buildOnsetEnvelope(pcmFromAudioBuffer(buf))
  const peakPhaseMs = (bpm, from, to) => {
    const period = (60 / bpm) * framesPerSec
    const n = Math.round(period)
    const bins = new Array(n).fill(0)
    for (let i = from; i < to; i++) {
      const ph = i - Math.floor(i / period) * period
      bins[Math.min(n - 1, Math.floor((ph / period) * n))] += onsets[i]
    }
    let bi = 0
    for (let b = 1; b < n; b++) if (bins[b] > bins[bi]) bi = b
    return (bi / n) * (60 / bpm) * 1000
  }
  const third = Math.floor(onsets.length / 3)
  const drift = (bpm) => {
    const a = peakPhaseMs(bpm, 0, third)
    const c = peakPhaseMs(bpm, 2 * third, onsets.length)
    const beat = (60 / bpm) * 1000
    let d = c - a
    d -= Math.round(d / beat) * beat
    return Math.round(d)
  }
  return { driftMsFirstToLastThird: { at100: drift(100), atGrid: drift(d.beatGrid.bpm) }, detectedBpm: raw.beatGrid?.bpm ?? null, detectedOffset: raw.beatGrid?.offsetSec ?? null, confirmed: raw.beatGridConfirmed, tagBpm: t.bpm ?? null, gridBpm: d.beatGrid?.bpm ?? null, offset: d.beatGrid?.offsetSec ?? null, dur: d.durationSec }
})
console.log(JSON.stringify(r))
await browser.close()
