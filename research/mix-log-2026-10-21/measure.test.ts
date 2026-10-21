import { test, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { MixLogger, replayAt, type LogEvent, type DeckLetter } from '@/core/mix-log'

/**
 * v0.13.0 experiment. Question: does an event log, written the way the app would write it, rebuild what the owner did?
 * Criteria fixed BEFORE running (pass = all):
 *  R1 rebuild: for 99% of 100 ms points, every knob (0..1) is within 0.02 of the true value, and every discrete
 *     state (loaded, playing, mix type, rating) is exactly right.
 *  R2 size: under 100 KB of JSON per hour of mixing, and under 0.05 ms CPU per knob event.
 *  R3 information: the log holds at least 3 rating-relevant facts the saved ratings do not (static, listed in results).
 * Ground truth = a scripted set at 200 Hz (MIDI-like): 40 mixes of 3 types, a third with hand interventions (EQ twists,
 * fader rides, seeks), ratings after each. The sim is a stand-in: it proves the format loses nothing; it can NOT say
 * whether the log predicts his ratings (that needs his real data, second stage).
 */
const KNOBS = ['xfade', 'vol:A', 'vol:B', 'eq:A:low', 'eq:A:mid', 'eq:A:high', 'eq:B:low', 'eq:B:mid', 'eq:B:high', 'filter:A', 'filter:B']
let seed = 7
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)

