/** Tempo fader travel: fader value of 1 => +8% playback rate. */
export const TEMPO_RANGE = 0.08

/**
 * Pitch bend from a key press, as a fraction of playback rate.
 *
 * A key is either down or up, so unlike a jog wheel it carries no "how hard".
 * 4% is the size of a nudge that closes a small phase gap in a beat or two —
 * enough to be useful, small enough that holding it does not sound like a
 * tempo change.
 */
export const KEYBOARD_BEND = 0.04

/**
 * Platter diameter in CSS px.
 *
 * It shipped at 54, which is ~41px of grabbable face — about **11mm** on the
 * user's 157-PPI screen, where every CSS px is ~0.76 of its nominal size. That
 * is a control you aim at, not one you scratch with.
 *
 * **Floor: never ship an interactive platter below 120 CSS px.** 142 costs no
 * height: the deck's left column measures 178px and the right column already
 * stretches to match it, so 142 + 4 + the 32px Vinyl chip fills exactly the
 * space that was there.
 */
export const PLATTER_SIZE = 142

/** EQ gain in dB at the extremes of each band knob. */
export const EQ_DB = 26
/**
 * dB per unit of knob on the CUT side: −1 is −70 dB, a full kill, while the boost side stops at `EQ_DB`. One number shared by the engine
 * (`deck.ts`) and the automatic EQ mix (`core/eq-mix.ts`), whose gradual bass swap computes its curve in dB — two copies would let the
 * curve drift from what the knob really does.
 */
export const EQ_CUT_DB = 70

/** Kill-ish behaviour: below this knob value the band is fully cut. */
export const EQ_LOW_HZ = 100
export const EQ_MID_HZ = 1000
export const EQ_HIGH_HZ = 6000

export const HOT_CUE_COLORS = [
  '#ff3b6b',
  '#ff8f29',
  '#ffd23b',
  '#3bff88',
  '#29c5ff',
  '#6b7bff',
  '#b14bff',
  '#ff5cf0',
]

/**
 * Tempo fader value (-1..1) -> playback rate.
 *
 * The range is a parameter with a default rather than a captured import: it is
 * a user setting from v0.2.5 on, and `core/` takes settings as data. Callers
 * that have the live value pass it; `recommend` and the tests use the default.
 */
export function tempoToRate(tempo: number, range: number = TEMPO_RANGE): number {
  return 1 + tempo * range
}

/**
 * A deck's playback rate: the speed saved for its track ("Save tempo", v0.9.47 — the fader's centre) times the fader. Every speed sum goes
 * through here or `centreBpm`; a site that used `tempoToRate` alone would count a saved 138 as the file's 150 and SYNC it 8% off.
 */
export function deckRate(baseRate: number, tempo: number, range: number = TEMPO_RANGE): number {
  return baseRate * tempoToRate(tempo, range)
}

/** The BPM a deck plays at with its fader in the middle: the file's count at the saved speed (v0.9.47). */
export function centreBpm(bpm: number, baseRate: number): number {
  return bpm * baseRate
}

