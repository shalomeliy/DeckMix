/**
 * v0.8.3 browser verification. Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-set-history.mjs
 *
 * The history log itself (`appendHistoryEntry` in `loadTrackToDeck`) has no
 * unit test — it's a store write triggered by a real load, not an algorithm
 * — so what matters is whether real loads in the real browser actually
 * produce the right entries, in order, without deduplication (Shalom's own
 * decision, 13/09), and whether the TopBar button/screen reflect them.
 * `formatSetHistory` itself IS covered by `tests/core/set-history.test.ts`.
 * Same fake-`showDirectoryPicker`/fake-`indexedDB` harness as
 * verify-now-playing-strip.mjs. Assertions read the DOM only (open the
 * screen, count/read `<li>`s) — a `useStore.getState()` reached through a
 * fresh `import('/src/app/state/store.ts')` was tried first and found to
 * return a *different* module instance than the one React actually renders
 * (reproduced independently on `verify-sampler-rename.mjs`'s own re-resolve
 * assertion, which fails the same way on this Vite 8 setup) — a pre-existing
 * tooling gap, not a v0.8.3 bug, and not this script's problem to fix.
 */
import { chromium } from 'playwright'

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
function id3TextFrame(id, value) {
  const payload = Buffer.concat([Buffer.from([0]), Buffer.from(value, 'latin1')])
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length, 0)
  return Buffer.concat([Buffer.from(id, 'ascii'), size, Buffer.from([0, 0]), payload])
}
function id3Tag(bpm, camelot) {
  const frames = Buffer.concat([
    ...(bpm != null ? [id3TextFrame('TBPM', String(bpm))] : []),
    ...(camelot ? [id3TextFrame('TKEY', camelot)] : []),
  ])
  const header = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0]), syncsafe32(frames.length)])
  return Buffer.concat([header, frames])
}
function buildTaggedWav(bpm, camelot, freqHz, { durationSec = 6, sampleRate = 8000 } = {}) {
  const numSamples = Math.round(durationSec * sampleRate)
  const dataSize = numSamples * 2
  const pcm = Buffer.alloc(dataSize)
  for (let i = 0; i < numSamples; i++) {
    pcm.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * freqHz * i) / sampleRate)), i * 2)
  }
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0)
  fmt.writeUInt16LE(1, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * 2, 8)
  fmt.writeUInt16LE(2, 12)
  fmt.writeUInt16LE(16, 14)
  const tag = id3Tag(bpm, camelot)
  const tagPadded = tag.length % 2 === 0 ? tag : Buffer.concat([tag, Buffer.from([0])])
  const chunk = (id, body) => {
    const size = Buffer.alloc(4)
    size.writeUInt32LE(body.length, 0)
    return Buffer.concat([Buffer.from(id, 'ascii'), size, body])
  }
  const fmtChunk = chunk('fmt ', fmt)
  const dataChunk = chunk('data', pcm)
  const id3Chunk = chunk('ID3 ', tagPadded)
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmtChunk, dataChunk, id3Chunk])
  const riffSize = Buffer.alloc(4)
  riffSize.writeUInt32LE(body.length, 0)
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), riffSize, body])
}

function harness(tracks) {
  const files = Object.fromEntries(Object.entries(tracks).map(([name, buf]) => [name, buf.toString('base64')]))
  return `(() => {
  window.__unhandled = [];
  addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason)));
  const files = ${JSON.stringify(files)};
  const makeFile = (name) => ({
    kind: 'file', name,
    getFile: async () => {
      const bytes = Uint8Array.from(atob(files[name]), (c) => c.charCodeAt(0));
      return new File([bytes], name, { type: 'audio/wav' });
    },
  });
  const makeDir = (name) => ({
    kind: 'directory', name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () { for (const n of Object.keys(files)) yield [n, makeFile(n)]; },
  });
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => makeDir('Tracks') });
  const mem = new Map();
  mem.set('deckmix:libraryDir', makeDir('Tracks'));
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
})()`
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined })

