import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

/**
 * v0.9.27: the key lock plays the bass in tune.
 *
 * Signalsmith Stretch 1.3.2 (the npm build v0.9.20 shipped) put every shifted note a fixed 1-2.5 Hz sharp. A fixed number of Hz is a
 * small error at 440 Hz (+9 cents) and a big one in the bass: measured in Chromium on 07/10 with the app's own setting (60 ms block),
 * 50 Hz at -1.33 semitones came out +86 cents and at -2 semitones +104 cents - most of a semitone, a bassline clashing with the other
 * deck exactly when Key sync is trying to match them. The cause is in the library's phase prediction (it mixes two bins' phases measured
 * against two different centre frequencies); `vendor/signalsmith-stretch/fix-bass-pitch.patch` is the fix and README.md there has the
 * numbers.
 *
 * This runs the WASM that actually ships, straight through the library's own C entry points - the same calls its AudioWorklet makes,
 * 128 samples at a time - in a bare JS context with no browser globals, which is what an AudioWorkletGlobalScope gives it. That second
 * half matters too: an emscripten newer than the pinned one builds a file that hangs in that scope (see build.sh), and the module
 * failing to start here fails the test.
 */

const SR = 48000
const BLOCK = 128
const TONALITY_HZ = 8000 // the web wrapper's default `tonalityHz`

interface StretchWasm {
  _main(): void
  _configure(channels: number, blockSamples: number, intervalSamples: number, split: boolean): void
  _reset(): void
  _setBuffers(channels: number, length: number): number
  _setTransposeSemitones(semitones: number, tonality: number): void
  _setFormantSemitones(semitones: number, compensate: boolean): void
  _setFormantBase(freq: number): void
  _process(inputSamples: number, outputSamples: number): void
  HEAP8: Int8Array
}

async function loadWasm(): Promise<StretchWasm> {
  const src = readFileSync(new URL('../../vendor/signalsmith-stretch/SignalsmithStretch.mjs', import.meta.url), 'utf8')
  // The emscripten factory is everything before the web wrapper - the same slice the wrapper stringifies into its worklet.
  const factory = src.slice(src.indexOf('var SignalsmithStretch'), src.indexOf('function registerWorkletProcessor'))
  const ctx = vm.createContext({ WebAssembly, console })
  vm.runInContext(`${factory}\nglobalThis.factory = SignalsmithStretch`, ctx)
  const started = (ctx.factory as () => Promise<StretchWasm>)()
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the WASM module never started')), 5000))
  const wasm = await Promise.race([started, timeout])
  wasm._main()
  return wasm
}

/** A sine at `hz` through the stretch at `semitones`, with the app's 60 ms block (interval = block / 4, as the wrapper sets it). */
function render(wasm: StretchWasm, hz: number, semitones: number, seconds: number): Float32Array {
  wasm._configure(1, Math.round(0.06 * SR), Math.round(0.015 * SR), false)
  wasm._reset()
  const ptr = wasm._setBuffers(1, BLOCK)
  wasm._setTransposeSemitones(semitones, TONALITY_HZ / SR)
  wasm._setFormantSemitones(0, false)
  wasm._setFormantBase(0)
  const out = new Float32Array(Math.floor((seconds * SR) / BLOCK) * BLOCK)
  for (let at = 0; at < out.length; at += BLOCK) {
    const heap = new Float32Array(wasm.HEAP8.buffer) // re-read each block: memory may grow
    const inp = ptr / 4
    for (let i = 0; i < BLOCK; i++) heap[inp + i] = 0.3 * Math.sin((2 * Math.PI * hz * (at + i)) / SR)
    wasm._process(BLOCK, BLOCK)
    out.set(new Float32Array(wasm.HEAP8.buffer).subarray(inp + BLOCK, inp + 2 * BLOCK), at)
  }
  return out
}

/** The strongest frequency near `expect`: a Hann window, a coarse Goertzel scan, then a golden-section search. */
function peakHz(d: Float32Array, expect: number): number {
  const n = d.length
  const w = d.map((x, i) => x * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))))
  const power = (f: number) => {
    const c = 2 * Math.cos((2 * Math.PI * f) / SR)
    let s1 = 0
    let s2 = 0
    for (let i = 0; i < n; i++) {
      const s0 = w[i] + c * s1 - s2
      s2 = s1
      s1 = s0
    }
    return s1 * s1 + s2 * s2 - c * s1 * s2
  }
  let best = -1
  let at = expect
  for (let f = expect - 8; f <= expect + 8; f += 0.25) {
    const p = power(f)
    if (p > best) [best, at] = [p, f]
  }
  let lo = at - 0.25
  let hi = at + 0.25
  for (let k = 0; k < 25; k++) {
    const a = lo + (hi - lo) * 0.382
    const b = lo + (hi - lo) * 0.618
    if (power(a) > power(b)) hi = b
    else lo = a
  }
  return (lo + hi) / 2
}

function centsOff(wasm: StretchWasm, hz: number, semitones: number): number {
  const out = render(wasm, hz, semitones, 2.75)
  const expect = hz * 2 ** (semitones / 12)
  // 1.25 s of settled output, well past the stretch's latency.
  return 1200 * Math.log2(peakHz(out.subarray(1.5 * SR, 2.75 * SR), expect) / expect)
}

describe('key lock pitch (vendored Signalsmith Stretch)', () => {
  // -2 is Key sync's own limit in Mix Assist; -1.33 / -0.3 / +2 are the ROADMAP cases. 60 Hz at -2 is the worst found on 07/10 (-4.9).
  const freqs = [50, 60, 100, 440]
  const shifts = [-2, -1.33, -0.3, 2]

  it('every shifted note from 50 Hz up lands within 5 cents of where it should', async () => {
    const wasm = await loadWasm()
    const misses: string[] = []
    for (const s of shifts)
      for (const f of freqs) {
        const c = centsOff(wasm, f, s)
        if (!(Math.abs(c) < 5)) misses.push(`${f} Hz ${s > 0 ? '+' : ''}${s} st: ${c.toFixed(1)} cents`)
      }
    expect(misses, 'the npm 1.3.2 build gave 50 Hz -2 st +104 cents here; the fixed build stays under 5').toEqual([])
  }, 60_000)

  it('the measurement itself is honest: no shift means the exact note comes back', async () => {
    const wasm = await loadWasm()
    expect(Math.abs(centsOff(wasm, 50, 0))).toBeLessThan(0.5)
  }, 60_000)
})
