// v0.9.64 experiment page, driven by scripts/experiment-decoder.mjs. Not part of the app bundle.
// For each MP3: the browser's decodeAudioData (what a deck load uses today) against the app's own WASM decoder
// (src/platform/decode-worker, minimp3 + gapless trim + resample to the context rate), same bytes, same context rate.
import { decodeInWorker } from '@/platform/decode-worker'

interface Row {
  name: string
  mb: number
  browserMs: number
  oursMs: number
  browserFrames: number
  oursFrames: number
  maxDiff: number
  rmsDiff: number
  rmsSignal: number
  snrDb: number
  bestLag: number
  maxDiffAtBestLag: number
  rmsDiffAtBestLag: number
  channels: [number, number]
  ctxRate: number
  fileRate: number
  error?: string
}

declare global {
  interface Window {
    runCompare: (urls: string[]) => Promise<Row[]>
  }
}

function diff(a: Float32Array, b: Float32Array, lag: number) {
  // b shifted by `lag` samples against a
  let max = 0
  let sq = 0
  let sig = 0
  let n = 0
  const start = Math.max(0, -lag)
  const end = Math.min(a.length, b.length - lag)
  for (let i = start; i < end; i++) {
    const d = a[i] - b[i + lag]
    const ad = Math.abs(d)
    if (ad > max) max = ad
    sq += d * d
    sig += a[i] * a[i]
    n++
  }
  return { max, rms: Math.sqrt(sq / Math.max(1, n)), sig: Math.sqrt(sig / Math.max(1, n)) }
}

window.runCompare = async (urls) => {
  // ?rate=48000 forces the context rate (the owner's Windows PC runs 48 kHz; a Linux container may run 44.1 kHz)
  const rate = Number(new URLSearchParams(location.search).get('rate'))
  const ctx = new AudioContext(rate ? { sampleRate: rate } : undefined)
  const rows: Row[] = []
  for (const url of urls) {
    const name = decodeURIComponent(url.split('/').pop() ?? url)
    const base = await (await fetch(url)).arrayBuffer()
    try {
      let t = performance.now()
      const ab = await ctx.decodeAudioData(base.slice(0))
      const browserMs = performance.now() - t
      t = performance.now()
      const pcm = await decodeInWorker(base.slice(0), name, ctx.sampleRate)
      const oursMs = performance.now() - t
      if (!pcm) throw new Error('worker path declined the file')
      const a = ab.getChannelData(0)
      const b = pcm.channels[0]
      const at0 = diff(a, b, 0)
      // the sound is only "the same" if no lag is needed; search a small window to tell a shift from a real difference
      let bestLag = 0
      let best = at0
      for (let lag = -64; lag <= 64; lag++) {
        const d = diff(a, b, lag)
        if (d.rms < best.rms) {
          best = d
          bestLag = lag
        }
      }
      rows.push({
        name,
        mb: base.byteLength / 1048576,
        browserMs,
        oursMs,
        browserFrames: a.length,
        oursFrames: b.length,
        maxDiff: at0.max,
        rmsDiff: at0.rms,
        rmsSignal: at0.sig,
        snrDb: 20 * Math.log10(at0.sig / Math.max(at0.rms, 1e-12)),
        bestLag,
        maxDiffAtBestLag: best.max,
        rmsDiffAtBestLag: best.rms,
        channels: [ab.numberOfChannels, pcm.channels.length],
        ctxRate: ctx.sampleRate,
        fileRate: 0,
      })
    } catch (err) {
      rows.push({ name, mb: base.byteLength / 1048576, error: String(err) } as Row)
    }
  }
  return rows
}
