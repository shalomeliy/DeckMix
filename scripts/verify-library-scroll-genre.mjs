/**
 * v0.9.39: Shalom's own sequence (06/10) — genre filter, scroll down, load a song, PLAY, PAUSE — and the list must be where he left it.
 *   node scripts/verify-library-scroll-genre.mjs   (against npm run dev; DECKMIX_URL overrides :5173; PW_CHROME = a Chromium binary)
 *
 * What `verify-library-scroll-keeps.mjs` could not catch: there every song is 120-139 BPM, so the suggestions are almost the whole library and the
 * clamp is small. Here the BPMs are spread 70-188, so playing one leaves a handful of suggestions; the box clamps the offset down to them, and
 * v0.12.10 carried that clamp back to the library on PAUSE — the jump to the top he saw. Two rounds, because a remembered offset that is wrong
 * shows on the second play. Synthetic songs in the browser's own file store (OPFS).
 */
import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined, args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await (await b.newContext({ viewport: { width: 1536, height: 710 } })).newPage()
const logs = []
page.on('pageerror', e => logs.push('PAGEERROR ' + e.message))
await page.addInitScript(() => { window.mod = (p) => { const hit = performance.getEntriesByType('resource').map(e => new URL(e.name)).find(u => u.pathname === p); return import(hit ? hit.pathname + hit.search : p) } })
await page.goto(process.env.DECKMIX_URL || 'http://localhost:5173/'); await page.waitForTimeout(1500)
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory()
  const lib = await root.getDirectoryHandle('Tracks', { create: true })
  const techno = await lib.getDirectoryHandle('Techno', { create: true })
  const house = await lib.getDirectoryHandle('House', { create: true })
  const sr = 11025, dur = 6, n = sr * dur
  for (let s = 0; s < 80; s++) {
    const pcm = new Int16Array(n * 2), bpm = 70 + (s % 60) * 2, dir = s < 60 ? techno : house
    for (let i = 0; i < n; i++) { const t = i / sr, beat = ((t * bpm) / 60) % 1; const v = Math.exp(-beat * 18) * Math.sin(2 * Math.PI * 55 * t) * 0.8; pcm[2 * i] = v * 32767; pcm[2 * i + 1] = v * 30000 }
    const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf)
    const w = (o, str) => [...str].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)))
    w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true)
    dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true)
    dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, pcm.length * 2, true)
    new Int16Array(buf, 44).set(pcm)
    const ws = await (await dir.getFileHandle(`Track ${String(s).padStart(2, '0')}.wav`, { create: true })).createWritable(); await ws.write(buf); await ws.close()
  }
  window.showDirectoryPicker = async () => lib
})
await page.getByRole('button', { name: /LOAD MY MUSIC FOLDER/i }).first().click()
await page.waitForTimeout(15000)
const call = (fn, ...args) => page.evaluate(async ([fn, args]) => {
  const { useStore } = await window.mod('/src/app/state/store.ts'); const ctl = await window.mod('/src/controls.ts')
  return new Function('useStore', 'ctl', 'args', fn)(useStore, ctl, args)
}, [fn, args])
await call(`ctl.setGenreFilter(['Techno'])`)
await page.waitForTimeout(800)
const box = `[...document.querySelectorAll('div')].find(e => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.querySelector('table'))`
const top = () => page.evaluate(`${box}?.scrollTop`)
const rows = await call(`return useStore.getState().library.visibleIds.length`)
const scrolled = 1200
await page.evaluate(`${box}.scrollTop = ${scrolled}`)
await page.waitForTimeout(500)
const before = await top()
let pass = before === scrolled && rows === 60
console.log(`${pass ? 'ok  ' : 'FAIL'}  Techno filter: ${rows} rows, scrolled to ${before}px`)
for (const round of [1, 2]) {
  await call(`const t = useStore.getState().library.tracks.find(t => t.path.includes('Techno') && t.path.includes('Track ${round === 1 ? '45' : '50'}')); return ctl.loadTrackToDeck('A', t)`)
  await page.waitForTimeout(800)
  await call(`ctl.togglePlay('A')`)
  await page.waitForTimeout(2000)
  const playing = await call(`return useStore.getState().decks.A.playing`)
  const suggestions = await call(`return useStore.getState().library.visibleIds.length`)
  const during = await top()
  await call(`ctl.togglePlay('A')`)
  await page.waitForTimeout(1500)
  const after = await top()
  const ok = playing && suggestions < rows && Math.abs(after - scrolled) <= 2
  pass &&= ok
  console.log(`${ok ? 'ok  ' : 'FAIL'}  round ${round}: PLAY → ${suggestions} rows on screen, list at ${during}px; PAUSE → list at ${after}px (scrolled to ${scrolled}px)`)
}
pass &&= logs.length === 0
console.log(`${pass ? 'PASS' : 'FAIL'}  the list stays where he scrolled it${logs.length ? ' — ' + logs.join(' | ') : ''}`)
await b.close()
process.exit(pass ? 0 : 1)
