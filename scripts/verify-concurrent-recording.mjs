/**
 * v0.7.5 AC6 verification (added after change-reviewer flagged it as
 * unverified). Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-concurrent-recording.mjs
 *
 * Runs a master recording and a sampler-slot capture at the same time,
 * off the same masterPostFx tap mechanism, and forces the sampler
 * capture to hit its own (test-lowered) cap and auto-stop mid-way — the
 * sharpest version of "one recording's failure/end must not affect the
 * other" the spec's AC6 asks for, since it's not just two independent
 * successes but one of them terminating abnormally while the other keeps
 * running.
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

await page.goto(URL)
await page.evaluate(() => {
  window.showSaveFilePicker = async () => ({
    createWritable: async () => ({ write: async () => {}, close: async () => {} }),
  })
})
await page.waitForTimeout(500)

const SAMPLER_CAP_SEC = 1
const SLOT = 3

const result = await page.evaluate(async ({ samplerCapSec, slot }) => {
  const recording = await import('/src/core/recording.ts')
  recording.setSamplerCaptureMaxSecForTest(samplerCapSec)

  const ctl = await import('/src/controls.ts')
  const { engine } = await import('/src/platform/audio-webaudio/engine.ts')
  const { useStore } = await import('/src/app/state/store.ts')
  await engine.resume()

  await ctl.startRecordMaster()
  await new Promise((r) => setTimeout(r, 300))
  await ctl.startSamplerCapture(slot)

  const bothActive = {
    master: useStore.getState().recording.active === 'master',
    samplerArmed: useStore.getState().sampler.armedSlot === slot,
  }

  // Let the sampler capture run past its (lowered) cap while master keeps going.
  await new Promise((r) => setTimeout(r, (samplerCapSec + 1.5) * 1000))

  const afterSamplerCap = {
    samplerArmed: useStore.getState().sampler.armedSlot,
    slotHasBuffer: engine.sampler.hasBuffer(slot),
    slotRecordingId: useStore.getState().sampler.slots[slot].recordingId,
    masterStillActive: useStore.getState().recording.active === 'master',
    masterBytesRecorded: useStore.getState().recording.bytesRecorded,
  }

  // Master keeps recording a bit more, then stops and saves normally —
  // proof the sampler cap's auto-stop didn't disturb it at all.
  await new Promise((r) => setTimeout(r, 500))
  const bytesBeforeStop = useStore.getState().recording.bytesRecorded
  await ctl.stopRecordMaster()
  const masterSaveStatus = await ctl.saveRecordedMaster()

  recording.setSamplerCaptureMaxSecForTest(5 * 60)

  return { bothActive, afterSamplerCap, bytesBeforeStop, masterSaveStatus }
}, { samplerCapSec: SAMPLER_CAP_SEC, slot: SLOT })

ok('both recordings were active at once', result.bothActive.master && result.bothActive.samplerArmed, JSON.stringify(result.bothActive))
ok('sampler capture auto-stopped at its (lowered) cap', result.afterSamplerCap.samplerArmed === null, JSON.stringify(result.afterSamplerCap))
ok('the sampler slot still got a playable buffer from before the cap hit', result.afterSamplerCap.slotHasBuffer, '')
ok('the sampler slot got a recordingId (persisted, not just in-memory)', typeof result.afterSamplerCap.slotRecordingId === 'string', String(result.afterSamplerCap.slotRecordingId))
ok(
  'the master recording was completely unaffected by the sampler auto-stop',
  result.afterSamplerCap.masterStillActive && result.afterSamplerCap.masterBytesRecorded > 0,
  JSON.stringify(result.afterSamplerCap),
)
ok('master kept accumulating bytes after the sampler stopped', result.bytesBeforeStop > result.afterSamplerCap.masterBytesRecorded, `${result.afterSamplerCap.masterBytesRecorded} -> ${result.bytesBeforeStop}`)
ok('master still saved successfully afterward', result.masterSaveStatus === 'ok', result.masterSaveStatus)
ok('no console errors across the whole sequence', consoleErrors.length === 0, consoleErrors.join(' | '))

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
