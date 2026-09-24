/**
 * End-to-end reproduction of Shalom's real report, through the REAL app
 * boot flow (React StrictMode's real double-effect invocation included) —
 * not by calling internal functions directly the way
 * scripts/verify-sampler-restore.mjs does. Run against `npm run dev` on
 * :5173:
 *
 *   node scripts/verify-sampler-reload-e2e.mjs
 *
 * A real `page.reload()` can't be used here: the fake `showDirectoryPicker`/
 * `indexedDB` this script (and scripts/verify-mix-assist-load.mjs) needs —
 * because a real native folder-picker dialog can't be automated headlessly
 * — lives entirely in a `page.addInitScript` closure, which re-runs from
 * scratch on every navigation. So "reload" here means: capture the fake
 * IndexedDB's contents after a real drag-and-drop load on page 1, then boot
 * a brand-new page 2 with those exact contents pre-seeded as its starting
 * IndexedDB state — the same practical test (real boot code processing
 * real previously-saved state) without needing IndexedDB to literally
 * survive a navigation in this mock.
 */
import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function buildWav(freq, durationSec, sampleRate = 8000) {
  const numSamples = Math.round(durationSec * sampleRate)
  const pcm = Buffer.alloc(numSamples * 2)
  for (let i = 0; i < numSamples; i++) {
    pcm.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * freq * i) / sampleRate)), i * 2)
  }
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * 2, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14)
  const chunk = (id, body) => {
    const size = Buffer.alloc(4); size.writeUInt32LE(body.length, 0)
    return Buffer.concat([Buffer.from(id, 'ascii'), size, body])
  }
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), chunk('fmt ', fmt), chunk('data', pcm)])
  const riffSize = Buffer.alloc(4); riffSize.writeUInt32LE(body.length, 0)
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), riffSize, body])
}

// A realistic-sized real library (40 tracks, ~2s of real audio each so
// decode/analysis actually costs something) — not the 1-track toy case.
// The dragged track is placed near the END of scan order on purpose: the
// worst case for "resolves only after the WHOLE queue finishes".
const tracks = {}
for (let i = 0; i < 40; i++) tracks[`Track ${String(i).padStart(2, '0')}.wav`] = buildWav(200 + i * 5, 2)
tracks['ZZ Sample To Load.wav'] = buildWav(440, 1)

function harness(extraIdbSeed) {
  const files = Object.fromEntries(Object.entries(tracks).map(([name, buf]) => [name, buf.toString('base64')]))
  return `(() => {
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
  ${extraIdbSeed ? `for (const [k, v] of Object.entries(${JSON.stringify(extraIdbSeed)})) mem.set(k, v);` : ''}
  window.__idbMem = mem; // exposed so the test can read it back out
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

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })

// ---------- Phase 1: load the folder, drag a track onto sampler slot 1 ----------
const page1 = await browser.newPage()
const errors1 = []
page1.on('pageerror', (e) => errors1.push(String(e)))
await page1.addInitScript(harness())
await page1.goto(URL, { waitUntil: 'domcontentloaded' })
await page1.waitForTimeout(1500)

await page1.getByRole('button', { name: 'Pad mode: Smpl', exact: true }).first().click()
await page1.waitForTimeout(200)

await page1.evaluate(() => {
  const pads = Array.from(document.querySelectorAll('button[aria-label^="Sampler slot"]'))
  const pad1 = pads[0]
  if (!pad1) throw new Error('sampler pad 1 not found')
  // scanLibrary assigns `id = ${prefix}${name}` — at scan root that's just
  // the filename (`platform/source-fsaccess/library.ts`).
  const dt = new DataTransfer()
  dt.setData('application/x-soundgrid-track', 'ZZ Sample To Load.wav')
  pad1.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }))
  pad1.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }))
})
await page1.waitForTimeout(600)

const pad1AfterDrop = await page1.locator('button[aria-label^="Sampler slot 1:"]').count()
ok('setup: pad 1 shows as loaded right after the drag-drop', pad1AfterDrop > 0)

// Debounced persistSamplerBank is 400ms.
await page1.waitForTimeout(800)
const savedIdb = await page1.evaluate(() => ({
  libraryDir: undefined, // not serializable / not needed for phase 2 — re-seeded fresh
  samplerBank: window.__idbMem.get('deckmix:sampler:bank'),
}))
ok('setup: a sampler bank was actually saved to (fake) IndexedDB', !!savedIdb.samplerBank, JSON.stringify(savedIdb.samplerBank))
await page1.close()
ok('phase 1: no page errors', errors1.length === 0, errors1[0])

// ---------- Phase 2: fresh page/context, pre-seeded with phase 1's saved bank ----------
// This is the actual reproduction: does the REAL unattended boot flow
// (Library.tsx's auto-restore effect, StrictMode double-invoke and all)
// bring the pad back, and how long does it actually take against a
// realistic 40-track library where the saved track is near the end?
const page2 = await browser.newPage()
const errors2 = []
page2.on('pageerror', (e) => errors2.push(String(e)))
await page2.addInitScript(harness({ 'deckmix:sampler:bank': savedIdb.samplerBank }))
const t0 = Date.now()
await page2.goto(URL, { waitUntil: 'domcontentloaded' })
// A fresh page defaults deck A's pad grid to Hot Cue mode — switch to
// Sampler so the pad (and its aria-label) actually renders. `padMode` is
// per-render UI state, not persisted, so this is unrelated to what's being
// tested (whether the *slot* resolves), same as a real DJ clicking Smpl
// after a reload before checking their pads.
await page2.getByRole('button', { name: 'Pad mode: Smpl', exact: true }).first().click()

// Poll the STORE directly (not the DOM) so a React re-render lag can't be
// confused with the actual resolution delay — what Shalom experiences is
// "how long until I can trust the pad again," and this isolates whether
// that's a resolution-speed problem or a rendering problem.
let resolvedAtMs = null
for (let elapsed = 0; elapsed <= 25000; elapsed += 1000) {
  const trackId = await page2.evaluate(async () => {
    const { useStore } = await import('/src/app/state/store.ts')
    return useStore.getState().sampler.slots[0].trackId
  })
  if (trackId != null) { resolvedAtMs = Date.now() - t0; break }
  await page2.waitForTimeout(1000)
}

ok('phase 2: pad 1 resolves within 25s of a cold boot', resolvedAtMs != null, resolvedAtMs != null ? `${resolvedAtMs}ms` : 'never resolved')
if (resolvedAtMs != null) {
  console.log(`    (resolved at ${resolvedAtMs}ms — real-world wait for a 40-track library, dragged track near the end of scan order)`)
  await page2.waitForTimeout(1000)
  const domCount = await page2.locator('button[aria-label^="Sampler slot 1:"]').count()
  ok('DOM re-rendered to match the resolved store state', domCount > 0)
} else {
  const debug = await page2.evaluate(async () => {
    const { useStore } = await import('/src/app/state/store.ts')
    const s = useStore.getState()
    return { libraryTracksLen: s.library.tracks.length, libraryBoot: s.library.boot, slot0: s.sampler.slots[0] }
  })
  console.log('DEBUG STATE:', JSON.stringify(debug, null, 2))
}
ok('phase 2: no page errors', errors2.length === 0, errors2[0])

await browser.close()
const passed = results.filter((x) => x.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
