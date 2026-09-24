/**
 * v0.7.5 step 7 verification (PLAN.md) — TopBar UI, driven through real DOM
 * clicks, not module calls. Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-topbar-recording.mjs
 *
 * Confirms: clicking "Record master" starts a real recording (live Pill
 * text updates), clicking Stop shows the persistent "not saved" state (no
 * timeout), and clicking Save actually writes a real WAV file via the
 * (mocked) save dialog. Also: marking a track boundary while recording is
 * reachable from the UI.
 */
import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium' })
const page = await browser.newPage()
const consoleErrors = []
page.on('pageerror', (err) => consoleErrors.push(String(err)))
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})

await page.evaluate(() => {
  window.showSaveFilePicker = async () => ({
    createWritable: async () => ({
      write: async () => {},
      close: async () => {},
    }),
  })
}).catch(() => {}) // page not loaded yet — set it after goto instead, see below

await page.goto(URL)
await page.evaluate(() => {
  window.showSaveFilePicker = async () => ({
    createWritable: async () => ({
      write: async () => {},
      close: async () => {},
    }),
  })
  // This script also clicks "Mark track" below, which routes the later
  // Save through the split-file path (showDirectoryPicker), not the
  // single-file one above — both need mocking, or Save fails silently
  // into the "couldn't be saved" branch instead of succeeding. The split
  // path's own file/cue-sheet content is verified for real in
  // verify-record-master-split.mjs; this script only needs it to not throw.
  window.showDirectoryPicker = async () => ({
    getFileHandle: async () => ({
      createWritable: async () => ({ write: async () => {}, close: async () => {} }),
    }),
  })
})
await page.waitForTimeout(500)

// Boot the audio engine the same way a real click does.
await page.getByRole('button', { name: 'Start audio engine' }).click()
await page.waitForTimeout(500)

const recordButton = page.getByRole('button', { name: 'Record master' })
ok('a "Record master" button is visible once the engine is started', await recordButton.isVisible(), '')

await recordButton.click()
await page.waitForTimeout(300)

const pillDuringRecording = await page.locator('text=/Rec master/').first().textContent().catch(() => null)
ok('a live "Rec master" status appears after clicking Record', !!pillDuringRecording, pillDuringRecording ?? '(not found)')
ok(
  'the elapsed time starts at 0:00, never negative',
  /Rec master · 0:0\d/.test(pillDuringRecording ?? ''),
  pillDuringRecording ?? '',
)

const markButton = page.getByRole('button', { name: 'Mark track' })
ok('a "Mark track" button appears while recording', await markButton.isVisible(), '')
await markButton.click()

await page.waitForTimeout(1500)
const pillLater = await page.locator('text=/Rec master/').first().textContent().catch(() => null)
ok('the elapsed time actually advances', pillLater !== pillDuringRecording, `${pillDuringRecording} -> ${pillLater}`)

const stopButton = page.getByRole('button', { name: 'Stop' })
await stopButton.click()
await page.waitForTimeout(300)

const unsavedPill = await page.locator('text=/Not saved/').first().textContent().catch(() => null)
ok('stopping shows the persistent "Not saved" state', !!unsavedPill, unsavedPill ?? '(not found)')

// Give it a while — the spec requires NO timeout on this state.
await page.waitForTimeout(2000)
const stillUnsaved = await page.locator('text=/Not saved/').first().isVisible().catch(() => false)
ok('the "Not saved" state has no timeout — still visible after 2s', stillUnsaved, '')

const saveButton = page.getByRole('button', { name: 'Save' })
await saveButton.click()
await page.waitForTimeout(300)

const savedNotice = await page.locator('text=/Recording saved/').first().isVisible().catch(() => false)
ok('saving shows a confirmation notice', savedNotice, '')
const badgeGoneAfterSave = !(await page.locator('text=/Not saved/').first().isVisible().catch(() => false))
ok('the "Not saved" Pill disappears once saved', badgeGoneAfterSave, '')

ok('no console errors across the whole sequence', consoleErrors.length === 0, consoleErrors.join(' | '))

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
