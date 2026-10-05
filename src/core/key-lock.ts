/**
 * Key lock (v0.9.20, "master tempo"): the tempo fader changes the speed, and the song keeps its own pitch.
 *
 * The deck keeps playing at the fader's rate — which raises the pitch by the same factor, as a record does — and the stretch
 * (`platform/audio-webaudio/keylock.ts`, the owner's choice of the small free Signalsmith library, 05/10) transposes the result back by
 * exactly that much. A rate of 1.08 is 1.33 semitones up, so the stretch is told −1.33. Pure.
 */
export function keyLockSemitones(rate: number): number {
  if (!(rate > 0)) return 0
  return -12 * Math.log2(rate)
}
