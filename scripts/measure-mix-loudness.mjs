/**
 * How loud is a Mix Assist mix, moment by moment, against the two songs it joins? (v0.9.33, the owner, 07/10: "when the mix runs I hear the
 * volume drop, and it must not: the music has to stay at the same level through the whole mix".)
 *   node --import ./scripts/train/alias-register.mjs scripts/measure-mix-loudness.mjs [--curve power|full-middle|shipped] <a> <b> [<a> <b> ...]
 *
 * Offline, on real files (decoded by ffmpeg), through the SHIPPED frame functions (`eqMixFrame`, `vocalSwapFrame`, `crossfaderGains`) and
 * the deck's own EQ: the same three biquads `platform/audio-webaudio/deck.ts` builds (low shelf 100 Hz, peaking 1 kHz Q 0.9, high shelf
 * 6 kHz), computed with the Web Audio spec's own coefficient formulas, the knob turned into dB exactly as `Deck.setEq` does, and the gains
 * and EQ dB smoothed with the engine's own `setTargetAtTime` time constants. Nothing is played; the two songs are not beat-matched (that
 * changes where the kicks fall, not how loud the room is).
 *
 * The yardstick is the loudness the room should have at that moment if nothing in the mix lost level: the two songs RAW, unprocessed,
 * blended by power from all-A at the join to all-B at the end. A drop of the mix below that line is a drop the owner hears — and it follows
 * the music's own swells, so a breakdown in A is not counted against the mix. Loudness is ITU-R BS.1770 K-weighted, 400 ms windows every
 * 100 ms (the "momentary" loudness a meter shows). Also reported: the highest sample of the summed mix (above 1.0 is a clip — no limiter on
 * the master).
 *
 * `--curve` overrides the crossfader curve for every mix (to compare); `shipped` (the default) uses what `controls.ts` uses.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { EQ_CUT_DB, EQ_DB, TRANSITION_CROSSFADE_SEC } from '../src/core/constants.ts'
import { ISOLATOR_PATHS, bandGain, biquadCoeffs } from '../src/core/isolator.ts'
import { eqMixFrame, plainEqMixPlan, AUTO_MIX_CROSSFADER_CURVE } from '../src/core/eq-mix.ts'
import { crossfaderGains } from '../src/core/fx.ts'
import { SWAP_BARS, SWAP_CROSSFADER_CURVE, vocalSwapFrame } from '../src/core/vocal-swap-mix.ts'

const SR = 44100
const BLOCK = 128 // a Web Audio render quantum: k-rate params (biquad gain) change once per block
const BPM = 126
const BAR = (60 / BPM) * 4

const args = process.argv.slice(2)
let curveArg = 'shipped'
let trace = false
/** `--wav <dir>`: also write each mix as a 32-bit float WAV, for a listen or for `verify-limiter.mjs` to run through the real limiter. */
let wavDir = null
for (;;) {
  if (args[0] === '--curve') {
    curveArg = args[1]
    args.splice(0, 2)
  } else if (args[0] === '--wav') {
    wavDir = args[1]
    args.splice(0, 2)
  } else if (args[0] === '--trace') {
    trace = true
    args.splice(0, 1)
  } else break
}
if (args.length < 2 || args.length % 2) {
  console.error('usage: [--curve power|full-middle|shipped] <a> <b> [<a> <b> ...]')
  process.exit(2)
}

function decode(path) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', String(SR), '-'], { maxBuffer: 1 << 30 })
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  const n = f.length / 2
  const l = new Float32Array(n)
  const r = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    l[i] = f[2 * i]
    r[i] = f[2 * i + 1]
  }
  return [l, r]
}

class Biquad {
  constructor() {
    this.z = [0, 0, 0, 0]
  }
  run(x, k, from, to) {
    let [x1, x2, y1, y2] = this.z
    const [b0, b1, b2, a1, a2] = k
    for (let i = from; i < to; i++) {
      const xi = x[i]
      const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = xi
      y2 = y1
      y1 = y
      x[i] = y
    }
    this.z = [x1, x2, y1, y2]
  }
}

/**
 * One deck: its isolator (per channel: three band paths from `ISOLATOR_PATHS`, each through its knob's gain, summed) and its fader, the
 * knobs and fader driven per render block and smoothed like the engine's `setTargetAtTime` (10 ms on a knob, 5 ms on the fader).
 */
