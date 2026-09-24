/**
 * v0.7.5 step 8 verification (PLAN.md). Run against `npm run dev` on :5173:
 *
 *   node scripts/verify-record-master-split.mjs
 *
 * Records ~3 real seconds, marks a track boundary partway through (via
 * markRecordingTrackBoundary, driven through the TopBar "Mark track"
 * button in verify-topbar-recording.mjs already — this script exercises
 * the split-file output itself), then saves. `showDirectoryPicker` is
 * mocked the same way other scripts mock File System Access. Checks: two
 * WAV files are written (one per side of the boundary), each a valid
 * header at the real sample rate, their combined duration matches the
 * total recording, and the cue sheet names both files with times that
 * match the boundary.
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
const MARK_AT_SEC = 1.2

const result = await page.evaluate(async ({ recordSec, markAtSec }) => {
  const writtenFiles = {}
  let cueSheetText = null
  window.showDirectoryPicker = async () => ({
    getFileHandle: async (name) => ({
      createWritable: async () => ({
        write: async (chunk) => {
          if (name === 'cue-sheet.txt') {
            cueSheetText = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
          } else {
            writtenFiles[name] = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
          }
        },
        close: async () => {},
      }),
    }),
  })

  const ctl = await import('/src/controls.ts')
  const { engine } = await import('/src/platform/audio-webaudio/engine.ts')
  await engine.resume()
  const sampleRate = engine.ctx.sampleRate

  await ctl.startRecordMaster()
  await new Promise((r) => setTimeout(r, markAtSec * 1000))
  ctl.markRecordingTrackBoundary()
  await new Promise((r) => setTimeout(r, (recordSec - markAtSec) * 1000))
  await ctl.stopRecordMaster()

  const status = await ctl.saveRecordedMaster()

  const filesOut = {}
  for (const [name, bytes] of Object.entries(writtenFiles)) filesOut[name] = Array.from(bytes)

  return { status, sampleRate, files: filesOut, cueSheetText }
}, { recordSec: RECORD_SEC, markAtSec: MARK_AT_SEC })

ok('save resolved "ok"', result.status === 'ok', result.status)

const fileNames = Object.keys(result.files).sort()
ok('exactly two track files were written', fileNames.length === 2, JSON.stringify(fileNames))
ok('files are named track-1.wav / track-2.wav', fileNames.join(',') === 'track-1.wav,track-2.wav', fileNames.join(','))

let totalDataBytes = 0
for (const name of fileNames) {
  const bytes = Uint8Array.from(result.files[name]);
  const view = new DataView(bytes.buffer)
  const riff = String.fromCharCode(...bytes.slice(0, 4))
  const wave = String.fromCharCode(...bytes.slice(8, 12))
  ok(`${name} has a valid RIFF/WAVE header`, riff === 'RIFF' && wave === 'WAVE', `${riff}/${wave}`)
  const sr = view.getUint32(24, true)
  ok(`${name} header sample rate matches the real context`, sr === result.sampleRate, `${sr} vs ${result.sampleRate}`)
  totalDataBytes += view.getUint32(40, true)
}

const impliedTotalSeconds = totalDataBytes / (result.sampleRate * 2 * 2)
const closeToRecordedLength = Math.abs(impliedTotalSeconds - RECORD_SEC) < 0.5
ok(`combined track duration implies ~${RECORD_SEC}s total`, closeToRecordedLength, `${impliedTotalSeconds.toFixed(2)}s`)

ok('a cue sheet was written', !!result.cueSheetText, result.cueSheetText ?? '(none)')
ok('cue sheet names both tracks', /Track 1:.*track-1\.wav/.test(result.cueSheetText ?? '') && /Track 2:.*track-2\.wav/.test(result.cueSheetText ?? ''), result.cueSheetText ?? '')

// The boundary was marked at ~1.2s — the cue sheet's Track 1 end time should be close to that.
const match = (result.cueSheetText ?? '').match(/Track 1: (\d\d):(\d\d):(\d\d) - (\d\d):(\d\d):(\d\d)/)
if (match) {
  const endSec = Number(match[4]) * 3600 + Number(match[5]) * 60 + Number(match[6])
  ok(`Track 1 ends near the ${MARK_AT_SEC}s mark`, Math.abs(endSec - MARK_AT_SEC) <= 1, `${endSec}s`)
} else {
  ok('Track 1 line parses from the cue sheet', false, result.cueSheetText ?? '')
}

ok('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '))

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
