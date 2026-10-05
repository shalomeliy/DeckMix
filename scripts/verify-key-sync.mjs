/**
 * v0.9.21, key sync: end to end in the running app, at the owner's viewport (1536 x 710).
 *   node scripts/verify-key-sync.mjs   (against npm run dev; DECKMIX_URL overrides :5173; PW_CHROME = a Chromium binary)
 *
 * The same two synthetic songs as verify-key-lock.mjs, in the browser's own file store (OPFS) — no real music touched. The keys are put on
 * the loaded tracks by hand (a sine has no key to detect): "KL Tone" (440 Hz) is called Am = 8A on deck A, "KL Click" Bbm = 3A on deck B.
 * What it proves, by recording deck A's own output (its fader node):
 *  - Key sync on A moves it one semitone up (8A → 3A, not five steps round the wheel) and the deck sounds 466 Hz (440 × 2^(1/12));
 *  - it turns the key lock on by itself, and it stays put with the tempo fader at +8%;
 *  - pressed again: back to 440 Hz, key lock left on; key lock off clears the key sync;
 *  - no key on deck B: nothing moves and the notice names deck B; a new track on A clears the move;
 *  - the three buttons fit under the platter, the page still fits 710 px; nothing throws.
 */
import { chromium } from 'playwright'

const URL = process.env.DECKMIX_URL || 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined, args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: VIEWPORT })
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
  const sr = 44100, dur = 40, n = sr * dur
  for (const name of ['KL Tone', 'KL Click']) {
    const pcm = new Int16Array(n * 2)
    for (let i = 0; i < n; i++) {
      const t = i / sr
      let s
      if (name === 'KL Tone') s = 0.3 * Math.sin(2 * Math.PI * 440 * t)
      else { const f = t % 1; s = f < 0.003 ? 0.9 * Math.sin(2 * Math.PI * 2000 * f) : 0 }
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

// Shared page helpers: load a song onto A, and record A's own output with the context time each sample is played at.
await page.evaluate(async () => {
  const { useStore } = await window.mod('/src/app/state/store.ts')
  const ctl = await window.mod('/src/controls.ts')
  const { engine } = await window.mod('/src/platform/audio-webaudio/engine.ts')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const wait = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(200) } return false }
  await wait(() => useStore.getState().library.tracks.filter((t) => t.name.startsWith('KL ')).length === 2, 30000)
  window.kl = {
    async loadB(name) {
      const t = useStore.getState().library.tracks.find((x) => x.name.startsWith(name))
      await ctl.loadTrackToDeck('B', t)
      await wait(() => !useStore.getState().decks.B.loading && useStore.getState().decks.B.track?.name.startsWith(name), 30000)
    },
    /** The deck's own analysis writes a detected key onto the loaded track when it finishes; a key set before that is overwritten. */
    async settled(deckId) {
      return wait(() => ['analyzed', 'failed'].includes(useStore.getState().decks[deckId].track?.analysisState), 30000)
    },
    setKey(deckId, camelot) {
      // On the library's track as well: a library refresh copies its tracks over the decks' (`core/tag-merge.ts`), so a key set on the deck
      // alone is back to the detected one a second later.
      const d = useStore.getState().decks[deckId]
      const s = useStore.getState()
      s.setLibrary({ tracks: s.library.tracks.map((t) => (t.id === d.track.id ? { ...t, camelot } : t)) })
      useStore.getState().patchDeck(deckId, { track: { ...d.track, camelot } })
    },
    async load(name) {
      ctl.pause('A')
      const t = useStore.getState().library.tracks.find((x) => x.name.startsWith(name))
      await ctl.loadTrackToDeck('A', t)
      await wait(() => !useStore.getState().decks.A.loading && useStore.getState().decks.A.track?.name.startsWith(name), 30000)
      ctl.setCrossfader(-1)
    },
    /** `sec` of deck A's output, plus (context time, deck position) pairs read on the main thread meanwhile. */
    async record(sec) {
      const ctx = engine.ctx
      const proc = ctx.createScriptProcessor(1024, 2, 1)
      const mute = ctx.createGain(); mute.gain.value = 0
      const chunks = []
      proc.onaudioprocess = (e) => chunks.push({ t: e.playbackTime, d: new Float32Array(e.inputBuffer.getChannelData(0)) })
      engine.decks.A.faderGain.connect(proc); proc.connect(mute); mute.connect(ctx.destination)
      const pairs = []
      const end = performance.now() + sec * 1000
      while (performance.now() < end) { pairs.push({ t: ctx.currentTime, pos: engine.decks.A.position }); await new Promise((r) => requestAnimationFrame(r)) }
      engine.decks.A.faderGain.disconnect(proc); proc.disconnect(); mute.disconnect()
      return { chunks, pairs, sr: ctx.sampleRate }
    },
  }
})


