import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage()
page.on('console', (m) => console.log('page:', m.text()))
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
const configs = JSON.parse(process.argv[2])
const out = await page.evaluate(async (configs) => {
  const { default: SS } = await import('/node_modules/signalsmith-stretch/SignalsmithStretch.mjs')
  const results = []
  for (const c of configs) {
    const sr = c.sr ?? 48000
    const ctx = new OfflineAudioContext(2, sr * 4, sr)
    const node = await SS(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
    if (c.blockMs) await node.configure({ blockMs: c.blockMs, ...(c.intervalMs ? { intervalMs: c.intervalMs } : {}) })
    const osc = ctx.createOscillator(); osc.frequency.value = c.inHz
    osc.connect(node); node.connect(ctx.destination)
    await node.schedule({ active: true, semitones: c.semitones, ...(c.tonalityHz ? { tonalityHz: c.tonalityHz } : {}) })
    osc.start()
    const buf = await ctx.startRendering()
    const d = buf.getChannelData(0).slice(sr * 2, sr * 3.5)
    // Hann-windowed DFT magnitude, golden search around the expected peak
    const N = d.length
    const w = new Float32Array(N); for (let i = 0; i < N; i++) w[i] = d[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)))
    const mag = (f) => { let re = 0, im = 0; const k = (2 * Math.PI * f) / sr; for (let i = 0; i < N; i++) { re += w[i] * Math.cos(k * i); im -= w[i] * Math.sin(k * i) } return re * re + im * im }
    let best = 0, bf = 0
    for (let f = c.expect - 30; f <= c.expect + 30; f += 0.5) { const m = mag(f); if (m > best) { best = m; bf = f } }
    let lo = bf - 0.5, hi = bf + 0.5
    for (let it = 0; it < 30; it++) { const a = lo + (hi - lo) * 0.382, b = lo + (hi - lo) * 0.618; if (mag(a) > mag(b)) hi = b; else lo = a }
    const f = (lo + hi) / 2
    results.push({ ...c, outHz: +f.toFixed(2), cents: +(1200 * Math.log2(f / c.expect)).toFixed(2), latency: await node.latency() })
  }
  return results
}, configs)
console.table(out)
await browser.close()
