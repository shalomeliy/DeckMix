/**
 * v0.9.62 verification, against the built app on :5173 (PW_CHROME=<chromium> if needed):
 *   node scripts/verify-press-flash.mjs
 * Loads a song to each deck through the real buttons, presses Sync, and checks that `.press-flash` appears on the right element for about
 * 150 ms and goes away. Watched with a MutationObserver (a screenshot cannot catch 150 ms). Also counts how often the flash class changes
 * while the platter spins, which must be zero: nothing that streams may flash.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright'

const dir = path.join(os.tmpdir(), 'deckmix-speed-synth')
if (!fs.existsSync(dir)) throw new Error('run scripts/measure-speed.mjs once first: it creates the synthetic songs')
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).slice(0, 4)
const server = http.createServer((req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); fs.createReadStream(path.join(dir, files[Number(req.url.slice(1))])).pipe(res) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const harness = `(() => {
  const NAMES = ${JSON.stringify(files)};
  const makeFile = (n, i) => ({ kind: 'file', name: n, getFile: async () => new File([await (await fetch('http://127.0.0.1:${port}/' + i)).blob()], n) });
  const makeDir = (n) => ({ kind: 'directory', name: n, queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    entries: async function* () { for (let i = 0; i < NAMES.length; i++) yield [NAMES[i], makeFile(NAMES[i], i)]; } });
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => makeDir('Tracks') });
  const mem = new Map([['deckmix:libraryDir', makeDir('Tracks')]]);
  const fire = (o, p, v) => setTimeout(() => { o.result = v; o[p] && o[p](); }, 0);
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: { open() { const req = {}; setTimeout(() => {
    req.result = { transaction: () => { const tx = {}; tx.objectStore = () => ({ transaction: tx,
      get: (k) => { const r = {}; fire(r, 'onsuccess', mem.get(k)); return r; },
      put: (v, k) => { mem.set(k, v); const r = {}; fire(r, 'onsuccess', undefined); return r; } });
      setTimeout(() => tx.oncomplete && tx.oncomplete(), 1); return tx; } };
    req.onsuccess && req.onsuccess(); }, 0); return req; } } });
  window.__flashLog = [];
  new MutationObserver((muts) => { for (const m of muts) { const el = m.target; const was = (m.oldValue || '').includes('press-flash'); const is = el.classList.contains('press-flash');
    if (was !== is) window.__flashLog.push({ t: performance.now(), on: is, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 12) }); } })
    .observe(document, { attributes: true, attributeFilter: ['class'], attributeOldValue: true, subtree: true });
})()`
const results = []
const ok = (n, p, d) => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'], executablePath: process.env.PW_CHROME || undefined })
try {
  const page = await browser.newPage({ viewport: { width: 1536, height: 710 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(harness)
  await page.goto('http://localhost:5173/')
  await page.waitForSelector('button[aria-label="Load to deck A"]')
  const take = async () => { const l = await page.evaluate(() => window.__flashLog.splice(0)); return l }
  await take()
  await page.locator('button[aria-label="Load to deck A"]').nth(0).click()
  await page.waitForSelector('[aria-label="Loaded on deck A"]')
  await page.waitForTimeout(900)
  let log = await take()
  const on = log.find((e) => e.on && e.tag === 'SECTION'), off = log.find((e) => !e.on && e.tag === 'SECTION')
  ok('loading a song flashes a deck panel', !!on)
  ok('and it goes away after about 450 ms', !!on && !!off && off.t - on.t >= 400 && off.t - on.t < 800, on && off ? `${Math.round(off.t - on.t)} ms` : 'no off')
  await page.getByRole('button', { name: 'Sync', exact: true }).first().click()
  await page.waitForTimeout(900)
  log = await take()
  ok('Sync flashes the Sync button', log.some((e) => e.on && e.tag === 'BUTTON' && /sync/i.test(e.text)), JSON.stringify(log.map((e) => [e.tag, e.on, e.text])))
  await page.getByRole('button', { name: 'Play', exact: true }).first().click()
  await take()
  await page.waitForTimeout(2500)
  log = await take()
  ok('nothing flashes while a deck simply plays (no per-frame flashing)', log.length === 0, `${log.length} changes`)
  // two keys inside one window (the review's stuck-class case): Sync then a load on the other deck, 30 ms apart
  await page.getByRole('button', { name: 'Pause', exact: true }).first().click()
  await take()
  await page.getByRole('button', { name: 'Sync', exact: true }).first().click()
  await page.waitForTimeout(30)
  await page.locator('button[aria-label="Load to deck B"]').nth(1).click()
  await page.waitForSelector('[aria-label="Loaded on deck B"]')
  await page.waitForTimeout(900)
  ok('after two different flashes overlap, no element is left flashing', (await page.locator('.press-flash').count()) === 0)
  await take()
  await page.getByRole('button', { name: 'Sync', exact: true }).first().click()
  await page.waitForTimeout(900)
  ok('and the next Sync press flashes again', (await take()).some((e) => e.on && e.tag === 'BUTTON'))
  // browse selection stays in view (v0.9.62): arrow keys use the same moveSelection as the controller's wheel
  const inView = () => page.evaluate(() => {
    const row = document.querySelector('tr[aria-selected="true"]')
    if (!row) return { found: false }
    const box = row.closest('div[class*="overflow"]') ?? row.parentElement
    const r = row.getBoundingClientRect(), b = box.getBoundingClientRect()
    const head = document.querySelector('thead')?.getBoundingClientRect().height ?? 0
    return { found: true, ok: r.top >= b.top + head - 1 && r.bottom <= b.bottom + 1, row: [Math.round(r.top), Math.round(r.bottom)], box: [Math.round(b.top), Math.round(b.bottom)], head: Math.round(head), scrollTop: box.scrollTop, cls: String(box.className).slice(0, 40) }
  })
  await page.locator('tbody tr[aria-selected]').first().click()
  let allIn = true, steps = 0
  for (let i = 0; i < 10; i++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(60); const v = await inView(); steps++; if (!v.found || !v.ok) { allIn = false; console.log('  step', i, JSON.stringify(v)) } }
  ok('after each of 10 ArrowDown presses the selected row is fully visible', allIn)
  ok('no page errors', errors.length === 0, errors[0])
} finally { await browser.close(); server.close() }
process.exit(results.every(Boolean) ? 0 : 1)
