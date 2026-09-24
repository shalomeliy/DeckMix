/**
 * Preloaded by `scripts/regression.mjs` (via `node --import`) into every
 * verify script it runs, when the browser under test is Comet.
 *
 * Why: Comet, launched by Playwright into a fresh profile, re-navigates the
 * *first* page it opens about a second after load (measured 2026-09-24:
 * `framenavigated` fires a second time on page 1, never on pages 2 and 3;
 * Playwright's bundled Chromium never does it). Any script whose first action
 * is `page.evaluate` right after `goto` then dies with "Execution context was
 * destroyed" — a failure of the browser's first-run behaviour, not of the app.
 * Opening and closing one throwaway page per browser absorbs it. Scoped to
 * the regression run so the scripts themselves stay as they were written.
 */
import { chromium } from 'playwright'

const launch = chromium.launch.bind(chromium)
chromium.launch = async (...args) => {
  const browser = await launch(...args)
  const warm = await browser.newPage()
  // Wait for the re-navigation itself (up to 6 s), not a fixed 2.5 s: under
  // the load of a full suite it arrived later than that, and
  // verify-record-master-save.mjs died mid-recording (2026-09-24).
  let navs = 0
  const renavigated = new Promise((resolve) =>
    warm.on('framenavigated', (f) => {
      if (f === warm.mainFrame() && ++navs >= 2) resolve()
    }),
  )
  await warm.goto('http://localhost:5173/').catch(() => {})
  await Promise.race([renavigated, warm.waitForTimeout(6000)])
  await warm.waitForTimeout(300)
  await warm.close()
  return browser
}
