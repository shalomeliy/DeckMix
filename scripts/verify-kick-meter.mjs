/**
 * v0.9.75 (19/10), the kick-gap meter (`core/kick-gap.ts`, `platform/audio-webaudio/kick-meter.ts`): at the end of a mix the notice says how
 * far apart the two decks' KICKS were, measured on the sound.
 *   node scripts/verify-kick-meter.mjs   (against npm run dev; DECKMIX_URL overrides :5173; PW_CHROME = a Chromium binary)
 *
 * Synthetic songs only: "KM A"/"KM B" a 55 Hz kick on every beat at 124 BPM (the decks sync them), "KM Tone" no kick at all.
 *  1. a plain mix A -> B as it lands: the notice names a gap and it is small;
 *  2. the same with B's SYNC switched off right after the join and B pushed 40 ms late: the notice must say ~40 ms and warn;
 *  3. two songs with no kick: the notice says it could not measure, and does not say 0;
 *  4. nothing throws.
 */
import { chromium } from 'playwright'

const URL = process.env.DECKMIX_URL || 'http://localhost:5173/'
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined, args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: { width: 1536, height: 710 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.addInitScript(() => {
  window.mod = (p) => {
    const hit = performance.getEntriesByType('resource').map((e) => new URL(e.name)).find((u) => u.pathname === p)
    return import(hit ? hit.pathname + hit.search : p)
  }
})
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory()
  const lib = await root.getDirectoryHandle('Tracks', { create: true })
  const house = await lib.getDirectoryHandle('House', { create: true })
  const sr = 22050, dur = 60, n = sr * dur, bpm = 124
  for (const name of ['KM A', 'KM B', 'KM Tone']) {
    const pcm = new Int16Array(n * 2)
    for (let i = 0; i < n; i++) {
      const t = i / sr
      const beat = ((t * bpm) / 60) % 1
      const s = name === 'KM Tone' ? 0.3 * Math.sin(2 * Math.PI * 440 * t) : Math.exp(-beat * 18) * Math.sin(2 * Math.PI * 55 * beat * (60 / bpm)) * 0.7
      pcm[2 * i] = pcm[2 * i + 1] = Math.max(-1, Math.min(1, s)) * 32767
    }
    const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf)
    const w = (o, str) => [...str].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)))
    w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true)
    dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true)
    dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, pcm.length * 2, true)
    new Int16Array(buf, 44).set(pcm)
    const ws = await (await house.getFileHandle(`${name}.wav`, { create: true })).createWritable()
    await ws.write(buf); await ws.close()
  }
  window.showDirectoryPicker = async () => lib
})
await page.getByRole('button', { name: /LOAD MY MUSIC FOLDER/i }).first().click()

const res = await page.evaluate(async () => {
  const { useStore } = await window.mod('/src/app/state/store.ts')
  const ctl = await window.mod('/src/controls.ts')
  const { engine } = await window.mod('/src/platform/audio-webaudio/engine.ts')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const wait = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50) } return false }
  await wait(() => useStore.getState().library.tracks.filter((t) => t.name.startsWith('KM ')).length === 3, 30000)
  const load = async (d, name) => {
    const t = useStore.getState().library.tracks.find((x) => x.name === name)
    await ctl.loadTrackToDeck(d, t)
    await wait(() => !useStore.getState().decks[d].loading && useStore.getState().decks[d].beatGrid, 30000)
  }
  const mix = async (a, b, knock) => {
    ctl.pause('A'); ctl.pause('B')
    if (useStore.getState().activeTransition) ctl.cancelTransition()
    await load('A', a); await load('B', b)
    ctl.seekDeck('B', 8); ctl.seekDeck('A', 3.3); ctl.play('A')
    await sleep(500)
    useStore.getState().setNotice(null)
    ctl.startAutoTransition('A', 'B', 10)
    if (knock) {
      await wait(() => useStore.getState().decks.B.playing && useStore.getState().activeTransition && !useStore.getState().activeTransition.aligning, 8000)
      useStore.getState().patchDeck('B', { syncActive: false })
      engine.decks.B.seek(engine.decks.B.position + knock)
    }
    await wait(() => !useStore.getState().activeTransition, 20000)
    await sleep(300)
    return useStore.getState().notice
  }
  const aligned = await mix('KM A', 'KM B', 0)
  const knocked = await mix('KM A', 'KM B', -0.04)
  const none = await mix('KM Tone', 'KM Tone', 0)
  ctl.pause('A'); ctl.pause('B')
  return { aligned, knocked, none }
})
const num = (n) => Number(/פער קיקים במיקס: (\d+)/.exec(n?.text ?? '')?.[1])
console.log('aligned:', res.aligned?.text, '\nknocked:', res.knocked?.text, '\nnone:   ', res.none?.text)
ok('an aligned mix names a small gap', num(res.aligned) <= 10 && !/הבסים לא ישבו/.test(res.aligned?.text ?? ''), `${num(res.aligned)} ms`)
ok('a mix with B pushed 40 ms late (seek back) says 20-60 ms (40 pushed, plus the steady ~13 ms debt of v0.9.33), B later, and warns', num(res.knocked) >= 20 && num(res.knocked) <= 60 && res.knocked?.tone === 'warn' && /מאחר/.test(res.knocked.text), `${num(res.knocked)} ms, ${res.knocked?.tone}`)
ok('two songs without a kick: said as not measured, not as 0', /לא הצלחתי למדוד/.test(res.none?.text ?? '') && !/פער קיקים במיקס: 0/.test(res.none?.text ?? ''))
ok('nothing throws', errors.length === 0, errors.slice(0, 2).join(' | '))
await browser.close()
process.exit(results.every((r) => r.pass) ? 0 : 1)
