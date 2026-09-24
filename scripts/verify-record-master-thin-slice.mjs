/**
 * v0.7.5 step 4 verification (PLAN.md). Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-record-master-thin-slice.mjs
 *
 * The thin end-to-end slice from the plan: record 5 real seconds from the
 * master bus with `startRecordMaster`/`stopRecordMaster` — no UI, no save —
 * and check the collected frame count against a hand computation.
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
const consoleLines = []
page.on('console', (msg) => consoleLines.push(msg.text()))
const consoleErrors = []
page.on('pageerror', (err) => consoleErrors.push(String(err)))

await page.goto(URL)
await page.waitForTimeout(500)

const RECORD_SEC = 5
const result = await page.evaluate(async (recordSec) => {
  const ctl = await import('/src/controls.ts')
  const { engine } = await import('/src/platform/audio-webaudio/engine.ts')
  await engine.resume()
  const sr = engine.ctx.sampleRate
  await ctl.startRecordMaster()
  await new Promise((r) => setTimeout(r, recordSec * 1000))
  await ctl.stopRecordMaster()
  return { sampleRate: sr }
}, RECORD_SEC)

const logLine = consoleLines.find((l) => l.startsWith('[recording] stopped'))
ok('recording produced a summary log line', !!logLine, logLine ?? '(none)')

const match = logLine?.match(/(\d+) frames @ (\d+)Hz \(([\d.]+)s\)/)
ok('log line parses', !!match, logLine ?? '')

if (match) {
  const frames = Number(match[1])
  const loggedSampleRate = Number(match[2])
  const loggedSeconds = Number(match[3])
  ok('sample rate matches the context', loggedSampleRate === result.sampleRate, `${loggedSampleRate} vs ${result.sampleRate}`)
  const expectedFrames = result.sampleRate * RECORD_SEC
  const withinTolerance = Math.abs(frames - expectedFrames) / expectedFrames < 0.1
  ok(
    `frame count close to ${RECORD_SEC}s at ${result.sampleRate}Hz (±10%)`,
    withinTolerance,
    `got ${frames}, expected ~${expectedFrames}`,
  )
  const withinSecTolerance = Math.abs(loggedSeconds - RECORD_SEC) < 0.5
  ok(`logged duration close to ${RECORD_SEC}s`, withinSecTolerance, `${loggedSeconds}s`)
}

ok('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '))

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