const pitch = `
  const measure = async () => {
    await new Promise((r) => setTimeout(r, 700))
    const { chunks, sr } = await window.kl.record(1.2)
    const d = chunks.flatMap((c) => [...c.d]).slice(Math.floor(0.2 * sr), Math.floor(0.2 * sr) + 16384)
    const corr = (lag) => { let a = 0; for (let i = 0; i + lag < d.length; i++) a += d[i] * d[i + lag]; return a }
    let best = 0, bestLag = 0
    for (let lag = Math.floor(sr / 600); lag <= Math.ceil(sr / 350); lag++) { const c = corr(lag); if (c > best) { best = c; bestLag = lag } }
    const y0 = corr(bestLag - 1), y1 = best, y2 = corr(bestLag + 1)
    return sr / (bestLag + (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2))
  }`
await page.evaluate(`window.measure = async () => { ${pitch}; return measure() }`)

const r = await page.evaluate(async () => {
  const ctl = await window.mod('/src/controls.ts')
  const { useStore } = await window.mod('/src/app/state/store.ts')
  const { settings } = await window.mod('/src/platform/settings-idb/store.ts')
  const S = () => useStore.getState()
  const out = {}
  await window.kl.load('KL Tone')
  await window.kl.loadB('KL Click')
  out.settled = (await window.kl.settled('A')) && (await window.kl.settled('B'))
  window.kl.setKey('A', '8A')
  window.kl.setKey('B', null)
  // 1. deck B has no key: nothing moves, the notice names B
  await ctl.toggleKeySync('A')
  out.noKey = { shift: S().decks.A.keySyncShift, keyLock: S().decks.A.keyLock, notice: S().notice?.text ?? null }
  window.kl.setKey('B', '3A')
  ctl.seekDeck('A', 5)
  ctl.play('A')
  out.plain = await window.measure()
  // 2. key sync: 8A against 3A
  out.keysAt = [S().decks.A.track.camelot, S().decks.B.track.camelot]
  await ctl.toggleKeySync('A')
  out.synced = { shift: S().decks.A.keySyncShift, keyLock: S().decks.A.keyLock, notice: S().notice?.text ?? null, hz: await window.measure() }
  out.label = [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => /^Key [+-]?\d/.test(t))
  // 3. tempo +8%: still one semitone up
  ctl.setTempo('A', 0.08 / settings.values.tempoRange)
  out.fast = await window.measure()
  ctl.setTempo('A', 0)
  // 4. pressed again: own key, key lock stays on
  await ctl.toggleKeySync('A')
  out.back = { shift: S().decks.A.keySyncShift, keyLock: S().decks.A.keyLock, hz: await window.measure() }
  // 5. key lock off clears key sync
  await ctl.toggleKeySync('A')
  await ctl.toggleKeyLock('A')
  out.lockOff = { shift: S().decks.A.keySyncShift, keyLock: S().decks.A.keyLock, hz: await window.measure() }
  ctl.pause('A')
  // 6. a new track on A clears it
  await ctl.toggleKeySync('A')
  const before = S().decks.A.keySyncShift
  await window.kl.load('KL Tone')
  await window.kl.settled('A')
  out.reload = { before, after: S().decks.A.keySyncShift }
  // 7. the three buttons under each platter: none wider than its deck column, none overlapping the tempo fader
  await ctl.toggleKeySync('A')
  await new Promise((r) => setTimeout(r, 200))
  out.rows = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Vinyl').map((v) => {
    const row = v.parentElement.parentElement
    const rr = row.getBoundingClientRect(), col = row.parentElement.getBoundingClientRect()
    const fader = row.parentElement.nextElementSibling?.getBoundingClientRect()
    return { left: rr.left, right: rr.right, colLeft: col.left, colRight: col.right, faderLeft: fader?.left ?? null, n: row.querySelectorAll('button').length }
  })
  return out
})
ok('both decks finished their own analysis before the keys were set', r.settled === true, String(r.settled))
ok('the keys set by hand are still there when key sync is pressed', JSON.stringify(r.keysAt) === '["8A","3A"]', JSON.stringify(r.keysAt))
ok('no key on deck B: nothing moves, the notice names deck B', r.noKey.shift === null && !r.noKey.keyLock && /B/.test(r.noKey.notice ?? ''), `shift ${r.noKey.shift}, keyLock ${r.noKey.keyLock}, "${r.noKey.notice}"`)
ok('before key sync deck A sounds its own 440 Hz', Math.abs(r.plain - 440) < 3, `${r.plain.toFixed(1)} Hz`)
ok('key sync 8A against 3A: one semitone up, key lock on by itself', r.synced.shift === 1 && r.synced.keyLock, `shift ${r.synced.shift}, keyLock ${r.synced.keyLock}, "${r.synced.notice}"`)
ok('and it sounds one semitone up (466.2 Hz; the key lock reads ~0.5% sharp at its 60 ms block)', r.synced.hz > 465 && r.synced.hz < 470, `${r.synced.hz.toFixed(1)} Hz`)
ok('the button reads "Key +1"', r.label.includes('Key +1'), JSON.stringify(r.label))
ok('tempo +8%: still one semitone up, not a record', r.fast > 465 && r.fast < 470, `${r.fast.toFixed(1)} Hz (without key lock it would be ${(466.16 * 1.08).toFixed(1)})`)
ok('pressed again: back to its own key, key lock left on', r.back.shift === null && r.back.keyLock && r.back.hz > 439 && r.back.hz < 443, `shift ${r.back.shift}, keyLock ${r.back.keyLock}, ${r.back.hz.toFixed(1)} Hz`)
ok('key lock off clears key sync', r.lockOff.shift === null && !r.lockOff.keyLock && Math.abs(r.lockOff.hz - 440) < 3, `shift ${r.lockOff.shift}, keyLock ${r.lockOff.keyLock}, ${r.lockOff.hz.toFixed(1)} Hz`)
ok('a new track on the deck clears the move', r.reload.before === 1 && r.reload.after === null, `before ${r.reload.before}, after ${r.reload.after}`)
ok('three buttons under each platter, inside the deck, clear of the tempo fader', r.rows.length === 2 && r.rows.every((x) => x.n === 3 && x.left >= x.colLeft - 0.5 && (x.faderLeft == null || x.right <= x.faderLeft)),
  JSON.stringify(r.rows.map((x) => ({ n: x.n, row: [Math.round(x.left), Math.round(x.right)], fader: x.faderLeft && Math.round(x.faderLeft) }))))
const f = await page.evaluate(() => ({ scroll: document.documentElement.scrollHeight, inner: window.innerHeight, w: document.documentElement.scrollWidth, iw: window.innerWidth }))
ok('page still fits 1536 x 710', f.scroll <= f.inner && f.w <= f.iw, `scrollHeight ${f.scroll} / ${f.inner}, scrollWidth ${f.w} / ${f.iw}`)
ok('no errors in the console', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
