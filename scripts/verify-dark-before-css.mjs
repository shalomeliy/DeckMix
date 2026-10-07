// v0.9.60: what colour the window shows before the stylesheet arrives. Run `npx vite build && npx vite preview --port 5173`,
// then `node scripts/verify-dark-before-css.mjs`. Blocking the CSS stands in for the moment before it loads.
import { chromium } from 'playwright'

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch())
const page = await browser.newPage()
await page.route('**/*.css', (r) => r.abort())
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
const before = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)
await page.unroute('**/*.css')
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.reload({ waitUntil: 'networkidle' })
const head = await page.evaluate(() => ({
  description: document.querySelector('meta[name=description]')?.content,
  themeColor: document.querySelector('meta[name=theme-color]')?.content,
  siteVerification: !!document.querySelector('meta[name=google-site-verification]'),
  appMounted: document.getElementById('root').children.length > 0,
}))
console.log({ htmlBackgroundWithoutCss: before, ...head, consoleErrors: errors })
await browser.close()
