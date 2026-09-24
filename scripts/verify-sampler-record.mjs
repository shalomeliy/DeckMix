/**
 * v0.7.5 step 6 verification (PLAN.md). Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-sampler-record.mjs
 *
 * Records live from the master bus into an empty sampler slot, confirms it
 * plays back immediately, then reloads the page (real navigation, same
 * IndexedDB) and confirms it's still there — the spec's explicit
 * requirement that a recorded slot survives a refresh, unlike an ordinary
 * in-memory buffer. Also checks: recording into an occupied slot is
 * refused, and clearing a recorded slot removes its stored blob.
 */
import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium' })
const context = await browser.newContext()
const page = await context.newPage()
const consoleErrors = []
page.on('pageerror', (err) => consoleErrors.push(String(err)))
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})

await page.goto(URL)
await page.waitForTimeout(500)

const RECORD_SEC = 2
const SLOT = 0

const first = await page.evaluate(async ({ slot, recordSec }) => {
  const ctl = await import('/src/controls.ts')
  const { engine } = await import('/src/platform/audio-webaudio/engine.ts')
  const { useStore } = await import('/src/app/state/store.ts')
  await engine.resume()

  await ctl.startSamplerCapture(slot)
  const armedDuringRecording = useStore.getState().sampler.armedSlot === slot
  await new Promise((r) => setTimeout(r, recordSec * 1000))
  await ctl.stopSamplerCapture(slot)
  // stopSamplerCapture awaits both the blob save and the bank metadata
  // persist directly (not the debounced scheduler other slot edits use) —
  // by the time it resolves, both writes have already landed. This wait is
  // just headroom, not compensating for a race.
  await new Promise((r) => setTimeout(r, 150))

  const slotState = useStore.getState().sampler.slots[slot]
  const hasBuffer = engine.sampler.hasBuffer(slot)
  const armedAfter = useStore.getState().sampler.armedSlot

  // Recording into an already-occupied slot must be refused.
  await ctl.startSamplerCapture(slot)
  const armedOnOccupiedAttempt = useStore.getState().sampler.armedSlot

  return {
    armedDuringRecording,
    hasBuffer,
    recordingId: slotState.recordingId,
    trackId: slotState.trackId,
    trackName: slotState.trackName,
    armedAfter,
    armedOnOccupiedAttempt,
  }
}, { slot: SLOT, recordSec: RECORD_SEC })

ok('slot showed as armed while recording', first.armedDuringRecording, '')
ok('engine holds a buffer for the slot right after stop', first.hasBuffer, '')
ok('slot got a recordingId (not a library trackId)', typeof first.recordingId === 'string' && first.trackId === null, JSON.stringify(first))
ok('slot got a friendly default name', /^Recording \d+$/.test(first.trackName ?? ''), first.trackName)
ok('armedSlot cleared after stop', first.armedAfter === null, String(first.armedAfter))
ok('starting a capture on an already-occupied slot is refused', first.armedOnOccupiedAttempt === null, String(first.armedOnOccupiedAttempt))

// Real navigation — same browser context, same IndexedDB, fresh JS state.
await page.reload()
await page.waitForTimeout(500)

const afterReload = await page.evaluate(async (slot) => {
  const { engine } = await import('/src/platform/audio-webaudio/engine.ts')
  const ctl = await import('/src/controls.ts')
  const { useStore } = await import('/src/app/state/store.ts')
  await ctl.initAudio()
  // initAudio's resolveSamplerSlots(silent) is fire-and-forget — give it a
  // moment to actually decode the blob and load the slot.
  await new Promise((r) => setTimeout(r, 500))
  const slotState = useStore.getState().sampler.slots[slot]
  return { hasBuffer: engine.sampler.hasBuffer(slot), recordingId: slotState.recordingId }
}, SLOT)

ok('recorded slot survives a page reload (persists in IndexedDB)', afterReload.hasBuffer && !!afterReload.recordingId, JSON.stringify(afterReload))

// Clearing the slot should delete its blob — verified by checking a fresh
// resolve attempt on the same recordingId comes back empty afterward.
const clearResult = await page.evaluate(async (slot) => {
  const ctl = await import('/src/controls.ts')
  const { useStore } = await import('/src/app/state/store.ts')
  const store = await import('/src/platform/sampler-recordings-idb/store.ts')
  const recordingId = useStore.getState().sampler.slots[slot].recordingId
  ctl.clearSamplerSlot(slot)
  await new Promise((r) => setTimeout(r, 200))
  const blobAfterClear = recordingId ? await store.getRecordingBlob(recordingId) : 'no-recording-id'
  return { blobAfterClear: blobAfterClear === undefined ? 'deleted' : blobAfterClear }
}, SLOT)

ok('clearing a recorded slot deletes its stored blob', clearResult.blobAfterClear === 'deleted', JSON.stringify(clearResult))
ok('no console errors across the whole sequence', consoleErrors.length === 0, consoleErrors.join(' | '))

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
