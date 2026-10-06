/**
 * v0.12.10: the library list stays where the owner scrolled it when a song ends.
 *   node scripts/verify-library-scroll-keeps.mjs   (against npm run dev; DECKMIX_URL overrides :5173; PW_CHROME = a Chromium binary)
 *
 * Found 03/10: while a deck plays, Mix Only switches itself on (the list becomes the suggestions) and when the last deck stops it switches itself off,
 * and the list scrolled back to the top. The cause was not an explicit scroll but the rendered-rows window catching up one render after the list
 * changed, so the offset the layout restored was clamped against the old, shorter content. This plays a 6 s song to its end on an 80-song library
 * scrolled halfway down, and fails if the list is not still there afterwards. Synthetic songs in the browser's own file store (OPFS).
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
  const house = await lib.getDirectoryHandle('House', { create: true })
  const sr = 11025, dur = 6, n = sr * dur
  for (let s = 0; s < 80; s++) {
    const pcm = new Int16Array(n * 2), bpm = 120 + (s % 20)
    for (let i = 0; i < n; i++) { const t = i / sr, beat = ((t * bpm) / 60) % 1; const v = Math.exp(-beat * 18) * Math.sin(2 * Math.PI * 55 * t) * 0.8; pcm[2 * i] = v * 32767; pcm[2 * i + 1] = v * 30000 }
    const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf)
    const w = (o, str) => [...str].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)))
    w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true)
    dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true)
    dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, pcm.length * 2, true)
    new Int16Array(buf, 44).set(pcm)
    const ws = await (await house.getFileHandle(`Track ${String(s).padStart(2, '0')}.wav`, { create: true })).createWritable(); await ws.write(buf); await ws.close()
  }
  window.showDirectoryPicker = async () => lib
})
await page.getByRole('button', { name: /LOAD MY MUSIC FOLDER/i }).first().click()
await page.waitForTimeout(15000)
const scroller = () => page.evaluate(() => { const els = [...document.querySelectorAll('div')].filter(e => { const s = getComputedStyle(e); return /auto|scroll/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 50 && e.querySelector('table') }); return els.map(e => ({ top: e.scrollTop, h: e.scrollHeight, c: e.clientHeight })) })
console.log('scrollers', JSON.stringify(await scroller()))
await page.evaluate(() => { const e = [...document.querySelectorAll('div')].find(e => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 50 && e.querySelector('table')); e.scrollTop = 1500 })
await page.waitForTimeout(500)
console.log('after scroll', JSON.stringify(await scroller()))
// load a track onto deck A via the store (the same call the buttons make) and play it to its end
await page.evaluate(async () => {
  const { useStore } = await window.mod('/src/app/state/store.ts'); const ctl = await window.mod('/src/controls.ts')
  const t = useStore.getState().library.tracks[40]
  await ctl.loadTrackToDeck('A', t)
  ctl.togglePlay('A')
})
const top = async () => (await scroller())[0]?.top
await page.waitForTimeout(1500)
const during = await top()
// Waited for in Node, not with waitForFunction: an async predicate there returns a Promise, which is truthy, so it would "pass" at once (found when this
// script passed against the unfixed code).
const playing = () => page.evaluate(async () => (await window.mod('/src/app/state/store.ts')).useStore.getState().decks.A.playing)
const deadline = Date.now() + 20000
while ((await playing()) && Date.now() < deadline) await page.waitForTimeout(200)
const stillPlaying = await playing()
await page.waitForTimeout(1500)
const after = await top()
// v0.9.39: compared with where he SCROLLED, not with the offset during play. The suggestions list is shorter, so the box clamps it (1500 → 1380 here),
// and the v0.12.10 code then carried that clamp back to the library — this script passed at "1380 → 1380" while he had scrolled to 1500.
const scrolled = 1500
// v0.9.42 (Shalom 06/10): while the song plays the list is at the TOP of the suggestions — they are ranked best first.
const ok = !stillPlaying && during === 0 && Math.abs(after - scrolled) <= 2 && logs.length === 0
console.log(`${ok ? 'PASS' : 'FAIL'}  list scrolled to ${scrolled}px, while the song played: ${during}px, after it ended: ${after}px${logs.length ? ' — ' + logs.join(' | ') : ''}`)
await b.close()
process.exit(ok ? 0 : 1)
