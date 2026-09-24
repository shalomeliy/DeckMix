/**
 * v0.2.5 browser verification. Run against `npm run dev` on :5173:
 *
 *   npm i -D playwright && node scripts/verify-settings.mjs
 *
 * Kept in the repo for the reason the v0.1.7 measurement script was: the
 * Settings screen has no automated test and cannot get one — jsdom has no
 * layout, so "fits 1536x710" and "the warning banner names the bad key" are
 * only answerable in a real browser. This is that answer, re-runnable.
 * Result on 2026-08-30, Chromium 1194: 17/17.
 *
 * Checks the four things a type-checker cannot: the screen fits the owner's
 * 1536x710 viewport, a changed value survives a reload, the pre-schema
 * localStorage key is migrated once, and a corrupt stored value is REPORTED
 * rather than silently replaced.
 */
import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// idb-keyval's defaults, so the test can plant a store the app will read.
const seedIdb = (value) =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open('keyval-store', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('keyval')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction('keyval', 'readwrite')
      tx.objectStore('keyval').put(value, 'deckmix:settings')
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => reject(tx.error)
    }
  })

// Playwright's own download on a normal machine; PW_CHROME lets a sandbox
// point at a pre-installed binary.
const browser = await chromium.launch(
  process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {},
)

async function newPage(ctx) {
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  page.errors = errors
  return page
}

const openSettings = async (page) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('heading', { name: 'Settings' }).waitFor()
}

// ── 1. boots clean, and the screen fits the owner's viewport ────────────────
{
  const ctx = await browser.newContext({ viewport: VIEWPORT })
  const page = await newPage(ctx)
  await page.goto(URL, { waitUntil: 'networkidle' })
  await openSettings(page)

  const box = await page.evaluate(() => {
    const panel = document.querySelector('.z-40')
    const r = panel.getBoundingClientRect()
    const scroller = panel.querySelector('.overflow-y-auto')
    return {
      panelH: Math.round(r.height),
      panelW: Math.round(r.width),
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
      scrollerH: Math.round(scroller.getBoundingClientRect().height),
      scrollerOverflowX: scroller.scrollWidth > scroller.clientWidth,
    }
  })
  ok('panel fits the 1536x710 viewport', box.panelH <= VIEWPORT.height && box.panelW <= VIEWPORT.width,
     `${box.panelW}x${box.panelH}`)
  ok('page does not scroll sideways', box.docScrollW <= box.docClientW,
     `${box.docScrollW} <= ${box.docClientW}`)
  ok('field list has real height to scroll in', box.scrollerH > 300, `${box.scrollerH}px`)
  ok('no horizontal overflow inside the field list', !box.scrollerOverflowX)

  const groups = await page.locator('nav button').allInnerTexts()
  // System (v0.2.5's own capabilities group) joined the original five —
  // Controller/Feel/Display/Library/Help — later; six is current, not a bug.
  ok('all six groups present', groups.length === 6, groups.join(' / '))

  // Every group renders without throwing, and the calibration constants are
  // nowhere among the labels. Scoped to the settings panel (`.z-40`) — the
  // crate rail (v0.8.1) also carries `.overflow-y-auto`, so the unscoped
  // locator started matching two elements and throwing strict-mode errors.
  const fieldList = page.locator('.z-40 .overflow-y-auto')
  const labels = []
  for (const g of groups) {
    await page.getByRole('button', { name: g, exact: true }).click()
    labels.push(...(await fieldList.innerText()).split('\n'))
  }
  const banned = ['PLATTER_SIZE', 'POSITION_EPSILON', 'DECLICK', 'ANCHOR_EVERY', 'STANDSTILL']
  const leaked = banned.filter((b) => labels.some((l) => l.includes(b)))
  ok('no calibration constant on screen', leaked.length === 0, leaked.join(', ') || 'none')

  ok('no console errors on boot', page.errors.length === 0, page.errors.slice(0, 2).join(' | '))
  await ctx.close()
}

// ── 2. a changed value survives a reload ───────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: VIEWPORT })
  const page = await newPage(ctx)
  await page.goto(URL, { waitUntil: 'networkidle' })
  await openSettings(page)

  const slider = page.locator('input[type=range]').nth(1) // Jog bend strength
  await slider.fill('0.27')
  await page.waitForTimeout(250)

  await page.reload({ waitUntil: 'networkidle' })
  await openSettings(page)
  const after = await page.locator('input[type=range]').nth(1).inputValue()
  ok('bend strength survives a reload', after === '0.27', `stored ${after}`)

  // And Reset puts it back, so a value the user broke is reversible.
  await page.locator('div', { hasText: 'Jog bend strength' })
  await page.getByRole('button', { name: 'Reset' }).nth(1).click()
  await page.waitForTimeout(200)
  const reset = await page.locator('input[type=range]').nth(1).inputValue()
  ok('Reset restores the built-in default', reset === '0.1', `now ${reset}`)
  await ctx.close()
}

// ── 3. the pre-schema localStorage key is migrated, once, and reported ──────
{
  const ctx = await browser.newContext({ viewport: VIEWPORT })
  const page = await newPage(ctx)
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.evaluate(() => localStorage.setItem('deckmix:keyMode', 'camelot'))
  await page.reload({ waitUntil: 'networkidle' })
  await openSettings(page)

  const banner = await page.locator('.bg-warn\\/10').first().innerText().catch(() => '')
  ok('migration is reported on screen', banner.includes('keyMode'), banner.replace(/\n/g, ' ').slice(0, 80))

  await page.getByRole('button', { name: 'Library', exact: true }).click()
  const keyModeValue = await page.locator('select').last().inputValue()
  ok('the old key mode was carried over', keyModeValue === 'camelot', keyModeValue)

  // Changing it here must beat the stale localStorage entry on the next boot —
  // otherwise the setting looks like it does not save.
  await page.locator('select').last().selectOption('musical')
  await page.waitForTimeout(250)
  await page.reload({ waitUntil: 'networkidle' })
  await openSettings(page)
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  const afterReload = await page.locator('select').last().inputValue()
  ok('the new value beats the stale legacy key', afterReload === 'musical', afterReload)
  await ctx.close()
}

// ── 4. a corrupt stored value is named, not silently replaced ──────────────
{
  const ctx = await browser.newContext({ viewport: VIEWPORT })
  const page = await newPage(ctx)
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.evaluate(seedIdb, { version: 1, bendPerTick: 900, platterSize: 54, eqDb: 'loud' })
  await page.reload({ waitUntil: 'networkidle' })
  await openSettings(page)

  const report = await page.locator('.bg-warn\\/10').first().innerText().catch(() => '')
  ok('out-of-range value is named', report.includes('bendPerTick') && report.includes('900'),
     report.replace(/\n/g, ' ').slice(0, 100))
  ok('removed key is named, not dropped in silence', report.includes('platterSize'))
  ok('wrong type is named', report.includes('eqDb'))

  const clamped = await page.locator('input[type=range]').nth(1).inputValue()
  ok('the out-of-range value was clamped, not defaulted', clamped === '0.5', clamped)
  ok('still no console errors with a corrupt store', page.errors.length === 0,
     page.errors.slice(0, 2).join(' | '))
  await ctx.close()
}

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
