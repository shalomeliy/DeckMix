/**
 * A 4/4 dance arrangement, written as code (v0.12.15; research §8.2 route 2). Drums, bass and
 * pad come and go in 8-bar blocks, so the training set contains drums alone, pad alone and
 * every combination — the cases where a naive "is there a voice" score is most often wrong.
 * Returns the three instrument groups as separate stereo stems, because a future separator
 * is trained on stems and the vocal classifier needs the instrumental level for its labels.
 */
import { addBass, addClap, addHat, addKick, addLead, addPad, addSnare } from '@/core/sound/synth/instruments'
import { chance, createRng, dbToGain, pick, uniform, type Rng } from '@/core/sound/synth/rng'

export type Stereo = [Float32Array, Float32Array]

export interface Instrumental {
  bpm: number
  /** e.g. "A minor" — recorded in the manifest so a bad mix can be traced. */
  key: string
  drums: Stereo
  bass: Stereo
  other: Stereo
}

export interface ArrangeOptions {
  sampleRate: number
  bars: number
  /** Fixed tempo; otherwise drawn from 118–140, the range the owner's dance library lives in. */
  bpm?: number
  /** Add a gliding, vibrato lead in some blocks (round 3). Off by default so older seeds render as they did. */
  lead?: boolean
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const MINOR = [0, 2, 3, 5, 7, 8, 10]
const MAJOR = [0, 2, 4, 5, 7, 9, 11]
const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12)
const BLOCK_BARS = 8

function pan(l: Float32Array, rt: Float32Array, at: number, src: Float32Array, p: number): void {
  // Equal-power pan, p in [-1, 1].
  const gl = Math.cos(((p + 1) * Math.PI) / 4)
  const gr = Math.sin(((p + 1) * Math.PI) / 4)
  for (let i = 0; i < src.length && at + i < l.length; i++) {
    l[at + i] += src[i] * gl
    rt[at + i] += src[i] * gr
  }
}

export function renderInstrumental(seed: number, opts: ArrangeOptions): Instrumental {
  const r = createRng(seed)
  const sr = opts.sampleRate
  const bpm = opts.bpm ?? Math.round(uniform(r, 118, 140))
  const beat = (60 / bpm) * sr
  const bar = beat * 4
  const len = Math.ceil(bar * opts.bars)
  const mk = (): Stereo => [new Float32Array(len), new Float32Array(len)]
  const drums = mk()
  const bass = mk()
  const other = mk()

  const minor = chance(r, 0.65)
  const scale = minor ? MINOR : MAJOR
  const root = Math.floor(uniform(r, 0, 12))
  const key = `${NOTE_NAMES[root]} ${minor ? 'minor' : 'major'}`
  const degrees = [0, ...Array.from({ length: 3 }, () => pick(r, [0, 2, 3, 4, 5, 6]))]
  const bassStyle = pick(r, ['offbeat', 'rolling', 'long'] as const)
  const kickStyle = chance(r, 0.75) ? 'four' : 'broken'
  const useClap = chance(r, 0.5)
  const hatPan = uniform(r, -0.35, 0.35)
  const level = (db: number): number => dbToGain(db + uniform(r, -3, 3))
  const gKick = level(-1)
  const gSnare = level(-5)
  const gHat = level(-13)
  const gBass = level(-6)
  const gPad = level(-18)

  // The lead draws from its own stream: switching it on must not move a single drum hit.
  const leadRng = opts.lead ? createRng(seed ^ 0x51ed270b) : null
  const leadBlocks = new Set<number>()
  if (leadRng) for (let b = 0; b < Math.ceil(opts.bars / BLOCK_BARS); b++) if (chance(leadRng, 0.5)) leadBlocks.add(b)
  const gLead = leadRng ? dbToGain(-15 + uniform(leadRng, -3, 3)) : 0
  const leadPan = leadRng ? uniform(leadRng, -0.4, 0.4) : 0
  const leadVibrato = leadRng ? uniform(leadRng, 10, 35) : 0

  const scratch = new Float32Array(Math.ceil(beat * 2))
  const hit = (fn: (b: Float32Array) => void, at: number, p: number): void => {
    scratch.fill(0)
    fn(scratch)
    pan(drums[0], drums[1], at, scratch, p)
  }

  let flags = { drums: true, bass: false, pad: true }
  for (let b = 0; b < opts.bars; b += BLOCK_BARS) {
    flags =
      b === 0
        ? pick(r, [
            { drums: false, bass: false, pad: true },
            { drums: true, bass: false, pad: true },
            { drums: true, bass: false, pad: false },
          ])
        : nextFlags(r)
    const barsHere = Math.min(BLOCK_BARS, opts.bars - b)
    for (let k = 0; k < barsHere; k++) {
      const barStart = Math.round((b + k) * bar)
      const chordRoot = 36 + root + scale[degrees[Math.floor(k / 2) % degrees.length] % 7]
      if (flags.drums) drumBar(r, barStart, beat, sr, { kickStyle, useClap, hatPan, gKick, gSnare, gHat }, hit)
      if (flags.bass) bassBar(bass, barStart, beat, sr, bassStyle, midiHz(chordRoot), gBass)
      if (leadRng && leadBlocks.has(Math.floor((b + k) / BLOCK_BARS))) {
        let prev = midiHz(60 + root + scale[0])
        for (let q = 0; q < 8; q++) {
          if (!chance(leadRng, 0.7)) continue
          const hzNote = midiHz(60 + root + scale[Math.floor(uniform(leadRng, 0, 7))] + (chance(leadRng, 0.25) ? 12 : 0))
          addLead(other[0], other[1], Math.round(barStart + q * (beat / 2)), (beat * 0.9) / sr, hzNote, prev, sr, gLead, leadPan, leadVibrato)
          prev = hzNote
        }
      }
      if (flags.pad && k % 2 === 0) {
        const chord = [0, minor ? 3 : 4, 7].map((s) => midiHz(chordRoot + 12 + s))
        addPad(other[0], other[1], barStart, (bar * 2) / sr, chord, sr, gPad)
      }
    }
  }
  return { bpm, key, drums, bass, other }
}