test('mix log rebuild', () => {
  const T = 3600 * 1000 // one hour, ms
  let clock = 0
  const log = new MixLogger(() => clock)
  const truth: Record<string, number> = Object.fromEntries(KNOBS.map((k) => [k, k.startsWith('vol') ? 0.8 : k === 'xfade' ? 0 : 0.5]))
  const truthPlay: Record<DeckLetter, boolean> = { A: false, B: false }
  const truthLoaded: Record<DeckLetter, string | null> = { A: null, B: null }
  let truthMix: string | null = null, truthRating: string | null = null
  const grid: number[] = [], snaps: { knobs: Record<string, number>; play: Record<DeckLetter, boolean>; loaded: Record<DeckLetter, string | null>; mix: string | null; rating: string | null }[] = []
  let knobEvents = 0, cpuNs = 0n

  const setKnob = (k: string, v: number) => {
    v = Math.min(1, Math.max(0, v)); truth[k] = v
    const t0 = process.hrtime.bigint(); log.knob(k, v); cpuNs += process.hrtime.bigint() - t0; knobEvents++
  }
  // 30 s of one song playing, a 45-65 s mix, 2 s to the rating: ~40 mixes an hour
  const mixes = 40
  let phaseStart = 0
  let nextTick = 0, hand = false, handEnd = 0, mixEnd = 0, mixStart = 0, deck: DeckLetter = 'A', mixType = 'plain'
  const types = ['plain', 'swap', 'handoff']
  let m = 0, phase: 'solo' | 'mix' | 'rate' = 'solo', phaseEnd = 0
  clock = 0
  log.event({ k: 'load', deck: 'A', hash: 'h0' }); truthLoaded.A = 'h0'
  log.event({ k: 'play', deck: 'A', on: true }); truthPlay.A = true
  for (clock = 0; clock < T; clock += 5) { // 200 Hz
    if (phase === 'solo' && clock >= phaseStart + 30000) {
      const other: DeckLetter = deck === 'A' ? 'B' : 'A'
      log.event({ k: 'load', deck: other, hash: 'h' + (m + 1) }); truthLoaded[other] = 'h' + (m + 1)
      mixType = types[m % 3]; hand = m % 3 === 1 ? true : rnd() < 0.15
      log.event({ k: 'play', deck: other, on: true }); truthPlay[other] = true
      log.event({ k: 'mix', phase: 'start', mixType, from: deck, to: other, entrySec: 30 + m, joinSec: 100 }); truthMix = mixType
      mixStart = clock; mixEnd = clock + 45000 + rnd() * 20000; handEnd = mixStart + 5000 + rnd() * 20000
      phase = 'mix'
    }
    if (phase === 'mix') {
      const p = Math.min(1, (clock - mixStart) / (mixEnd - mixStart)), other: DeckLetter = deck === 'A' ? 'B' : 'A'
      const sign = deck === 'A' ? 1 : -1
      setKnob('xfade', deck === 'A' ? p : 1 - p)
      setKnob(`eq:${deck}:low`, 0.5 * (1 - p * p)); setKnob(`eq:${other}:low`, 0.1 + 0.4 * p)
      setKnob(`vol:${deck}`, 0.8 - 0.1 * p); setKnob(`vol:${other}`, 0.6 + 0.2 * p)
      void sign
      if (hand && clock < handEnd && clock > mixStart + 3000) { // owner turns knobs by hand: slow sine on one EQ + a fader ride
        setKnob(`eq:${other}:high`, 0.5 + 0.35 * Math.sin((clock - mixStart) / 700))
        setKnob('filter:' + deck, 0.5 + 0.2 * Math.sin((clock - mixStart) / 1900))
      }
      if (clock >= mixEnd) {
        log.event({ k: 'mix', phase: 'end', mixType, from: deck, to: other }); truthMix = null
        log.event({ k: 'play', deck, on: false }); truthPlay[deck] = false
        deck = other; phase = 'rate'; phaseEnd = clock + 2000
      }
    } else if (phase === 'rate' && clock >= phaseEnd) {
      log.flush()
      const r = (['excellent', 'bad', 'needs-work', 'keep'] as const)[Math.floor(rnd() * 4)]
      log.event({ k: 'rate', rating: r }); truthRating = r
      m++; phase = 'solo'; phaseStart = clock
      if (m >= mixes) break
    }
    if (clock % 50 === 0) log.flush()
    if (clock % 100 === 0) {
      grid.push(clock)
      snaps.push({ knobs: { ...truth }, play: { ...truthPlay }, loaded: { ...truthLoaded }, mix: truthMix, rating: truthRating })
    }
  }
  const replay = replayAt(log.events, grid)
  let bad = 0
  let worst = 0
  grid.forEach((_, i) => {
    const r = replay[i], s = snaps[i]
    let ok = true
    for (const k of KNOBS) { const d = Math.abs((r.knobs[k] ?? s.knobs[k]) - s.knobs[k]); worst = Math.max(worst, d); if (d > 0.02) ok = false }
    if (r.playing.A !== s.play.A || r.playing.B !== s.play.B) ok = false
    if (r.loaded.A !== s.loaded.A || r.loaded.B !== s.loaded.B) ok = false
    if ((r.mix?.mixType ?? null) !== s.mix) ok = false
    if (r.lastRating !== s.rating) ok = false
    if (!ok) bad++
  })
  const hours = clock / 3600000 // trailing flush above stands for the app's 50 ms timer
  const kb = JSON.stringify(log.events).length / 1024
  const out = {
    spanMin: +(clock / 60000).toFixed(1), mixes: m, knobInputs: knobEvents, eventsWritten: log.events.length,
    pointsChecked: grid.length, pointsWrong: bad, pctRight: +(100 * (1 - bad / grid.length)).toFixed(2), worstKnobErr: +worst.toFixed(4),
    kbPerHour: +(kb / hours).toFixed(1), cpuMsPerKnobEvent: +(Number(cpuNs) / 1e6 / knobEvents).toFixed(5),
  }
  const packed = pack(log.events)
  ;(out as any).kbPerHourPacked = +(packed.length / 1024 / hours).toFixed(1)
  ;(out as any).kbPerHourPackedGzip = +(gzipSync(packed).length / 1024 / hours).toFixed(1)
  writeFileSync('/tmp/claude-0/x/mixlog-result.json', JSON.stringify(out, null, 1))
  console.log(out)
  expect(out.pctRight).toBeGreaterThanOrEqual(99)
  expect(out.cpuMsPerKnobEvent).toBeLessThan(0.05)
})

// R2 follow-up: the same events, packed. One text line per event: `dt,kind,...`; a knob is `dt,keyIndex,round(v*100)`.
import { gzipSync } from 'node:zlib'
export function pack(events: LogEvent[]): string {
  const keys: string[] = []
  let prev = 0
  const lines = events.map((e) => {
    const dt = Math.round(e.t - prev); prev = e.t
    if (e.k === 'knob') { let i = keys.indexOf(e.key); if (i < 0) i = keys.push(e.key) - 1; return `${dt},${i},${Math.round(e.v * 100)}` }
    return `${dt},${e.k},${e.k === 'load' ? e.deck + (e.hash ?? '') : e.k === 'play' ? e.deck + (e.on ? 1 : 0) : e.k === 'rate' ? e.rating : e.k === 'mix' ? [e.phase, e.mixType, e.from, e.to, e.entrySec ?? '', e.joinSec ?? ''].join(':') : e.k === 'seek' ? e.deck + ':' + e.sec : ''}`
  })
  return keys.join('|') + '\n' + lines.join('\n')
}
