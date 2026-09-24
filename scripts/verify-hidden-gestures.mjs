/**
 * v0.8.24 verification — hidden gestures made visible. Run against
 * `npm run dev` on :5173:
 *
 *   node scripts/verify-hidden-gestures.mjs
 *
 * Holding Shift in Hot Cue mode used to change nothing on screen, and the
 * next click deleted a cue. Now the set pads say "× delete". Also checks the
 * SHIFT line under the pads (and that it doesn't push the page past the
 * owner's 710px-tall viewport), the visible ✎ rename, and the Keys screen.
 * Harness (real decodable WAV, in-memory IndexedDB, `window.__import`) is the
 * one `verify-grid-correction.mjs` uses.
 */
import { chromium } from 'playwright'
import { createHash } from 'node:crypto'

const URL = 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function syncsafe32(n) {
  return Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f])
}
function id3Tag(bpm) {
  const payload = Buffer.concat([Buffer.from([0]), Buffer.from(String(bpm), 'latin1')])
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length, 0)
  const frame = Buffer.concat([Buffer.from('TBPM', 'ascii'), size, Buffer.from([0, 0]), payload])
  return Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0]), syncsafe32(frame.length), frame])
}
function buildClickWav(bpm, { durationSec = 20, sampleRate = 8000 } = {}) {
  const numSamples = Math.round(durationSec * sampleRate)
  const pcm = Buffer.alloc(numSamples * 2)
  const beatSamples = Math.round((60 / bpm) * sampleRate)
  for (let i = 0; i < numSamples; i++) {
    const inBeat = i % beatSamples
    const v = inBeat < 80 ? 20000 * Math.exp(-inBeat / 15) * (inBeat % 2 ? 1 : -1) : 0
    pcm.writeInt16LE(Math.round(v), i * 2)
  }
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0)
  fmt.writeUInt16LE(1, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * 2, 8)
  fmt.writeUInt16LE(2, 12)
  fmt.writeUInt16LE(16, 14)
  const tag = id3Tag(bpm)
  const tagPadded = tag.length % 2 === 0 ? tag : Buffer.concat([tag, Buffer.from([0])])
  const chunk = (id, body) => {
    const size = Buffer.alloc(4)
    size.writeUInt32LE(body.length, 0)
    return Buffer.concat([Buffer.from(id, 'ascii'), size, body])
  }
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), chunk('fmt ', fmt), chunk('data', pcm), chunk('ID3 ', tagPadded)])
  const riffSize = Buffer.alloc(4)
  riffSize.writeUInt32LE(body.length, 0)
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), riffSize, body])
}

const wavBytes = buildClickWav(120)
const CONTENT_HASH = createHash('sha256').update(wavBytes).digest('hex')
const GRID_KEY = 'deckmix:gridCorrection:' + CONTENT_HASH

function harness(seed) {
  return `(() => {
  window.__unhandled = [];
  addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason)));
  const bytes = Uint8Array.from(atob(${JSON.stringify(wavBytes.toString('base64'))}), (c) => c.charCodeAt(0));
  const makeFile = (name) => ({ kind: 'file', name, getFile: async () => new File([bytes], name, { type: 'audio/wav' }) });
  const makeDir = (name) => ({
    kind: 'directory', name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () { yield ['clicks.wav', makeFile('clicks.wav')]; },
  });
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => makeDir('Tracks') });
  const mem = new Map();
  mem.set('deckmix:libraryDir', makeDir('Tracks'));
  ${seed !== undefined ? `mem.set(${JSON.stringify(GRID_KEY)}, ${JSON.stringify(seed)});` : ''}
  const fire = (obj, prop, value) => setTimeout(() => { obj.result = value; obj[prop] && obj[prop](); }, 0);
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: {
    open() {
      const req = {};
      setTimeout(() => {
        const db = { transaction: () => {
          const tx = {};
          tx.objectStore = () => ({
            transaction: tx,
            get: (k) => { const r = {}; fire(r, 'onsuccess', mem.get(k)); return r; },
            put: (v, k) => { mem.set(k, v); const r = {}; fire(r, 'onsuccess', undefined); return r; },
          });
          setTimeout(() => tx.oncomplete && tx.oncomplete(), 1);
          return tx;
        } };
        req.result = db;
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    },
  } });
  // The app's own module instance, not a second copy: Vite serves a file
  // edited since the dev server started as \`store.ts?t=…\`, and a plain
  // import('/src/app/state/store.ts') would get a fresh, empty store.
  window.__import = (path) => {
    const loaded = performance.getEntriesByType('resource').map((r) => r.name).find((n) => new URL(n).pathname === path);
    return import(loaded ?? path);
  };
  window.__readGrid = () => mem.get(${JSON.stringify(GRID_KEY)});
})()`
}


const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined })
const page = await browser.newPage({ viewport: VIEWPORT })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.addInitScript(harness(undefined))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1000)
await page.locator('tbody tr').first().dblclick()
for (let i = 0; i < 60; i++) {
  const ready = await page.evaluate(async () => {
    const { useStore } = await window.__import('/src/app/state/store.ts')
    return useStore.getState().decks.A.beatGrid != null
  })
  if (ready) break
  await page.waitForTimeout(250)
}
const deckA = page.locator('section').nth(0)

