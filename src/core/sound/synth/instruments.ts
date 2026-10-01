/**
 * The sound sources of the training-mix generator (v0.12.15), written from textbook synthesis:
 * a sine sweep for the kick, filtered noise for snare and hats, a filtered sawtooth for the bass,
 * detuned sawtooths for the pad (docs/research/stems-and-sound-understanding.md §5.3, §8.2 route 2).
 * Nothing here is sampled from any recording — that is the point: the output is ours to train on.
 * Every function ADDS into a buffer at a sample offset, so notes can overlap.
 */
import { type Rng } from '@/core/sound/synth/rng'

const TWO_PI = Math.PI * 2
const lpCoef = (fc: number, sr: number): number => 1 - Math.exp((-TWO_PI * fc) / sr)

/** Length of `want` samples starting at `at`, clipped to the buffer (0 when `at` is past the end). */
const room = (buf: Float32Array, at: number, want: number): number => Math.max(0, Math.min(want, buf.length - at))

export function addKick(buf: Float32Array, at: number, sr: number, gain: number): void {
  const n = room(buf, at, Math.floor(0.3 * sr))
  let phase = 0
  const click = Math.floor(0.002 * sr)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    phase += (TWO_PI * (45 + 105 * Math.exp(-t * 28))) / sr
    // A 2 ms ramp stops the click that a sine starting at full level would make.
    buf[at + i] += gain * Math.sin(phase) * Math.exp(-t * 11) * (i < click ? i / click : 1)
  }
}

export function addSnare(buf: Float32Array, at: number, sr: number, r: Rng, gain: number): void {
  const n = room(buf, at, Math.floor(0.25 * sr))
  let lp = 0
  const a = lpCoef(2500, sr)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const noise = r() * 2 - 1
    lp += a * (noise - lp)
    const body = Math.sin(TWO_PI * 190 * t) * Math.exp(-t * 28) * 0.5
    buf[at + i] += gain * (body + (noise - lp) * Math.exp(-t * 17))
  }
}

/** Three quick noise bursts and a tail — what a clap is, acoustically. */
export function addClap(buf: Float32Array, at: number, sr: number, r: Rng, gain: number): void {
  const n = room(buf, at, Math.floor(0.22 * sr))
  let lp = 0
  const a = lpCoef(1200, sr)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const noise = r() * 2 - 1
    lp += a * (noise - lp)
    const burst = t < 0.036 ? Math.exp(-((t % 0.012) * 260)) : 0
    buf[at + i] += gain * (noise - lp) * (burst * 0.7 + Math.exp(-t * 20) * 0.5)
  }
}

export function addHat(buf: Float32Array, at: number, sr: number, r: Rng, gain: number, open: boolean): void {
  const n = room(buf, at, Math.floor((open ? 0.3 : 0.05) * sr))
  let prev = 0
  for (let i = 0; i < n; i++) {
    const noise = r() * 2 - 1
    const hp = noise - prev // first difference: a high-pass that leaves the top of the spectrum
    prev = noise
    buf[at + i] += gain * hp * 0.5 * Math.exp((-i / sr) * (open ? 22 : 110))
  }
}

export function addBass(buf: Float32Array, at: number, dur: number, hz: number, sr: number, gain: number): void {
  const n = room(buf, at, Math.floor(dur * sr))
  const a = lpCoef(520, sr)
  const att = Math.floor(0.005 * sr)
  const rel = Math.floor(0.02 * sr)
  let phase = 0
  let lp = 0
  for (let i = 0; i < n; i++) {
    phase += hz / sr
    const saw = 2 * (phase % 1) - 1
    lp += a * (saw - lp)
    const env = Math.min(1, i / att) * Math.min(1, (n - i) / rel) * Math.exp((-i / sr) * 3)
    buf[at + i] += gain * env * (lp * 0.8 + Math.sin(TWO_PI * phase) * 0.5)
  }
}

/** One chord into a stereo pair: each side gets its own detune set, so the pad has width. */
export function addPad(
  left: Float32Array,
  right: Float32Array,
  at: number,
  dur: number,
  hzs: readonly number[],
  sr: number,
  gain: number,
): void {
  const n = room(left, at, Math.floor(dur * sr))
  const a = lpCoef(1800, sr)
  const att = Math.floor(0.4 * sr)
  const rel = Math.floor(0.5 * sr)
  const sides: [Float32Array, readonly number[]][] = [
    [left, [-9, -3, 4]],
    [right, [-4, 3, 9]],
  ]
  for (const [out, detunes] of sides) {
    let lp = 0
    // Phase steps are fixed for the whole chord — computing them per sample cost more than the rest of the mix.
    const steps = hzs.flatMap((hz) => detunes.map((cents) => (hz * Math.pow(2, cents / 1200)) / sr))
    const phases = steps.map(() => 0)
    for (let i = 0; i < n; i++) {
      let s = 0
      for (let k = 0; k < steps.length; k++) {
        phases[k] += steps[k]
        s += 2 * (phases[k] % 1) - 1
      }
      lp += a * (s - lp)
      out[at + i] += gain * lp * Math.min(1, i / att) * Math.min(1, (n - i) / rel)
    }
  }
}

/**
 * A lead line: two detuned sawtooths through a low-pass, gliding from the previous pitch and, once the note has
 * settled, with vibrato. It is here on purpose as a HARD NEGATIVE — it moves its pitch like a voice does, so a
 * "pitch instability means voice" shortcut gets punished instead of rewarded (round 2's feature `fluct`).
 */
export function addLead(
  left: Float32Array,
  right: Float32Array,
  at: number,
  dur: number,
  hz: number,
  fromHz: number,
  sr: number,
  gain: number,
  pan: number,
  vibratoCents: number,
): void {
  const n = room(left, at, Math.floor(dur * sr))
  const a = lpCoef(3200, sr)
  const glide = Math.floor(0.06 * sr)
  const rel = Math.floor(0.04 * sr)
  const gl = Math.cos(((pan + 1) * Math.PI) / 4)
  const gr = Math.sin(((pan + 1) * Math.PI) / 4)
  let p1 = 0
  let p2 = 0
  let lp = 0
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const base = i < glide ? fromHz + (hz - fromHz) * (i / glide) : hz
    const vib = t > 0.15 ? Math.pow(2, (vibratoCents * Math.sin(TWO_PI * 5.5 * t)) / 1200) : 1
    const f = base * vib
    p1 += f / sr
    p2 += (f * 1.004) / sr
    lp += a * (2 * (p1 % 1) - 1 + (2 * (p2 % 1) - 1) - lp)
    const v = gain * lp * Math.min(1, i / (0.01 * sr)) * Math.min(1, (n - i) / rel)
    left[at + i] += v * gl
    right[at + i] += v * gr
  }
}
