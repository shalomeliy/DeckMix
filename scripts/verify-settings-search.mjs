// v0.9.55: the Settings search, checked in the running app (headless Chromium).
// Run with the dev server up: node scripts/verify-settings-search.mjs [url]
import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://localhost:5173/'
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? undefined })
const page = await browser.newPage({ viewport: { width: 1536, height: 710 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(url)
await page.getByRole('button', { name: 'Settings', exact: true }).click()
const box = page.getByLabel('Search settings')
const out = {}
out.focusedOnOpen = await box.evaluate((el) => el === document.activeElement)

const results = () =>
  page.evaluate(() => {
    const root = document.querySelector('[data-testid="settings-search-results"]')
    if (!root) return null
    return {
      count: root.querySelector('p')?.textContent,
      sections: [...root.querySelectorAll('section > button')].map((b) => b.textContent),
      marks: [...root.querySelectorAll('mark')].map((m) => m.textContent),
      reasons: [...root.querySelectorAll('div')].map((d) => d.textContent).filter((t) => t?.startsWith('matched:')),
    }
  })

await box.fill('סולם')
out.hebrew = await results()
await box.fill('jog')
out.jog = await results()
await box.fill('zzz')
out.emptyShown = await page.locator('[data-testid="settings-search-empty"]').isVisible()

// Change a setting straight from a result: "Show key as".
await box.fill('show key')
const sel = page.locator('[data-testid="settings-search-results"] select').first()
const before = await sel.inputValue()
await sel.selectOption(before === 'camelot' ? 'musical' : 'camelot')
out.changedFromResult = (await sel.inputValue()) !== before
await sel.selectOption(before) // put it back

// Enter opens the first result in its tab and flashes it.
await box.fill('show key')
await box.press('Enter')
out.afterEnter = await page.evaluate(() => ({
  boxValue: document.querySelector('input[aria-label="Search settings"]').value,
  rowVisible: !!document.getElementById('setting-keyMode'),
  flashed: document.getElementById('setting-keyMode')?.className.includes('ring-2'),
}))

// A one-letter query is taller than the screen: the picked result must stay in view.
await box.fill('a')
for (let i = 0; i < 20; i++) await box.press('ArrowDown')
out.arrowPickVisible = await page.evaluate(() => {
  const id = document.querySelector('input[aria-label="Search settings"]').getAttribute('aria-activedescendant')
  const r = document.getElementById(id)?.getBoundingClientRect()
  return !!r && r.top >= 0 && r.bottom <= window.innerHeight
})

// Esc: first clears, second closes.
await box.fill('jog')
await box.press('Escape')
out.escOnceValue = await box.inputValue()
out.escOnceStillOpen = await box.isVisible()
await page.keyboard.press('Escape')
out.escTwiceClosed = !(await box.isVisible().catch(() => false))

// Ctrl+F focuses the box after reopening and clicking elsewhere.
await page.getByRole('button', { name: 'Settings', exact: true }).click()
await page.getByRole('button', { name: 'Display', exact: true }).click()
await page.keyboard.press('Control+f')
out.ctrlFFocus = await page.getByLabel('Search settings').evaluate((el) => el === document.activeElement)

out.errors = errors
console.log(JSON.stringify(out, null, 2))
await browser.close()