/** A saved speed as the owner reads it: 0.92 -> "-8.0%". */
export function speedPercent(rate: number): string {
  const pct = (rate - 1) * 100
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`
}

/**
 * The BPM a library row shows, and what its search, filter, sort and the mix suggestions use (v0.9.47): the file's count times the speed
 * the owner saved for it. Shalom saved a slower speed and the row went on saying 150 — every reader of the row has to agree with it.
 */
export function rowBpm(t: { bpm?: number; playRate?: number }): number | undefined {
  return t.bpm == null ? undefined : t.bpm * (t.playRate ?? 1)
}

/**
 * Tempo fader value that makes a deck (native `deckBpm`) play at the same
 * *audible* speed as the master. The master's audible BPM is its native BPM
 * times its own tempo rate — matching its native BPM alone left a deck 6 BPM off
 * whenever the master's fader was not at zero (every second Mix Assist
 * transition, since the previous incoming deck stays tempo-shifted), and the
 * phase-sync loop then bent pitch every second trying to close a gap that a
 * tempo mismatch can never close.
 */
export function syncTempoFor(
  masterBpm: number,
  masterTempo: number,
  deckBpm: number,
  range: number = TEMPO_RANGE,
): number {
  const targetBpm = masterBpm * tempoToRate(masterTempo, range)
  return (targetBpm / (deckBpm * syncMultiplier(targetBpm, deckBpm, range)) - 1) / range
}

/**
 * The reading SYNC uses: straight whenever the fader can reach the target —
 * so no pair that synced before v0.8.36 changes (at ±50%, a 140 under a 100
 * would otherwise jump to double-time, and swapping which deck is master would
 * change the answer) — and half/double only where straight is out of reach.
 * `targetBpm` is the master's *playing* BPM, the same number `syncTempoFor` aims at.
 */
export function syncMultiplier(targetBpm: number, deckBpm: number, range: number = TEMPO_RANGE): 0.5 | 1 | 2 {
  if (Math.abs(targetBpm / deckBpm - 1) <= range) return 1
  return halfDoubleMultiplier(targetBpm, deckBpm)
}

/**
 * Whether a deck plays against the master straight (1), half-time (2: an 85
 * under a 170) or double-time (0.5) — whichever reading of `deckBpm` sits
 * nearest `masterBpm`. The same three readings `recommend.ts` already offers
 * a track under (its "half-time" chip); v0.8.36 made SYNC honour them too.
 * Before, SYNC asked an 85 to reach 170 — a +100% fader the ±8% range clamps
 * to 91.8 — so a pair Mix Assist had just suggested never locked, and the
 * phase loop then corrected a half-beat it read as error, forever.
 */
export function halfDoubleMultiplier(masterBpm: number, deckBpm: number): 0.5 | 1 | 2 {
  let best: 0.5 | 1 | 2 = 1
  let bestErr = Math.abs(deckBpm - masterBpm)
  for (const m of [2, 0.5] as const) {
    const err = Math.abs(deckBpm * m - masterBpm)
    if (err < bestErr) {
      best = m
      bestErr = err
    }
  }
  return best
}

// ————————————————————————————————————————————————————————————————
// Defaults the user may override from the Settings screen (v0.2.5)
//
// These moved here from the modules that used them — `controls.ts`, the deck
// backend, the waveform component. Not tidying: a settable value needs exactly
// one default, and while each lived beside its consumer the schema in
// `core/settings.ts` would have had to restate it. Two numbers for one fact is
// how the engine ends up using a value the screen never showed.
//
// The calibration constants deliberately did **not** move. `DECLICK_SEC`,
// `SILENT_BELOW_RATE`, `ANCHOR_EVERY_QUANTA`, `STANDSTILL`, `HOLD_TIMEOUT_MS`,
// `JOG_REPORT_MS`, `QUIET`, `POSITION_EPSILON_SEC` and `PLATTER_SIZE` stay
// beside the code they calibrate, because each one pins a bug that is already
// fixed — they are not preferences, and a control for one is a polite way to
// let the user break the app for themselves.
// ————————————————————————————————————————————————————————————————

/**
 * Encoder ticks in one full turn of the jog wheel.
 *
 * A property of the controller, not of the software, which is why it is
 * settable at all — and **measured, at last, on 2026-08-30**: 713 · 715 · 710
 * from the Measure button on the owner's FLX4, mean 712.67, spread 5 ticks.
 *
 * The three hand counts it replaces were 696 · 673 · 669, a spread of 27, and
 * every one of them a lower bound: counting revolutions by hand undercounts,
 * and the wheel was driving the deck while being counted. The Measure button
 * intercepts ticks before bend and scratch, so the deck stays still and the
 * only human error left is where the eye says the revolution ended — which is
 * symmetric, not a bias. That is why these three may be averaged and those
 * three could not.
 *
 * **Not 720.** It was the standing suspicion, and it is 1% above every single
 * measurement, so the evidence does not support it. 1% of a scratch rate is
 * inaudible either way, so this is settled unless a controller other than the
 * FLX4 says otherwise — and if one does, the Measure button is the answer, not
 * an edit here.
 */
export const JOG_TICKS_PER_REV = 713

/**
 * Playback-rate change per jog tick when the platter surface is not touched.
 *
 * 0.05 was too weak to hear on real hardware — the owner's verdict after three
 * round trips, which is the round trip the Settings screen exists to end.
 */
export const BEND_PER_TICK = 0.1

/** How hard the jog rate is smoothed. Low follows the hand later but calmer. */
export const JOG_SMOOTHING = 0.4

/** Vinyl mode: seconds for the stop ramp. */
export const BRAKE_SEC = 0.55

/** Vinyl mode: seconds for the start ramp. */
export const SPIN_UP_SEC = 0.32

/**
 * Platter speed in RPM.
 *
 * 45, not 33⅓, because that is what the scratch maths already did:
 * `SEC_PER_REV` shipped at 1.333s, which is 60/45. Defaulting to 33⅓ would
 * have been the tidier number and would have silently changed how every
 * existing scratch feels.
 */
export const PLATTER_RPM = 45

/** Waveform zoom: CSS px of screen per second of audio. */
export const WAVEFORM_PX_PER_SEC = 150

/**
 * Beat grid nudge per click of the manual +/- correction in BeatGridPanel
 * (v0.3.0). 10ms — small enough that a few clicks close a by-ear phase error
 * without overshooting, big enough to be worth a click instead of ten.
 */
export const BEATGRID_NUDGE_SEC = 0.01

/**
 * SYNC long-press threshold, in ms, for the master-deck override (v0.3.0).
 * Shared by the mouse path (Deck.tsx) and the FLX4 path (manager.ts) so a
 * press reads the same either way. Long enough that an ordinary SYNC tap
 * never fires it by accident, short enough not to feel unresponsive.
 */
export const LONG_PRESS_MS = 500

/**
 * Mix Assist (v0.4.6) autonomous transition: crossfade length in seconds.
 * ROADMAP.md names this "a starting point, tuned by ear in testing" rather
 * than a measured value — there is no real library or a human ear in this
 * remote session to tune it against, so 8s stands as a plain, unverified
 * first guess (a typical quick blend) until the owner's own listening says
 * otherwise. Not in Settings, same reasoning as every other constant in this
 * section: a control here is a way to let the user break a transition they
 * haven't heard yet.
 */
export const TRANSITION_CROSSFADE_SEC = 8

/**
 * Mix Assist (v0.4.6): once a track comes off a deck (replaced by another
 * load), it stays out of the suggestion list for this long — ROADMAP.md's
 * "אותו טראק לא חוזר ומוצע שוב מיד אחרי שהוא בדיוק ירד מדק". A fixed
 * constant like the rest of this section: the point is to stop an
 * immediate flicker back into the list the DJ just took it out of, not a
 * tunable preference.
 */
export const RECENTLY_REMOVED_WINDOW_SEC = 30