async function scenario(name, tracks, check) {
  const page = await browser.newPage({ viewport: VIEWPORT })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(harness(tracks))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  try {
    await check(page, errors)
    ok(`${name}: no console errors`, errors.length === 0, errors[0])
    const unhandled = await page.evaluate(() => window.__unhandled ?? [])
    ok(`${name}: no unhandled rejections`, unhandled.length === 0, unhandled[0])
  } finally {
    await page.close()
  }
}

const row = (page, text) => page.locator('tbody tr', { hasText: new RegExp(text) })
async function dragTrackToDeck(page, trackName, deckIndex) {
  await page.evaluate(
    ({ trackId, deckIndex }) => {
      const dt = new DataTransfer()
      dt.setData('application/x-soundgrid-track', trackId)
      const target = document.querySelectorAll('section')[deckIndex]
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }))
    },
    { trackId: trackName, deckIndex },
  )
  await page.waitForTimeout(300)
}
const openHistory = async (page) => {
  await page.getByRole('button', { name: /^History \(/ }).click()
  return page.locator('ul[aria-label^="Set history"] li')
}

// 1. Loading two different tracks (one per deck) produces two entries, in
// load order, with the right deck identity — verified through the actual
// screen the app renders, not a poked-at store.
await scenario(
  'two different loads produce two ordered entries',
  {
    'Track One.wav': buildTaggedWav(128, '8A', 220),
    'Track Two.wav': buildTaggedWav(128, '9A', 330),
  },
  async (page) => {
    await row(page, 'Track One').dblclick() // loads to deck A
    await page.waitForTimeout(300)
    await dragTrackToDeck(page, 'Track Two.wav', 2) // section 2 = deck B
    const items = await openHistory(page)
    ok('history has exactly 2 entries', (await items.count()) === 2)
    const first = await items.nth(0).innerText()
    const second = await items.nth(1).innerText()
    ok('entry 1 is deck A / Track One', first.includes('A') && first.includes('Track One'), first)
    ok('entry 2 is deck B / Track Two', second.includes('B') && second.includes('Track Two'), second)
  },
)

// 2. Loading the same track twice in a row is NOT deduplicated — Shalom's
// explicit decision (13/09): the log shows everything that was loaded.
await scenario(
  'reloading the same track twice creates two entries, not one',
  { 'Repeat.wav': buildTaggedWav(128, '8A', 220) },
  async (page) => {
    await row(page, 'Repeat').dblclick()
    await page.waitForTimeout(300)
    await row(page, 'Repeat').dblclick()
    await page.waitForTimeout(300)
    const items = await openHistory(page)
    ok('history has exactly 2 entries for the same track', (await items.count()) === 2)
    const first = await items.nth(0).innerText()
    const second = await items.nth(1).innerText()
    ok('both entries name the same track (no dedup)', first.includes('Repeat') && second.includes('Repeat'), `${first} | ${second}`)
  },
)

// 3. The TopBar's "History" entry button is hidden before any load and
// appears (with the right count) after — no permanently-dead button.
await scenario(
  'History button only appears once something has loaded',
  { 'Track One.wav': buildTaggedWav(128, '8A', 220) },
  async (page) => {
    const before = await page.getByRole('button', { name: /^History \(/ }).count()
    ok('no History button before any load', before === 0)
    await row(page, 'Track One').dblclick()
    await page.waitForTimeout(300)
    const after = page.getByRole('button', { name: /^History \(/ })
    ok('History button appears after a load', (await after.count()) === 1)
    // `Button` renders its label uppercase via CSS — innerText reflects that
    // transform, so compare case-insensitively rather than to a literal string.
    ok('History button shows the right count', /history \(1\)/i.test(await after.innerText()))
  },
)

// 4. Opening the screen shows every entry, in order; reloading the page
// clears the in-memory log entirely (Shalom's decision 3, 13/09).
await scenario(
  'history screen lists entries; reload clears them',
  {
    'Track One.wav': buildTaggedWav(128, '8A', 220),
    'Track Two.wav': buildTaggedWav(128, '9A', 330),
  },
  async (page) => {
    await row(page, 'Track One').dblclick()
    await page.waitForTimeout(300)
    await dragTrackToDeck(page, 'Track Two.wav', 2)
    await page.getByRole('button', { name: /^History \(/ }).click()
    const items = page.locator('ul[aria-label^="Set history"] li')
    ok('screen lists both entries', (await items.count()) === 2)
    ok('first row shows Track One', (await items.nth(0).innerText()).includes('Track One'))
    ok('second row shows Track Two', (await items.nth(1).innerText()).includes('Track Two'))
    await page.keyboard.press('Escape')
    ok('Escape closes the screen', (await page.locator('ul[aria-label^="Set history"]').count()) === 0)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)
    ok('History button is gone after reload (history is empty again)', (await page.getByRole('button', { name: /^History \(/ }).count()) === 0)
  },
)

// 5. A track whose contentHash never resolves (hash failure) must not
// produce a history entry — same degrade-in-silence-but-visible-elsewhere
// rule as `lastPlayedAt`. Simulated by breaking `crypto.subtle.digest` for
// this page only, matching how the codebase itself detects hash failure.
await scenario(
  'a track whose hash fails is not added to history',
  { 'Track One.wav': buildTaggedWav(128, '8A', 220) },
  async (page) => {
    await page.evaluate(() => {
      crypto.subtle.digest = async () => {
        throw new Error('forced failure for verification')
      }
    })
    await row(page, 'Track One').dblclick()
    await page.waitForTimeout(300)
    ok(
      'no History button appears when hashing fails (no entry was added)',
      (await page.getByRole('button', { name: /^History \(/ }).count()) === 0,
    )
  },
)

// 6. Export writes the exact expected text through the save dialog, and a
// canceled dialog leaves the history untouched (still exportable again).
await scenario(
  'export writes the formatted setlist and survives a cancel',
  {
    'Track One.wav': buildTaggedWav(128, '8A', 220),
    'Track Two.wav': buildTaggedWav(128, '9A', 330),
  },
  async (page) => {
    await row(page, 'Track One').dblclick()
    await page.waitForTimeout(300)
    await dragTrackToDeck(page, 'Track Two.wav', 2)

    // First: cancel the dialog — must not throw, must not clear history.
    await page.evaluate(() => {
      window.showSaveFilePicker = async () => {
        throw new DOMException('The user aborted a request.', 'AbortError')
      }
    })
    await page.getByRole('button', { name: /^History \(/ }).click()
    await page.getByRole('button', { name: /^Export/i }).click()
    await page.waitForTimeout(200)
    ok('canceling the export dialog keeps both entries', (await page.locator('ul[aria-label^="Set history"] li').count()) === 2)

    // Then: a real save — capture what actually gets written.
    const written = await page.evaluate(async () => {
      let suggestedName = null
      let text = null
      window.showSaveFilePicker = async (opts) => {
        suggestedName = opts?.suggestedName ?? null
        return {
          createWritable: async () => ({
            write: async (chunk) => {
              text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
            },
            close: async () => {},
          }),
        }
      }
      const btn = [...document.querySelectorAll('button')].find((b) => /export/i.test(b.textContent ?? ''))
      btn.click()
      await new Promise((r) => setTimeout(r, 300))
      return { suggestedName, text }
    })
    ok('suggested filename looks like a dated setlist file', /^deckmix-setlist-\d{4}-\d{2}-\d{2}\.txt$/.test(written.suggestedName ?? ''), written.suggestedName)
    ok(
      'written text lists both tracks in order, numbered',
      written.text?.includes('1. Track One') && written.text?.includes('2. Track Two'),
      written.text,
    )
    await page.waitForTimeout(200)
    ok('a success notice appears after saving', (await page.getByText('Setlist saved.').count()) > 0)
  },
)

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