function nextFlags(r: Rng): { drums: boolean; bass: boolean; pad: boolean } {
  for (;;) {
    const f = { drums: chance(r, 0.85), bass: chance(r, 0.8), pad: chance(r, 0.7) }
    if (f.drums || f.bass || f.pad) return f
  }
}

interface DrumStyle {
  kickStyle: 'four' | 'broken'
  useClap: boolean
  hatPan: number
  gKick: number
  gSnare: number
  gHat: number
}

function drumBar(
  r: Rng,
  barStart: number,
  beat: number,
  sr: number,
  s: DrumStyle,
  hit: (fn: (b: Float32Array) => void, at: number, p: number) => void,
): void {
  for (let q = 0; q < 4; q++) {
    const at = Math.round(barStart + q * beat)
    const kick = s.kickStyle === 'four' || q === 0 || (q === 2 && chance(r, 0.5)) || chance(r, 0.15)
    if (kick) hit((b) => addKick(b, 0, sr, s.gKick), at, 0)
    if (q === 1 || q === 3) {
      hit((b) => (s.useClap ? addClap(b, 0, sr, r, s.gSnare) : addSnare(b, 0, sr, r, s.gSnare)), at, 0)
    }
    // Off-beat open hat (the house backbeat), plus closed sixteenths on some bars.
    hit((b) => addHat(b, 0, sr, r, s.gHat, true), Math.round(at + beat / 2), s.hatPan)
    if (chance(r, 0.4)) {
      for (const f of [0.25, 0.75]) hit((b) => addHat(b, 0, sr, r, s.gHat * 0.7, false), Math.round(at + beat * f), -s.hatPan)
    }
  }
}

function bassBar(
  bass: Stereo,
  barStart: number,
  beat: number,
  sr: number,
  style: 'offbeat' | 'rolling' | 'long',
  hz: number,
  gain: number,
): void {
  const put = (at: number, dur: number, h: number): void => {
    addBass(bass[0], Math.round(at), dur, h, sr, gain)
    addBass(bass[1], Math.round(at), dur, h, sr, gain)
  }
  if (style === 'long') put(barStart, (beat * 3.6) / sr, hz)
  else if (style === 'offbeat') for (let q = 0; q < 4; q++) put(barStart + (q + 0.5) * beat, (beat * 0.4) / sr, hz)
  else for (let s16 = 0; s16 < 16; s16++) if (s16 % 4 !== 0) put(barStart + s16 * (beat / 4), (beat * 0.2) / sr, s16 % 8 === 6 ? hz * 2 : hz)
}
