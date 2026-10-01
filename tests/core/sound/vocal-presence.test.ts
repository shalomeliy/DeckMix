import { describe, expect, it } from 'vitest'
import { detectVocalTimeline } from '@/core/sound/vocal-presence.ts'
import { CELL_NONE, CELL_UNSURE, CELL_VOCAL } from '@/core/sound/vocal-timeline.ts'
import type { PcmData } from '@/core/ports/analyzer'

const SR = 22050
const SECONDS = 40

/** A synthetic "singer": a harmonic tone with vibrato and a 5 Hz syllable envelope, panned to the centre. */
function voiceAt(t: number): number {
  const f0 = 220 * (1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * t))
  let s = 0
  for (let h = 1; h <= 12; h++) s += Math.sin(2 * Math.PI * f0 * h * t) / h
  const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4.5 * t)
  return 0.25 * s * syllable
}
/** A steady pad: slow, wide, no syllables. */
function padAt(t: number, side: number): number {
  return side * 0.12 * (Math.sin(2 * Math.PI * 130.8 * t) + Math.sin(2 * Math.PI * 196 * t + 1) + 0.5 * Math.sin(2 * Math.PI * 261.6 * t))
}
/** A kick-like click every beat. */
function clickAt(i: number): number {
  const beat = Math.round(SR * 0.5)
  const k = i % beat
  return k < 400 ? 0.5 * Math.sin((2 * Math.PI * 60 * k) / SR) * Math.exp(-k / 120) : 0
}

function build(opts: { voice: boolean; stereo: boolean; seconds?: number; amp?: number }): PcmData {
  const n = Math.round(SR * (opts.seconds ?? SECONDS))
  const l = new Float32Array(n)
  const r = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const v = opts.voice ? voiceAt(t) : 0
    const click = clickAt(i)
    l[i] = (opts.amp ?? 1) * (v + click + padAt(t, 1))
    r[i] = (opts.amp ?? 1) * (v + click + padAt(t, -1)) // the pad is out of phase between channels: wide
  }
  return { channels: opts.stereo ? [l, r] : [l], sampleRate: SR }
}

const share = (cells: Uint8Array, v: number) => cells.reduce((n, c) => n + (c === v ? 1 : 0), 0) / cells.length

describe('detectVocalTimeline', () => {
  it('finds more voice in a centre-panned singer over a wide pad than in the pad alone', () => {
    // Relative, not "over 60%": the constants are unfitted (docs/handoff/v0.9.10.md — real songs scored ~51-70% on
    // the training clips), so this pins only the direction of the cues, never an accuracy the DSP has not earned.
    const voice = detectVocalTimeline(build({ voice: true, stereo: true }))
    const pad = detectVocalTimeline(build({ voice: false, stereo: true }))
    expect(voice.state).toBe('ready')
    expect(share(voice.timeline!.cells, CELL_VOCAL)).toBeGreaterThan(share(pad.timeline!.cells, CELL_VOCAL) + 0.2)
  })

  it('does not call a pad with clicks a voice — and says "no vocals", not "ready"', () => {
    const r = detectVocalTimeline(build({ voice: false, stereo: true }))
    expect(share(r.timeline!.cells, CELL_VOCAL)).toBeLessThan(0.2)
    expect(r.state).toBe('no-vocals')
  })

  it('names a mono file, and never draws it as confident', () => {
    const r = detectVocalTimeline(build({ voice: true, stereo: false }))
    expect(r.state).toBe('mono')
    expect(r.timeline!.stereo).toBe(false)
    expect(share(r.timeline!.cells, CELL_UNSURE) + share(r.timeline!.cells, CELL_NONE)).toBeGreaterThan(0)
  })

  it('treats two identical channels as mono', () => {
    const p = build({ voice: true, stereo: false })
    const r = detectVocalTimeline({ channels: [p.channels[0], p.channels[0].slice()], sampleRate: SR })
    expect(r.state).toBe('mono')
  })

  it('names a track that is too short', () => {
    expect(detectVocalTimeline(build({ voice: true, stereo: true, seconds: 10 })).state).toBe('too-short')
  })

  it('names silence', () => {
    const n = SR * SECONDS
    expect(detectVocalTimeline({ channels: [new Float32Array(n), new Float32Array(n)], sampleRate: SR }).state).toBe('silent')
  })

  it('names missing audio instead of throwing', () => {
    const r = detectVocalTimeline({ channels: [], sampleRate: SR })
    expect(r.state).toBe('failed')
    expect(r.timeline).toBeNull()
  })

  it('does not throw on a clipped or NaN-laced track', () => {
    const p = build({ voice: true, stereo: true })
    p.channels[0][1000] = NaN
    expect(() => detectVocalTimeline(p)).not.toThrow()
  })

  it('returns one cell per half second', () => {
    const r = detectVocalTimeline(build({ voice: true, stereo: true }))
    expect(r.timeline!.cells.length).toBe(Math.ceil(SECONDS / 0.5))
  })
})
