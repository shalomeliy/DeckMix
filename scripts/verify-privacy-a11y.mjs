/**
 * v0.8.7 browser verification. Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-privacy-a11y.mjs
 *
 * Two things a type-checker cannot confirm: that the new Privacy & Terms tab
 * actually renders when the persistent TopBar line is clicked, and that the
 * Library row keyboard fix (Tab focuses a row, Enter/Space selects it, the
 * focus ring is visually distinct from the "selected" background) works in a
 * real DOM. Contrast is measured with the WCAG relative-luminance formula
 * against the exact rendered colors, not read out of index.css by eye.
 *
 * Result on 2026-09-14, Chromium 1194 (`PW_CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
 * in this container — playwright@1.63.0 defaults to a headless_shell build
 * that is not the one pre-installed here): 19/19.
 *
 * One real bug found running this, not just added tests for one that
 * existed: any element combining `outline-none` (unconditional) with
 * `focus-visible:outline-*` never actually painted a ring. Tailwind v4
 * resolves `outline-2`'s `outline-style` from a shared `--tw-outline-style`
 * custom property, and `outline-none` pins that variable to `none`
 * *unconditionally* — not scoped to a non-focus state — so every element
 * carrying both classes had its focus-visible outline silently overridden by
 * its own resting state. `Button` is NOT affected: its base class list has
 * no `outline-none` at all (verified live — Tab, then getComputedStyle —
 * before trusting that from reading the class list alone; an earlier draft
 * of this comment wrongly named Button too, caught by change-reviewer).
 *
 * First shipped fixing only the row itself, on the theory that `HintIcon`
 * and the other `<select>`s were separate, out-of-scope debt. Shalom found
 * the actual user-facing cost of that half-measure immediately: tabbing off
 * the row and onto its own genre `<select>`/note `<input>`/load buttons —
 * the exact cells this same fix was supposed to make usable — dropped the
 * ring instantly, so the ring appeared to flicker on for one stop out of
 * five and vanish for the rest, which read as "focus is somewhere I can't
 * see" rather than as an accessibility win. Fixed everywhere the same
 * pattern occurs (`Library.tsx`'s search box/genre select/note input,
 * `Settings.tsx`, `TopBar.tsx`, `AiControlBar.tsx`, `HintIcon` in
 * `controls.tsx`) with the same one-line addition,
 * `focus-visible:[--tw-outline-style:solid]`.
 */
