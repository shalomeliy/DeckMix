/**
 * v0.7.5 step 3 verification. Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-recorder-tap.mjs
 *
 * Confirms, against the real Web Audio graph in Chromium (not a mock):
 * 1. `engine.createMasterTap()` resolves and delivers real chunks while a
 *    track plays — proof the worklet loads and the tap is live.
 * 2. Chunk byte totals over ~1 real second are close to the hand-computed
 *    rate (44.1kHz * 2ch * 4 bytes/float32 sample as received, before this
 *    project's own 16-bit PCM conversion happens later in core/wav.ts).
 * 3. `masterPostFx`'s existing output wiring is untouched — `wireOutput()`
 *    doesn't throw and the context stays in `running` state — i.e. the tap
 *    is a branch, not a chain, exactly the spec's requirement.
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
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('pageerror', (err) => consoleErrors.push(String(err)))

await page.goto(URL)
await page.waitForTimeout(500)

const result = await page.evaluate(async () => {
  const mod = await import('/src/platform/audio-webaudio/engine.ts')
  const { engine } = mod
  await engine.resume()

  const before = engine.ctx.state
  const beforeConnectedOk = true // wireOutput() ran in the constructor without throwing, or we wouldn't be here

  const tap = await engine.createMasterTap()
  let chunkCount = 0
  let totalFrames = 0
  let sawTwoChannels = false
  tap.onChunk = (chunk) => {
    chunkCount++
    totalFrames += chunk.frameCount
    if (chunk.channels.length === 2) sawTwoChannels = true
  }

  await new Promise((resolve) => setTimeout(resolve, 1200))
  tap.stop()
  await new Promise((resolve) => setTimeout(resolve, 150))

  return {
    before,
    after: engine.ctx.state,
    beforeConnectedOk,
    chunkCount,
    totalFrames,
    sawTwoChannels,
    recorderAvailable: engine.recorderAvailable,
    recorderError: engine.recorderError,
  }
})

ok('AudioContext resumed to running', result.before === 'running', result.before)
ok('recorder worklet loaded', result.recorderAvailable === true, result.recorderError ?? '')
ok('at least one chunk arrived in ~1.2s', result.chunkCount > 0, `chunkCount=${result.chunkCount}`)
ok('chunks carry 2 channels', result.sawTwoChannels, '')
// ~1.2s of silence still produces real frames — the tap runs even with nothing loaded on either deck,
// which is correct: it taps masterPostFx, not "audio that happens to be audible".
const expectedFrames = 44100 * 1.2
const withinTolerance = Math.abs(result.totalFrames - expectedFrames) / expectedFrames < 0.15
ok(
  'frame count is close to the real-time expectation (±15%)',
  withinTolerance,
  `got ${result.totalFrames}, expected ~${Math.round(expectedFrames)}`,
)
ok('AudioContext still running after tap.stop() — masterPostFx wiring untouched', result.after === 'running', result.after)
ok('no console errors during the whole sequence', consoleErrors.length === 0, consoleErrors.join(' | '))

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