function processDeck(chans, startSample, n, eqAt, gainAt, gainTau) {
  const paths = Object.fromEntries(
    Object.entries(ISOLATOR_PATHS).map(([band, specs]) => [band, specs.map((f) => biquadCoeffs(f.type, f.freq, SR, f.q))]),
  )
  const bands = ['low', 'mid', 'high']
  const out = chans.map(() => new Float32Array(n))
  const state = chans.map(() => Object.fromEntries(bands.map((band) => [band, paths[band].map(() => new Biquad())])))
  const bandG = Object.fromEntries(bands.map((band) => [band, bandGain(eqAt(0)[band], EQ_DB, EQ_CUT_DB)]))
  let g = gainAt(0)
  const eqA = 1 - Math.exp(-BLOCK / SR / 0.01)
  const gA = 1 - Math.exp(-BLOCK / SR / gainTau)
  const tmp = new Float32Array(BLOCK)
  for (let i = 0; i < n; i += BLOCK) {
    const t = i / SR
    const eq = eqAt(t)
    const g0 = g
    g += (gainAt(t) - g) * gA
    const end = Math.min(n, i + BLOCK)
    const len = end - i
    const bg0 = { ...bandG }
    for (const band of bands) bandG[band] += (bandGain(eq[band], EQ_DB, EQ_CUT_DB) - bandG[band]) * eqA
    chans.forEach((src, ch) => {
      for (const band of bands) {
        tmp.set(src.subarray(startSample + i, startSample + end))
        paths[band].forEach((k, j) => state[ch][band][j].run(tmp, k, 0, len))
        for (let s = 0; s < len; s++) {
          const r = s / BLOCK
          out[ch][i + s] += tmp[s] * (bg0[band] + (bandG[band] - bg0[band]) * r) * (g0 + (g - g0) * r)
        }
      }
    })
  }
  return out
}

/** BS.1770 K-weighting, re-derived for 44.1 kHz from the standard's analogue prototypes. */
function kWeight(chans) {
  const hs = biquadCoeffs('highshelf', 1681.97, SR, 1, 4.0)
  const hp = biquadCoeffs('highpass', 38.135, SR, 20 * Math.log10(0.5003))
  return chans.map((c) => {
    const x = Float32Array.from(c)
    new Biquad().run(x, hs, 0, x.length)
    new Biquad().run(x, hp, 0, x.length)
    return x
  })
}

/** Mean-square power per 400 ms window, every 100 ms, summed over channels. */
function windows(chansK) {
  const win = Math.round(0.4 * SR)
  const hop = Math.round(0.1 * SR)
  const n = chansK[0].length
  const out = []
  for (let s = 0; s + win <= n; s += hop) {
    let p = 0
    for (const x of chansK) {
      let acc = 0
      for (let i = s; i < s + win; i++) acc += x[i] * x[i]
      p += acc / win
    }
    out.push({ t: (s + win / 2) / SR, p })
  }
  return out
}
const lufs = (p) => -0.691 + 10 * Math.log10(p + 1e-12)

const own = { a: { low: 0, mid: 0, high: 0 }, b: { low: 0, mid: 0, high: 0 } }

/** The three kinds of Mix Assist mix, each laid out from t = 0 at the join on A's seconds (with SYNC, B's seconds run alongside). */
function mixes() {
  const pre = 4 // seconds of A alone before the join, and of B alone after the end — to read each song's own level
  const plain = plainEqMixPlan(TRANSITION_CROSSFADE_SEC, BAR)
  const handoff = { joinSec: 0, swapSec: 8 * BAR, fadeEndSec: 16 * BAR }
  const swap = { joinSec: 0, entrySec: 0, bVoiceSec: 0, voiceSec: 0, swapSec: SWAP_BARS * BAR, endSec: SWAP_BARS * BAR + BAR / 4, onVoiceEnd: true }
  const curve = (shipped) => (curveArg === 'shipped' ? shipped : curveArg)
  return [
    { name: 'plain (energy point / Mix in pad)', pre, len: plain.fadeEndSec, frame: (p) => eqMixFrame(plain, p, BAR, own, 'instant'), curve: curve(AUTO_MIX_CROSSFADER_CURVE), marks: { swap: plain.swapSec } },
    { name: 'vocal handoff (8 + 8 bars)', pre, len: handoff.fadeEndSec, frame: (p) => eqMixFrame(handoff, p, BAR, own, 'instant'), curve: curve(AUTO_MIX_CROSSFADER_CURVE), marks: { swap: handoff.swapSec } },
    { name: 'vocal swap', pre, len: swap.endSec, frame: (p) => vocalSwapFrame(swap, p, BAR, own), curve: curve(SWAP_CROSSFADER_CURVE), marks: { swap: swap.swapSec } },
  ]
}

const short = (p) => p.split('/').pop().replace(/\.[^.]+$/, '')

function writeWav(path, chans) {
  const n = chans[0].length
  const buf = Buffer.alloc(44 + n * 8)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 8, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(3, 20) // IEEE float: the overs above 1.0 are the point, a 16-bit file would clip them away
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 8, 28)
  buf.writeUInt16LE(8, 32)
  buf.writeUInt16LE(32, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 8, 40)
  for (let i = 0; i < n; i++) {
    buf.writeFloatLE(chans[0][i], 44 + i * 8)
    buf.writeFloatLE(chans[1][i], 48 + i * 8)
  }
  writeFileSync(path, buf)
}

