/**
 * The master limiter (v0.9.33) on real mixes, in Chromium's own `DynamicsCompressorNode` — the node the engine uses, with the engine's own
 * numbers (`MASTER_LIMITER`). Input: float WAVs written by `measure-mix-loudness.mjs --wav <dir>` (an automatic mix of two of the owner's
 * songs, overs above 1.0 kept). Each file goes through the default levels (channel 0.9 × master 0.85, `store.ts`), once straight and once
 * through the limiter, offline. Reported: the highest sample (the limiter's job: at or under 0 dBFS), the samples that would clip, and how
 * much the limiter changed the loudness (it must not: it is a guard on the peaks, not a volume knob).
 *   node --import ./scripts/train/alias-register.mjs scripts/verify-limiter.mjs <dir>
 */
import fs from 'node:fs'
import { chromium } from 'playwright'
import { MASTER_LIMITER, limiterMakeupDb } from '../src/core/constants.ts'

const L = { ...MASTER_LIMITER, ...(process.env.LIM ? JSON.parse(process.env.LIM) : {}) }
const comp = -limiterMakeupDb(L)

const dir = process.argv[2]
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.wav'))
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined })
const page = await browser.newPage()
let fail = 0
for (const f of files) {
  const b64 = fs.readFileSync(`${dir}/${f}`).toString('base64')
  const r = await page.evaluate(
    async ({ b64, L, comp }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const decoded = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(bytes.buffer)
      const render = async (limit) => {
        const ctx = new OfflineAudioContext(2, decoded.length, decoded.sampleRate)
        const src = ctx.createBufferSource()
        src.buffer = decoded
        const g = ctx.createGain()
        g.gain.value = 0.9 * 0.85
        let node = src.connect(g)
        if (limit) {
          const c = ctx.createDynamicsCompressor()
          c.threshold.value = L.thresholdDb
          c.knee.value = L.kneeDb
          c.ratio.value = L.ratio
          c.attack.value = L.attackSec
          c.release.value = L.releaseSec
          const post = ctx.createGain()
          post.gain.value = 10 ** (comp / 20)
          node = node.connect(c).connect(post)
        }
        node.connect(ctx.destination)
        src.start()
        const out = await ctx.startRendering()
        let peak = 0
        let over = 0
        let sq = 0
        for (let ch = 0; ch < 2; ch++) {
          const x = out.getChannelData(ch)
          for (const v of x) {
            const a = Math.abs(v)
            if (a > peak) peak = a
            if (a > 1) over++
            sq += v * v
          }
        }
        return { peakDb: 20 * Math.log10(peak), over, rmsDb: 10 * Math.log10(sq / (2 * out.length)) }
      }
      return { raw: await render(false), lim: await render(true) }
    },
    { b64, L, comp },
  )
  const ok = r.lim.over === 0 && Math.abs(r.lim.rmsDb - r.raw.rmsDb) < 1
  if (!ok) fail++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${f.padEnd(70)} without: peak ${r.raw.peakDb.toFixed(1)} dBFS, ${r.raw.over} clip | with: peak ${r.lim.peakDb.toFixed(1)}, ${r.lim.over} clip, loudness ${(r.lim.rmsDb - r.raw.rmsDb >= 0 ? '+' : '') + (r.lim.rmsDb - r.raw.rmsDb).toFixed(2)} dB`,
  )
}
await browser.close()
console.log(`${files.length - fail}/${files.length}`)
process.exit(fail ? 1 : 0)