import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function syncsafe(n) {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]
}
function u32be(n) {
  return [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}
function textFrame(id, text) {
  const payload = [0x00, ...Buffer.from(text, 'latin1')]
  return [...Buffer.from(id, 'ascii'), ...u32be(payload.length), 0x00, 0x00, ...payload]
}
function buildTaggedMp3Bytes(title, bpm) {
  const frames = [...textFrame('TIT2', title), ...textFrame('TBPM', String(bpm))]
  const header = [...Buffer.from('ID3', 'ascii'), 3, 0, 0, ...syncsafe(frames.length)]
  return [...header, ...frames]
}

// Same harness shape as verify-library-sort-navigation.mjs: fakes the File
// System Access folder picker and idb-keyval so the library has one real row
// to focus, without needing Shalom's actual music folder in this container.
function harness(entries) {
  return `(() => {
  const FILES = ${JSON.stringify(entries)};
  const makeFile = (name, bytes) => ({ kind: 'file', name, getFile: async () => new File([new Uint8Array(bytes)], name) });
  const makeDir = (name) => ({
    kind: 'directory', name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () { for (const f of FILES) yield [f.name, makeFile(f.name, f.bytes)]; },
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

const entries = [
  { name: 'One Track.mp3', bytes: buildTaggedMp3Bytes('One Track', 128) },
  { name: 'Two Track.mp3', bytes: buildTaggedMp3Bytes('Two Track', 130) },
]

/** WCAG 2.x relative-luminance contrast ratio between two computed rgb() strings. */
function contrastRatio(rgbA, rgbB) {
  const toRgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number)
  const luminance = ([r, g, b]) => {
    const chan = (c) => {
      const s = c / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    const [R, G, B] = [chan(r), chan(g), chan(b)]
    return 0.2126 * R + 0.7152 * G + 0.0722 * B
  }
  const [l1, l2] = [luminance(toRgb(rgbA)), luminance(toRgb(rgbB))].sort((a, b) => b - a)
  return (l1 + 0.05) / (l2 + 0.05)
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined })
const page = await browser.newPage({ viewport: VIEWPORT })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.addInitScript(harness(entries))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)

// --- Persistent disclaimer line + Privacy & Terms tab ---
const disclaimer = page.getByRole('button', { name: /Not affiliated with Pioneer DJ/ })
ok('the persistent disclaimer line is visible on the main screen', await disclaimer.isVisible())
await disclaimer.click()
await page.waitForTimeout(150)

const legalHeadings = ['Privacy', 'Terms of use', 'Trademarks', 'Copyright', 'License']
for (const heading of legalHeadings) {
  const visible = await page.getByText(heading, { exact: true }).first().isVisible()
  ok(`Settings → Privacy & Terms shows the "${heading}" section`, visible)
}

const notApplicable = await page.getByText(/Cookies — DeckMix sets none/).isVisible()
ok('cookies/analytics/etc. are named as not applicable, not omitted', notApplicable)

const details = page.locator('details', { hasText: 'open-source packages' })
ok('OSS credits are collapsed by default', (await details.getAttribute('open')) === null)
await details.locator('summary').click()
const noticeRows = await details.locator('li').count()
ok('expanding OSS credits reveals a non-empty package list', noticeRows > 50, `${noticeRows} rows`)

// --- Contrast: the new tab's own text against its surface-1 card background ---
const bg = await page.locator('main, [class*="surface-1"]').first().evaluate(() => {
  const probe = document.querySelector('[class*="bg-surface-1"]')
  return probe ? getComputedStyle(probe).backgroundColor : null
})
const dimText = await page.getByText(/Cookies — DeckMix sets none/).evaluate((el) => getComputedStyle(el).color)
const headingText = await page.getByText('Privacy', { exact: true }).first().evaluate((el) => getComputedStyle(el).color)
if (bg && dimText && headingText) {
  const dimRatio = contrastRatio(dimText, bg)
  const headingRatio = contrastRatio(headingText, bg)
  ok(`body text contrast ≥ 4.5:1 (measured ${dimRatio.toFixed(2)}:1)`, dimRatio >= 4.5, `${dimText} on ${bg}`)
  ok(`heading text contrast ≥ 4.5:1 (measured ${headingRatio.toFixed(2)}:1)`, headingRatio >= 4.5, `${headingText} on ${bg}`)
} else {
  ok('contrast measurement collected both colors', false, `bg=${bg} dim=${dimText} heading=${headingText}`)
}

await page.getByRole('button', { name: 'Close' }).click()
await page.waitForTimeout(150)

// --- Library row keyboard access ---
await page.locator('tbody tr').first().focus()
const focusedIsRow = await page.evaluate(() => document.activeElement?.tagName === 'TR')
ok('a library row can receive keyboard focus (tabIndex fix)', focusedIsRow)

await page.locator('input[placeholder]').first().click().catch(() => {}) // mouse modality first
const ariaBefore = await page.locator('tbody tr').first().getAttribute('aria-selected')

// :focus-visible needs a REAL keyboard Tab, not el.focus() — Chromium does not
// treat a programmatic focus as keyboard-navigated, so el.focus() always
// reports outlineStyle "none" here regardless of the CSS. Tabbing for real
// until a <tr> is reached is what actually exercises the focus-visible rule.
let reachedRow = false
for (let i = 0; i < 40 && !reachedRow; i++) {
  await page.keyboard.press('Tab')
  reachedRow = await page.evaluate(() => document.activeElement?.tagName === 'TR')
}
ok('Tab reaches a library row within 40 stops', reachedRow)

const outlineOnFocus = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle)
ok('the focus ring is a real outline while keyboard-focused, not "none"', outlineOnFocus !== 'none', `outlineStyle=${outlineOnFocus}`)

await page.keyboard.press('Enter')
await page.waitForTimeout(100)
const ariaAfterEnter = await page.locator('tbody tr').first().getAttribute('aria-selected')
ok('Enter on a focused row selects it (aria-selected flips to true)', ariaBefore !== 'true' ? ariaAfterEnter === 'true' : true, `before=${ariaBefore} after=${ariaAfterEnter}`)

// Selected uses a background tint (bg-accent/15); focus uses an outline ring
// — two different visual treatments, so a row that is both at once (exactly
// what Enter just produced) never reads as a single merged state.
const combined = await page.locator('tbody tr').first().evaluate((el) => ({
  ariaSelected: el.getAttribute('aria-selected'),
  background: getComputedStyle(el).backgroundColor,
  outlineStyle: getComputedStyle(el).outlineStyle,
  outlineColor: getComputedStyle(el).outlineColor,
  outlineWidth: getComputedStyle(el).outlineWidth,
}))
ok(
  'selected + keyboard-focused shows a tinted background AND a separate outline ring',
  combined.ariaSelected === 'true' && combined.outlineStyle === 'solid' && combined.outlineWidth === '2px',
  JSON.stringify(combined),
)

// Regression check (found by Shalom, 14/09): tabbing off the row and INTO
// its own cells — genre <select>, note <input>, the two load buttons — must
// never drop to an invisible focus. Before the fix below, each of those
// cells combined an unconditional `outline-none` with `focus-visible:outline-*`,
// so the ring vanished the instant focus left the <tr> even though the same
// Tab press kept moving; the user only ever saw the ring on the row itself,
// one stop in five, and lost track of focus everywhere else.
const cellStops = []
for (let i = 0; i < 4; i++) {
  await page.keyboard.press('Tab')
  cellStops.push(
    await page.evaluate(() => {
      const el = document.activeElement
      return { tag: el?.tagName, type: el?.type, outlineStyle: getComputedStyle(el).outlineStyle }
    }),
  )
}
const invisible = cellStops.filter((s) => s.outlineStyle === 'none')
ok(
  'every cell inside the row (genre select, note input, load A/B) keeps a visible focus ring',
  invisible.length === 0,
  JSON.stringify(cellStops),
)

// One more Tab should land on the NEXT row and light up the same way.
await page.keyboard.press('Tab')
const nextRowVisible = await page.evaluate(() => {
  const el = document.activeElement
  return el?.tagName === 'TR' && getComputedStyle(el).outlineStyle === 'solid'
})
ok('tabbing on from the last cell reaches the next row, ring visible again', nextRowVisible)

ok('no page error at any point', errors.length === 0, errors.join('; '))

await page.close()
await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