// 1. layout: the new SHIFT line must not push the page past the owner's 710px
{
  // Per deck, not the page: the app root is overflow-hidden, so the page
  // itself can never scroll and a page-level check could never fail.
  const decks = await page.evaluate(() =>
    [...document.querySelectorAll('main section')].slice(0, 2).map((el) => ({ scroll: el.scrollHeight, client: el.clientHeight })),
  )
  ok('layout: both loaded decks fit their panels at 1536×710', decks.length === 2 && decks.every((d) => d.scroll <= d.client), JSON.stringify(decks))
  const line = deckA.getByText('SHIFT:', { exact: true })
  ok('SHIFT line: shown under the pads', (await line.count()) === 1)
  const lit = await deckA.locator('span.text-grid-text', { hasText: 'delete' }).count()
  ok('SHIFT line: the Hot Cue part is lit in Hot Cue mode', lit === 1, String(lit))
}

// 2. set pad 1, then hold Shift: the pad says it will delete
{
  await deckA.getByRole('button', { name: 'Set hot cue 1' }).click()
  await page.waitForTimeout(150)
  await page.keyboard.down('Shift')
  await page.waitForTimeout(150)
  const warned = deckA.getByRole('button', { name: 'Shift held: click deletes hot cue 1' })
  const text = (await warned.count()) ? await warned.innerText() : null
  ok('shift held: the set pad reads "× delete"', text?.includes('× delete') === true, text)
  const empty = await deckA.getByRole('button', { name: 'Set hot cue 2' }).innerText()
  ok('shift held: an empty pad is unchanged', empty.trim() === '2', empty)
  await page.keyboard.up('Shift')
  await page.waitForTimeout(150)
  ok('shift released: pad 1 is a normal cue again', (await deckA.getByRole('button', { name: /^Jump to hot cue/ }).count()) === 1)
}

// 2b. the pad's centre is the pad, even while hovered — ✎ and × stay in corners
{
  const pad = deckA.getByRole('button', { name: /^Jump to hot cue/ })
  await pad.hover()
  const hit = await pad.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return el === at || (el.contains(at) && !at.getAttribute('role'))
  })
  ok('hover: clicking the pad centre still hits the pad, not ✎ or ×', hit)
}

// 2c. F2 on a focused set pad opens the rename box (the keyboard path)
{
  await deckA.getByRole('button', { name: /^Jump to hot cue/ }).focus()
  await page.keyboard.press('F2')
  ok('F2: opens the rename box', (await deckA.getByRole('textbox', { name: 'Rename hot cue 1' }).count()) === 1)
  await page.keyboard.press('Escape')
}

// 3. the visible ✎ opens the same rename box as Alt+click
{
  await deckA.getByRole('button', { name: /^Jump to hot cue/ }).hover()
  await deckA.getByRole('button', { name: 'Edit name of hot cue 1' }).click()
  const box = deckA.getByRole('textbox', { name: 'Rename hot cue 1' })
  ok('✎: opens the rename box', (await box.count()) === 1)
  await page.keyboard.press('Escape')
}

// 3b. FLX4 SHIFT + pad deletes too (owner's decision 24/09) — the same call
//     the MIDI dispatcher makes, so no controller is needed to prove it
{
  const r = await page.evaluate(async () => {
    const ctl = await window.__import('/src/controls.ts')
    const { useStore } = await window.__import('/src/app/state/store.ts')
    ctl.setShiftHeld(true)
    ctl.pressPad('A', 0)()
    ctl.setShiftHeld(false)
    return useStore.getState().decks.A.hotCues.some((c) => c.index === 0)
  })
  ok('FLX4 SHIFT + pad 1: the cue is deleted, as the pad said it would be', r === false)
}

// 4. switching mode moves the lit part of the SHIFT line
{
  await deckA.getByRole('button', { name: 'Pad mode: Loop' }).click()
  await page.waitForTimeout(100)
  const lit = await deckA.locator('span.text-grid-text', { hasText: 'loop roll' }).count()
  ok('SHIFT line: the Loop part is lit in Loop mode', lit === 1, String(lit))
}

// 5. the Keys screen lists every place, with FLX4 names, and Esc closes it
{
  await page.getByRole('button', { name: 'Keys', exact: true }).click()
  // a deck key pressed while reading the table must not reach a hidden deck
  await page.keyboard.press('KeyQ')
  const playing = await page.evaluate(async () => (await window.__import('/src/app/state/store.ts')).useStore.getState().decks.A.playing)
  ok('Keys: Q does nothing to deck A while the screen is open', playing === false)
  const screen = page.getByLabel('Keys and gestures')
  ok('Keys: opens', (await screen.count()) === 1)
  const places = await screen.locator('h3').allInnerTexts()
  ok('Keys: Deck / Pads / Mixer / Library sections', places.join(',').toLowerCase() === 'deck,pads,mixer,library', places.join(','))
  const txt = await screen.innerText()
  ok('Keys: Shift+click deleting a cue is listed', txt.includes('Shift+click a set pad'))
  ok('Keys: the FLX4 column is filled from the mapping', ['Play button', 'Cue button', 'Shift button', 'Jog wheel (turn)'].every((l) => txt.includes(l)))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(100)
  ok('Keys: Esc closes it', (await page.getByLabel('Keys and gestures').count()) === 0)
}

ok('no page errors', errors.length === 0, errors[0])
await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
