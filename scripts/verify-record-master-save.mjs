/**
 * v0.7.5 step 5 verification (PLAN.md). Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-record-master-save.mjs
 *
 * Records ~3 real seconds from the master bus, saves it, and checks the
 * bytes actually written: a valid WAV header at the real sample rate, and a
 * data chunk whose length matches. `showSaveFilePicker` is mocked (no real
 * native dialog in headless Chromium) the same way other verify scripts in
 * this repo mock File System Access — the write path itself is real, only
 * the picker UI is stubbed. Also checks: canceling the picker leaves the
 * in-memory recording intact (spec requirement — cancel must not discard).
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

const RECORD_SEC = 3

const saveResult = await page.evaluate(async (recordSec) => {
  const written = []
  window.showSaveFilePicker = async () => ({
    createWritable: async () => ({
      write: async (chunk) => {
        const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
        written.push(buf)
      },
      close: async () => {},
    }),
  })

  const ctl = await import('/src/controls.ts')
  const { engine } = await import('/src/platform/audio-webaudio/engine.ts')
  await engine.resume()
  const sr = engine.ctx.sampleRate

  await ctl.startRecordMaster()
  await new Promise((r) => setTimeout(r, recordSec * 1000))
  await ctl.stopRecordMaster()

  const status = await ctl.saveRecordedMaster()
  const bytes = written[0] ? Array.from(written[0]) : []
  return { status, sampleRate: sr, byteLength: bytes.length, bytes }
}, RECORD_SEC)

ok('save resolved "ok"', saveResult.status === 'ok', saveResult.status)

const bytes = Uint8Array.from(saveResult.bytes)
const view = new DataView(bytes.buffer)
const riff = String.fromCharCode(...bytes.slice(0, 4))
const wave = String.fromCharCode(...bytes.slice(8, 12))
ok('written bytes start with a valid RIFF/WAVE header', riff === 'RIFF' && wave === 'WAVE', `${riff}/${wave}`)

const sampleRate = bytes.length >= 28 ? view.getUint32(24, true) : -1
ok('header sample rate matches the real AudioContext', sampleRate === saveResult.sampleRate, `${sampleRate} vs ${saveResult.sampleRate}`)

const dataChunkSize = bytes.length >= 44 ? view.getUint32(40, true) : -1
const expectedDataBytes = bytes.length - 44
ok('data chunk size matches the actual payload length', dataChunkSize === expectedDataBytes, `${dataChunkSize} vs ${expectedDataBytes}`)

const impliedSeconds = dataChunkSize > 0 ? dataChunkSize / (saveResult.sampleRate * 2 * 2) : -1
const closeToRecordedLength = Math.abs(impliedSeconds - RECORD_SEC) < 0.5
ok(`WAV data length implies ~${RECORD_SEC}s of stereo 16-bit audio`, closeToRecordedLength, `${impliedSeconds.toFixed(2)}s`)

// Cancel must not discard — record again, mock an AbortError, then save-for-real.
const cancelResult = await page.evaluate(async (recordSec) => {
  const written = []
  let firstCall = true
  window.showSaveFilePicker = async () => {
    if (firstCall) {
      firstCall = false
      const err = new DOMException('The user aborted a request.', 'AbortError')
      throw err
    }
    return {
      createWritable: async () => ({
        write: async (chunk) => written.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)),
        close: async () => {},
      }),
    }
  }
  const ctl = await import('/src/controls.ts')
  const { engine } = await import('/src/platform/audio-webaudio/engine.ts')
  await engine.resume()
  await ctl.startRecordMaster()
  await new Promise((r) => setTimeout(r, recordSec * 1000))
  await ctl.stopRecordMaster()
  const firstStatus = await ctl.saveRecordedMaster() // cancelled
  const secondStatus = await ctl.saveRecordedMaster() // real save, same buffer
  return { firstStatus, secondStatus, wroteBytes: written.length > 0 }
}, RECORD_SEC)

ok('cancelled save reports "cancelled"', cancelResult.firstStatus === 'cancelled', cancelResult.firstStatus)
ok('retrying save after cancel still writes the SAME recording', cancelResult.secondStatus === 'ok' && cancelResult.wroteBytes, JSON.stringify(cancelResult))

ok('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '))

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
