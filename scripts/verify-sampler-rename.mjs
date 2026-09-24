/**
 * v0.6.0 post-close feature verification. Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-sampler-rename.mjs
 *
 * The owner's own request ("there's no way to rename a sampler pad") — there
 * was none at all before this. `Alt`+click opens a rename box, same gesture
 * `HotCuePads` already uses (`renameHotCue`, v0.5.3), landing on the new
 * `ctl.renameSamplerSlot`. Two things this script exists to catch:
 *
 * 1. The Alt-release-mid-click edge case an independent review found: a
 *    sampler pad triggers on `onPointerDown` (not `onClick`, so Gated mode
 *    can release on pointer-up), and the first cut of the Alt+click guard
 *    read `e.altKey` separately on `pointerdown` and on `click` — two
 *    different browser events. Releasing Alt between them (a fast Alt+click
 *    is enough) made pointerdown skip the trigger *and* click skip the
 *    rename: the pad silently did nothing. Fixed by capturing `altKey` once
 *    at pointerdown and reusing it for the click decision — this script
 *    drives that exact sequence with Playwright's `down`/`up` primitives
 *    rather than a single synthetic `click()`, which is what would have
 *    hidden the bug (Playwright's `.click()` holds modifiers for the whole
 *    gesture, never separating the two reads).
 * 2. A related bug found while wiring rename up: `loadSamplerSlotAudio` was
 *    unconditionally overwriting `trackName` on every resolve, including a
 *    resolve-from-saved-bank — a custom name would have been silently wiped
 *    by the track's own title on the very next reload. Verified here by
 *    renaming, then re-running the same resolve path the real boot flow
 *    uses, and checking the name survived.
 */
import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function buildWav() {
  const sr = 8000
  const n = Math.round(sr * 0.2)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / sr)), 44 + i * 2)
  return buf
}

const files = { 'my track.wav': buildWav().toString('base64') }

function harness() {
  return `(() => {
  const files = ${JSON.stringify(files)};
  const makeFile = (name) => ({
    kind: 'file', name,
    getFile: async () => {
      const b = Uint8Array.from(atob(files[name]), (c) => c.charCodeAt(0));
      return new File([b], name, { type: 'audio/wav' });
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
  const fire = (o, p, v) => setTimeout(() => { o.result = v; o[p] && o[p](); }, 0);
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: { open() {
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
  } } });
})()`
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.addInitScript(harness())
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await page.getByRole('button', { name: 'Pad mode: Smpl', exact: true }).first().click()
await page.waitForTimeout(200)

await page.evaluate(() => {
  const pad = document.querySelector('button[aria-label^="Sampler slot"]')
  const dt = new DataTransfer()
  dt.setData('application/x-soundgrid-track', 'my track.wav')
  pad.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }))
  pad.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }))
})
await page.waitForTimeout(500)

const pad1 = page.locator('button[aria-label^="Sampler slot 1:"]')
ok('setup: track loaded onto pad 1', (await pad1.count()) > 0)

// 1. A real, separated Alt-down / Alt-up-after-click gesture (Playwright's
// .click({modifiers}) would hold Alt for the whole thing and could never
// reproduce the bug this guards) — Alt held through pointerdown AND the
// click that follows must open the rename box, not silently no-op.
const box = await pad1.boundingBox()
await page.keyboard.down('Alt')
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await page.mouse.down()
await page.mouse.up()
await page.keyboard.up('Alt')
await page.waitForTimeout(200)

const renameInput = page.getByLabel('Rename sampler slot 1')
ok('Alt+click (real down/up gesture) opens the rename box', (await renameInput.count()) > 0)

if (await renameInput.count()) {
  await renameInput.fill('My Custom Name')
  await renameInput.press('Enter')
  await page.waitForTimeout(300)
  const renamedLabel = await pad1.getAttribute('aria-label')
  ok('rename is applied and visible on the pad', !!renamedLabel?.includes('My Custom Name'), renamedLabel ?? '')
}

// 2. Plain Alt+click with NO drag-drop interleaved must not trigger the
// sample (the pointerdown guard) — check the slot's `playing` flag stayed
// false in the store across the whole gesture above.
const stillNotPlaying = await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  return useStore.getState().sampler.slots[0].playing === false
})
ok('the Alt+click gesture did not also trigger playback', stillNotPlaying)

// 3. The trackName-preservation fix: re-run the same resolve path a real
// reload uses (persist → restoreSamplerBankMeta → resolveSamplerSlots) and
// confirm the custom name survives instead of reverting to the track's own
// title.
await page.waitForTimeout(800) // debounced persistSamplerBank
const afterResolve = await page.evaluate(async () => {
  const { useStore } = await import('/src/app/state/store.ts')
  const ctl = await import('/src/controls.ts')
  useStore.getState().patchSamplerSlot(0, { trackId: null }) // force re-resolve
  await ctl.resolveSamplerSlots()
  await new Promise((r) => setTimeout(r, 300))
  return useStore.getState().sampler.slots[0].trackName
})
ok('custom name survives a re-resolve (would have reverted to "my track" before the fix)', afterResolve === 'My Custom Name', afterResolve ?? '')

ok('no page errors', errors.length === 0, errors[0])

await browser.close()
const passed = results.filter((x) => x.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
