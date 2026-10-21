/**
 * Event log of what the owner does while mixing (v0.13.0 experiment). Pure: the clock is passed in, nothing here touches the
 * browser, so the same code runs in the app, in a Node test, and later in the Tauri build.
 *
 * Why events and not video: the screen is a function of the app's state and the sound is a function of the state plus the
 * files, so a log of state changes rebuilds both exactly; a recording of the screen would have to be read back with vision
 * (slow, unreliable, huge) to recover numbers the app already had. See docs/handoff/v0.13.0.md.
 *
 * Knobs (faders, EQ, filter) are coalesced: a value is written only when it moved by at least `DEADBAND` since the last
 * written one and at least `MIN_GAP_MS` passed, and the newest suppressed value is written by `flush` once the gap is
 * over — so a knob that stops moving always ends with its true value in the log, never one 40 ms stale.
 */
export type DeckLetter = 'A' | 'B'

export type LogEvent =
  | { t: number; k: 'knob'; key: string; v: number }
  | { t: number; k: 'load'; deck: DeckLetter; hash: string | null }
  | { t: number; k: 'play'; deck: DeckLetter; on: boolean }
  | { t: number; k: 'seek'; deck: DeckLetter; sec: number; byHand: boolean }
  | { t: number; k: 'mix'; phase: 'start' | 'end' | 'cancel'; mixType: string; from: DeckLetter; to: DeckLetter; entrySec?: number; joinSec?: number }
  | { t: number; k: 'rate'; rating: 'bad' | 'needs-work' | 'excellent' | 'keep' | 'remove-excellent' }

/** A written knob value changes by at least this (all knobs are normalised to 0..1 by the caller). */
export const DEADBAND = 0.01
/** A knob is written at most this often. MIDI sends ~100-200 values a second; a hand turns a knob well inside 20 Hz. */
export const MIN_GAP_MS = 50

type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never

export class MixLogger {
  readonly events: LogEvent[] = []
  private lastWritten = new Map<string, { t: number; v: number }>()
  /** Held-back values: the newest input and when it arrived, so `flush` can tell a knob that stopped from one still moving. */
  private pending = new Map<string, { v: number; inputT: number }>()
  private readonly now: () => number
  constructor(now: () => number) {
    this.now = now
  }

  knob(key: string, v: number): void {
    const t = this.now()
    const last = this.lastWritten.get(key)
    if (!last) return this.writeKnob(key, v, t)
    if (v === last.v) {
      this.pending.delete(key)
    } else if (Math.abs(v - last.v) >= DEADBAND && t - last.t >= MIN_GAP_MS) {
      return this.writeKnob(key, v, t)
    } else {
      this.pending.set(key, { v, inputT: t })
    }
  }

  /**
   * Writes a held-back value in two cases: it moved a full deadband and the gap is over (a fast knob), or the knob has been
   * still for a gap (it stopped, so the log must end on where it stopped, however small the last step). Without the second
   * case a slow drift would end up stale; without the "still" test every tiny wobble would be written once per flush.
   */
  flush(): void {
    const t = this.now()
    for (const [key, p] of this.pending) {
      const last = this.lastWritten.get(key)
      const fast = !last || (Math.abs(p.v - last.v) >= DEADBAND && t - last.t >= MIN_GAP_MS)
      if (fast || t - p.inputT >= MIN_GAP_MS) this.writeKnob(key, p.v, t)
    }
  }

  event(e: DistributiveOmit<Exclude<LogEvent, { k: 'knob' }>, 't'>): void {
    this.events.push({ ...e, t: this.now() } as LogEvent)
  }

  private writeKnob(key: string, v: number, t: number): void {
    this.events.push({ t, k: 'knob', key, v })
    this.lastWritten.set(key, { t, v })
    this.pending.delete(key)
  }
}

export interface ReplayState {
  knobs: Record<string, number>
  playing: Record<DeckLetter, boolean>
  loaded: Record<DeckLetter, string | null>
  mix: { mixType: string; from: DeckLetter; to: DeckLetter } | null
  lastRating: string | null
}

/** The state at each time in `times` (ascending), rebuilt from the events alone. One sweep, so a long session stays cheap. */
export function replayAt(events: readonly LogEvent[], times: readonly number[]): ReplayState[] {
  const s: ReplayState = { knobs: {}, playing: { A: false, B: false }, loaded: { A: null, B: null }, mix: null, lastRating: null }
  const out: ReplayState[] = []
  let i = 0
  for (const t of times) {
    for (; i < events.length && events[i].t <= t; i++) {
      const e = events[i]
      if (e.k === 'knob') s.knobs[e.key] = e.v
      else if (e.k === 'play') s.playing[e.deck] = e.on
      else if (e.k === 'load') s.loaded[e.deck] = e.hash
      else if (e.k === 'mix') s.mix = e.phase === 'start' ? { mixType: e.mixType, from: e.from, to: e.to } : null
      else if (e.k === 'rate') s.lastRating = e.rating
    }
    out.push({ ...s, knobs: { ...s.knobs }, playing: { ...s.playing }, loaded: { ...s.loaded } })
  }
  return out
}
