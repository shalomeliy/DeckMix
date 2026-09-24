export type Cancel = () => void

/**
 * The single time authority.
 *
 * DJ software classically goes wrong by having several clocks that disagree —
 * the audio context, `performance.now()`, the render loop, incoming MIDI clock.
 * Every sync, quantize, beat-jump and beat-timed effect has to derive from one
 * source or they drift apart under load.
 *
 * Today: one implementation over `audioContext.currentTime`. A network tempo-
 * sync clock (v0.19) drops in underneath without a single consumer changing.
 */
export interface Clock {
  /** seconds, monotonic */
  now(): number
  readonly source: 'audio' | 'link' | 'midi' | 'system'
  /** run `fn` once at `atSec` on this clock's timeline */
  schedule(atSec: number, fn: () => void): Cancel
  /** per-frame tick; drives useRenderLoop */
  subscribe(onTick: (t: number) => void): Cancel
}
