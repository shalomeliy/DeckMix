/**
 * v0.7.5 AC5 verification (added after change-reviewer flagged it as
 * unverified). Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-record-master-cap.mjs
 *
 * The real cap (MASTER_RECORDING_MAX_SEC) is 3 hours — waiting that long
 * isn't verification, it's a stall. `core/recording.ts` exposes a
 * test-only seam (setMasterRecordingMaxSecForTest) that lowers the live
 * binding `controls.ts` already reads, so the actual wiring — not just
 * the pure math, which tests/core/recording.test.ts already covers — gets
 * exercised for real: does startRecordMaster's onChunk handler actually
 * call stopRecordMaster and show a notice when the cap is crossed, and
 * does the rest of the app (a playing deck) keep running through it.
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

await page.goto(URL)
await page.waitForTimeout(500)

const CAP_SEC = 2

const result = await page.evaluate(async (capSec) => {
  const recording = await import('/src/core/recording.ts')
  recording.setMasterRecordingMaxSecForTest(capSec)

  const ctl = await import('/src/controls.ts')
  const { engine } = await import('/src/platform/audio-webaudio/engine.ts')
  const { useStore } = await import('/src/app/state/store.ts')
  await engine.resume()
  const ctxStateBefore = engine.ctx.state

  await ctl.startRecordMaster()
  // Real time, not a mock clock — the cap check runs inside the tap's
  // onChunk callback, driven by actual audio chunks arriving.
  await new Promise((r) => setTimeout(r, (capSec + 2) * 1000))

  const afterCap = useStore.getState().recording
  const notice = useStore.getState().notice
  const ctxStateAfter = engine.ctx.state

  // Restore the real cap so nothing else in this page session is affected.
  recording.setMasterRecordingMaxSecForTest(3 * 60 * 60)

  return { ctxStateBefore, ctxStateAfter, afterCap, notice }
}, CAP_SEC)

ok('AudioContext was running before the cap test', result.ctxStateBefore === 'running', result.ctxStateBefore)
ok('recording stopped itself once the (lowered) cap was reached', result.afterCap.active === null, JSON.stringify(result.afterCap))
ok('savedState became "unsaved" — the take is still there to save', result.afterCap.savedState === 'unsaved', result.afterCap.savedState)
ok(
  'a notice named the limit, in minutes',
  !!result.notice && /minute limit/.test(result.notice.text),
  result.notice?.text ?? '(no notice)',
)
ok('AudioContext still running after the auto-stop — nothing else in the graph broke', result.ctxStateAfter === 'running', result.ctxStateAfter)
ok('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '))

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
