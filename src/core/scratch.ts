/**
 * Platter and playhead maths, kept out of the components so it can be tested.
 *
 * These lived inside `Platter.tsx` and `useRenderLoop.ts`, where nothing could
 * reach them: the first two bugs below were both found by reading the code in
 * v0.2.0's own plan and then never fixed, because there was no cheap way to
 * demonstrate them. Pure functions in `core/` are that way.
 */

/** One revolution of the platter equals this much audio at normal speed. */
export const SEC_PER_REV = 1.333

/** A flick should not command an absurd rate. */
export const MAX_RATE = 8

/**
 * Pointer samples are jittery, so the rate is smoothed. Low enough to follow a
 * fast scratch, high enough that a steady drag does not shimmer.
 */
export const SMOOTHING = 0.4

/**
 * Horizontal travel for one revolution, from the platter's own diameter: the
 * distance a finger covers going once around the rim. Scaling with size is the
 * point — a bigger platter should need more travel per revolution, exactly as a
 * bigger record does.
 */
export const pxPerRev = (platterSize: number): number => Math.PI * platterSize

/**
 * Drag distance → playback rate.
 *
 * **Horizontal travel, not swept angle.** The platter used `atan2`, which makes
 * the gain depend on where the platter was grabbed: on a 54px platter 1px near
 * the centre is 5.7° and 1px at the rim is 0.77° — a 7× difference in how hard
 * the same movement scratches, with nothing on screen to explain it. `Knob`
 * already drags in a straight line on a round control for this reason.
 *
 * `dtSec <= 0` and a non-positive `platterSize` return the previous rate rather
 * than dividing by zero: two pointer events can share a millisecond, and a
 * platter with no size is a caller bug that must not become an infinite rate.
 *
 * `secPerRev` and `smoothing` are parameters with defaults from v0.2.5, because
 * both became user settings (platter speed, jog smoothing). Taking them as data
 * is what keeps `core/` pure — and it is what keeps the mouse platter and the
 * hardware jog obeying the same two numbers. A setting that moved the wheel but
 * not the on-screen platter would be worse than no setting: it would look like
 * the mouse path was broken.
 */
export function scratchRateFromDrag(
  dxPx: number,
  dtSec: number,
  platterSize: number,
  prevRate: number,
  secPerRev: number = SEC_PER_REV,
  smoothing: number = SMOOTHING,
): number {
  if (dtSec <= 0 || platterSize <= 0) return prevRate
  const revs = dxPx / pxPerRev(platterSize)
  const instant = (revs * secPerRev) / dtSec
  const smoothed = prevRate + (instant - prevRate) * smoothing
  return Math.max(-MAX_RATE, Math.min(MAX_RATE, smoothed))
}

/**
 * Below this, a playhead move is not worth a store write and a re-render.
 * At normal speed a frame advances ~16ms of audio, so this filters noise only.
 */
export const POSITION_EPSILON_SEC = 0.001

/**
 * Whether the render loop should push a new playhead position to the store.
 *
 * The epsilon was absolute, and that froze the platter under a slow scratch:
 * at rate 0.05 the playhead moves 0.0008s per frame — under the threshold — so
 * the audio moved and the marker sat still, which reads as the scratch not
 * working at all. While a hand is on the platter every change is worth showing,
 * because the hand is asking for exactly this feedback.
 */
export function shouldPushPosition(
  positionSec: number,
  storedSec: number,
  scratching: boolean,
): boolean {
  return scratching
    ? positionSec !== storedSec
    : Math.abs(positionSec - storedSec) > POSITION_EPSILON_SEC
}

/**
 * Waveform drag → playback rate (v0.8.28).
 *
 * The waveform scrolls under a fixed playhead at `pxPerSec`, so a hand that grabs
 * it is holding the audio itself: dragging right pulls *earlier* audio under the
 * playhead, which is playback running backwards. Hence the minus sign — the
 * platter's drag-right-is-forward convention would make the picture slide the
 * opposite way to the hand, which reads as the drag being broken.
 *
 * One pixel is exactly `1 / pxPerSec` seconds of audio, the same scale the
 * waveform is drawn at, so the audio under the hand stays under the hand at any
 * zoom. Same smoothing, clamp and bad-`dt` guard as `scratchRateFromDrag`.
 */
export function waveformDragRate(
  dxPx: number,
  dtSec: number,
  pxPerSec: number,
  prevRate: number,
  smoothing: number = SMOOTHING,
): number {
  if (dtSec <= 0 || pxPerSec <= 0) return prevRate
  const instant = -dxPx / pxPerSec / dtSec
  const smoothed = prevRate + (instant - prevRate) * smoothing
  return Math.max(-MAX_RATE, Math.min(MAX_RATE, smoothed))
}

/** Pixels of `WheelEvent.deltaY` in one notch of an ordinary mouse wheel (Chromium, Windows and Mac). */
export const WHEEL_NOTCH_PX = 100

/**
 * Wheel events → whole steps, carrying the remainder (v0.8.28).
 *
 * A mouse notch arrives as one event of ~100px, but a touchpad sends a stream of
 * small deltas — 2px, 5px, 11px. Treating every event as one step would make a
 * light touchpad swipe fly the track across dozens of beats. Counting pixels and
 * spending them 100 at a time gives both the same feel per distance travelled.
 * `deltaMode` 1 is lines (Firefox-style, ~33px each), 2 is pages.
 */
export function wheelSteps(
  carryPx: number,
  deltaY: number,
  deltaMode: number = 0,
): { steps: number; carryPx: number } {
  const px = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * WHEEL_NOTCH_PX * 3 : deltaY
  // Turning back drops what was left over going forward; otherwise the first
  // notch back is partly spent cancelling it and the step feels uneven.
  const total = (Math.sign(carryPx) * Math.sign(px) < 0 ? 0 : carryPx) + px
  const steps = Math.trunc(total / WHEEL_NOTCH_PX)
  return { steps, carryPx: total - steps * WHEEL_NOTCH_PX }
}