function measure(aPath, bPath, a, b) {
  const rows = []
  for (const m of mixes()) {
    const total = m.pre + m.len + m.pre
    const n = Math.round(total * SR)
    // A from 40% of the song (a full section), B from 30%: the join sits mid-song, as in a set.
    const aStart = Math.round(a[0].length * 0.4)
    const bStart = Math.round(b[0].length * 0.3) - Math.round(m.pre * SR) // B starts at the join
    const at = (t) => m.frame(Math.min(m.len, Math.max(0, t - m.pre)))
    const progress = (t) => (t < m.pre ? 0 : at(t).progress)
    const xg = (t) => crossfaderGains(progress(t), m.curve)
    const aOut = processDeck(a, aStart, n, (t) => (t < m.pre ? own.a : at(t).a), (t) => xg(t).a, 0.005)
    // B is silent (paused) until the join.
    const bOut = processDeck(b, bStart, n, (t) => (t < m.pre ? own.b : at(t).b), (t) => (t < m.pre ? 0 : xg(t).b), 0.005)
    const mix = [0, 1].map((ch) => aOut[ch].map((v, i) => v + bOut[ch][i]))
    let peak = 0
    let clipped = 0
    for (const x of mix)
      for (const v of x) {
        const av = Math.abs(v)
        if (av > peak) peak = av
        if (av > 1) clipped++
      }
    const wm = windows(kWeight(mix))
    const wa = windows(kWeight([0, 1].map((ch) => a[ch].slice(aStart, aStart + n))))
    const wb = windows(kWeight([0, 1].map((ch) => b[ch].slice(Math.max(0, bStart), Math.max(0, bStart) + n))))
    // The yardstick: raw A and raw B blended by power, all A to the join, all B from the end.
    const devs = wm.map((w, i) => {
      const u = Math.min(1, Math.max(0, (w.t - m.pre) / m.len))
      const ref = (1 - u) * wa[i].p + u * wb[i].p
      return { t: w.t - m.pre, d: lufs(w.p) - lufs(ref) }
    })
    const inMix = devs.filter((d) => d.t >= 0 && d.t <= m.len)
    const min = inMix.reduce((x, y) => (y.d < x.d ? y : x))
    const max = inMix.reduce((x, y) => (y.d > x.d ? y : x))
    const mean = inMix.reduce((s, d) => s + d.d, 0) / inMix.length
    const below2 = inMix.filter((d) => d.d < -2).length / inMix.length
    if (trace) {
      const peakAt = (x) => x.reduce((m, v, i) => (Math.abs(v) > Math.abs(x[m]) ? i : m), 0)
      const pi = peakAt(mix[0])
      console.log(`  ${m.name}: peak at ${(pi / SR - m.pre).toFixed(2)} s; A alone there ${aOut[0][pi].toFixed(2)}, B ${bOut[0][pi].toFixed(2)}`)
      console.log('   ' + devs.filter((_, i) => i % 5 === 0).map((d) => `${d.t.toFixed(1)}:${d.d.toFixed(1)}`).join(' '))
    }
    if (wavDir) writeWav(`${wavDir}/${short(aPath)} -- ${short(bPath)} -- ${m.name.split(' (')[0]}.wav`, mix)
    rows.push({ mix: m.name, curve: m.curve, min, max, mean, below2, peak, clipped, devs: inMix })
  }
  console.log(`\nA = ${short(aPath)}   B = ${short(bPath)}   (A ${lufs(windows(kWeight(a)).reduce((s, w) => s + w.p, 0) / windows(kWeight(a)).length).toFixed(1)} LUFS avg, B ${lufs(windows(kWeight(b)).reduce((s, w) => s + w.p, 0) / windows(kWeight(b)).length).toFixed(1)})`)
  for (const r of rows) {
    console.log(
      `  ${r.mix.padEnd(36)} ${r.curve.padEnd(11)} lowest ${r.min.d.toFixed(1).padStart(5)} dB @${r.min.t.toFixed(1)}s  mean ${r.mean.toFixed(1).padStart(5)}  highest ${r.max.d.toFixed(1).padStart(5)}  >2dB under ${(100 * r.below2).toFixed(0).padStart(3)}%  peak ${(20 * Math.log10(r.peak)).toFixed(1)} dBFS${r.clipped ? ` (${r.clipped} samples clip)` : ''}`,
    )
  }
  return rows
}

const all = []
for (let i = 0; i < args.length; i += 2) all.push(...measure(args[i], args[i + 1], decode(args[i]), decode(args[i + 1])))
const byMix = {}
for (const r of all) (byMix[r.mix] ??= []).push(r)
console.log('\nAll pairs:')
for (const [name, rs] of Object.entries(byMix)) {
  const worst = Math.min(...rs.map((r) => r.min.d))
  const mean = rs.reduce((s, r) => s + r.mean, 0) / rs.length
  const under = rs.reduce((s, r) => s + r.below2, 0) / rs.length
  const peak = Math.max(...rs.map((r) => r.peak))
  console.log(`  ${name.padEnd(36)} worst ${worst.toFixed(1)} dB  mean ${mean.toFixed(1)} dB  >2dB under ${(100 * under).toFixed(0)}%  max peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS  clipping pairs ${rs.filter((r) => r.clipped).length}/${rs.length}`)
}
