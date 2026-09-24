/**
 * The settings schema: what the user is allowed to change, and what happens to
 * a value that is out of range.
 *
 * Pure by design. Storage lives behind `core/ports/settings.ts` and is
 * implemented in `platform/`; this file knows only the shape, the defaults and
 * the rules. That split is what lets the schema and the migration be tested
 * without a browser — the two parts of v0.2.5 most likely to lose someone's
 * settings.
 *
 * **The defaults are the constants, not copies of them.** Every default below
 * is imported from `core/constants.ts`, so there is exactly one place a default
 * can be wrong. A literal here would drift from the engine the first time
 * either side changed alone, and the user would be tuning against a number the
 * audio path never used.
 */
import {
  BEND_PER_TICK,
  BRAKE_SEC,
  EQ_DB,
  JOG_SMOOTHING,
  JOG_TICKS_PER_REV,
  KEYBOARD_BEND,
  PLATTER_RPM,
  SPIN_UP_SEC,
  TEMPO_RANGE,
  WAVEFORM_PX_PER_SEC,
} from '@/core/constants'

/**
 * Bumped whenever a stored value changes meaning. Adding a field does **not**
 * need a bump — an absent key already falls back to its default, which is the
 * same thing a migration would do, and a bump that migrates nothing trains the
 * reader to ignore the number.
 */
export const SCHEMA_VERSION = 1

export type KeyMode = 'musical' | 'camelot'
export type OnLoadPlayhead = 'start' | 'firstCue'
export type LatencyProfile = 'interactive' | 'balanced' | 'playback'

export interface Settings {
  // — hardware and feel: different per controller, per person, per booth —
  /** Encoder ticks in one full turn of the jog wheel. A property of the hardware. */
  jogTicksPerRev: number
  /** Playback-rate change per jog tick while the platter surface is not touched. */
  bendPerTick: number
  /** Playback-rate change from a bend key. A key has no "how hard", so it is fixed. */
  keyboardBend: number
  /** Tempo fader travel: ±8 / ±16 / ±50 percent. */
  tempoRange: number
  /** Seconds for the vinyl-mode stop ramp. */
  brakeSec: number
  /** Seconds for the vinyl-mode start ramp. */
  spinUpSec: number
  /** Platter speed. Decides how much audio one revolution of the wheel is worth. */
  platterRpm: number
  /** How hard the jog rate is smoothed. Lower is softer and later. */
  jogSmoothing: number
  /**
   * Audio latency profile. Chosen when the AudioContext is built, so it cannot
   * be applied to a running engine — the field carries `requiresReload` and the
   * screen says so rather than pretending the change landed.
   */
  latency: LatencyProfile

  // — preferences —
  /** Musical (Am, F#) or Camelot (8A, 11B) in the library and on the decks. */
  keyMode: KeyMode
  /** Waveform zoom, in CSS px of screen per second of audio. */
  waveformPxPerSec: number
  /** Colour the waveform by low/mid/high energy, or draw it in one tone. */
  waveformColorByEq: boolean
  /** EQ gain in dB at the extremes of each band knob. */
  eqDb: number
  /** Library row text size, as a multiplier of the base size. */
  libraryTextScale: number
  /** Ceiling on canvas repaints per second. */
  maxFps: number
  /** Draw the waveform at the screen's real pixel density. Sharper, costlier. */
  hiResCanvas: boolean
  /** Decimal places on the deck BPM readout. */
  bpmDecimals: number
  /** Where the playhead sits when a track is loaded. */
  onLoadPlayhead: OnLoadPlayhead
  /** Refuse to load a track onto a deck that is playing. */
  lockPlayingDeck: boolean
  /** Chosen audio output device, or null for the system default. */
  outputDeviceId: string | null
  /** Show a "?" beside every control, with a short explanation on hover/focus. */
  hintMode: boolean
}

export const DEFAULTS: Settings = {
  jogTicksPerRev: JOG_TICKS_PER_REV,
  bendPerTick: BEND_PER_TICK,
  keyboardBend: KEYBOARD_BEND,
  tempoRange: TEMPO_RANGE,
  brakeSec: BRAKE_SEC,
  spinUpSec: SPIN_UP_SEC,
  platterRpm: PLATTER_RPM,
  jogSmoothing: JOG_SMOOTHING,
  latency: 'interactive',

  keyMode: 'musical',
  waveformPxPerSec: WAVEFORM_PX_PER_SEC,
  waveformColorByEq: true,
  eqDb: EQ_DB,
  libraryTextScale: 1,
  maxFps: 60,
  hiResCanvas: true,
  bpmDecimals: 1,
  onLoadPlayhead: 'start',
  lockPlayingDeck: true,
  outputDeviceId: null,
  hintMode: true, // temporary — user asked for hints on by default until further notice (2026-09-04)
}

// ————————————————————————————————————————————————————————————————
// Field descriptors — the screen is generated from these, not hand-written.
// ————————————————————————————————————————————————————————————————

/**
 * Which fields exist is decided **here**, once. The Settings screen renders
 * this table and nothing else.
 *
 * That is the mechanism behind the version's own rule that calibration
 * constants stay out of the UI: `POSITION_EPSILON_SEC`, `DECLICK_SEC`,
 * `PLATTER_SIZE` and the rest are not "left out of the screen", they have no
 * descriptor — so no screen can grow a control for them by accident, and
 * `tests/repo/settings-layer3.test.ts` fails if a name from that list ever
 * appears here. A named set, not an omission: the same rule as `COMPANION_EXT`.
 */
export type FieldGroup = 'hardware' | 'feel' | 'display' | 'library' | 'help'

interface FieldBase {
  key: keyof Settings
  label: string
  /** One line, shown under the control. Says what changes, not what it is. */
  help: string
  group: FieldGroup
  /** True when the value can only take effect on the next page load. */
  requiresReload?: boolean
  /**
   * Set when the control is real but the data it needs does not exist yet, and
   * says which version brings it.
   *
   * A setting that silently does nothing is the exact failure this project
   * forbids — so the honest options were to hide the field or to state the gap
   * where the decision is made. Hiding it would be an omission; this is a
   * named exemption, and the screen prints it under the control.
   */
  pending?: string
}

export interface NumberField extends FieldBase {
  kind: 'number'
  min: number
  max: number
  step: number
  unit?: string
  /** Multiplier for display only: 0.08 shows as 8 when scale is 100. */
  displayScale?: number
}

export interface ChoiceField extends FieldBase {
  kind: 'choice'
  options: { value: string | number | boolean; label: string }[]
}

export interface ToggleField extends FieldBase {
  kind: 'toggle'
}

export type Field = NumberField | ChoiceField | ToggleField

export const FIELDS: Field[] = [
  {
    kind: 'number',
    key: 'jogTicksPerRev',
    label: 'Jog ticks per revolution',
    help: 'A property of your controller. Use Measure rather than guessing.',
    group: 'hardware',
    min: 100,
    max: 4000,
    step: 1,
  },
  {
    kind: 'number',
    key: 'bendPerTick',
    label: 'Jog bend strength',
    help: 'How far one tick of the jog rim pushes the tempo.',
    group: 'hardware',
    min: 0.01,
    max: 0.5,
    step: 0.01,
  },
  {
    kind: 'number',
    key: 'keyboardBend',
    label: 'Keyboard bend strength',
    help: 'How far S/D and K/L push the tempo while held.',
    group: 'hardware',
    min: 0.005,
    max: 0.2,
    step: 0.005,
    unit: '%',
    displayScale: 100,
  },
  {
    kind: 'choice',
    key: 'tempoRange',
    label: 'Tempo range',
    help: 'Travel of the tempo fader, end to end.',
    group: 'hardware',
    options: [
      { value: 0.08, label: '±8%' },
      { value: 0.16, label: '±16%' },
      { value: 0.5, label: '±50%' },
    ],
  },
  {
    kind: 'choice',
    key: 'platterRpm',
    label: 'Platter speed',
    help: 'How much audio one revolution of the wheel is worth.',
    group: 'hardware',
    options: [
      { value: 33.333, label: '33⅓ RPM' },
      { value: 45, label: '45 RPM' },
    ],
  },
  {
    kind: 'choice',
    key: 'latency',
    label: 'Audio latency',
    help: 'Lower is tighter under the hand and costs more CPU.',
    group: 'hardware',
    requiresReload: true,
    options: [
      { value: 'interactive', label: 'Low — tightest response' },
      { value: 'balanced', label: 'Balanced' },
      { value: 'playback', label: 'Safe — fewest dropouts' },
    ],
  },

  {
    kind: 'number',
    key: 'brakeSec',
    label: 'Brake time',
    help: 'Vinyl mode: how long the platter takes to stop.',
    group: 'feel',
    min: 0.05,
    max: 3,
    // 0.01, not 0.05: an <input type=range> snaps its value to min + n*step,
    // and the spin-up default of 0.32 is not on a 0.05 grid — the slider sat
    // at 0.30 while the number beside it read 0.32s and Reset was greyed out
    // as "already default". A control has to be able to show the value it has.
    step: 0.01,
    unit: 's',
  },
  {
    kind: 'number',
    key: 'spinUpSec',
    label: 'Spin-up time',
    help: 'Vinyl mode: how long the platter takes to reach speed.',
    group: 'feel',
    min: 0.05,
    max: 3,
    step: 0.01,
    unit: 's',
  },
  {
    kind: 'number',
    key: 'jogSmoothing',
    label: 'Jog smoothing',
    help: 'Lower follows the hand more softly and a beat later.',
    group: 'feel',
    min: 0.05,
    max: 1,
    step: 0.05,
  },
  {
    kind: 'number',
    key: 'eqDb',
    label: 'EQ depth',
    help: 'Cut and boost at the ends of each EQ knob.',
    group: 'feel',
    min: 6,
    max: 40,
    step: 1,
    unit: 'dB',
  },
  {
    kind: 'choice',
    key: 'onLoadPlayhead',
    label: 'On track load',
    help: 'Where the playhead waits when a track lands on a deck.',
    group: 'feel',
    options: [
      { value: 'start', label: 'Start of the track' },
      { value: 'firstCue', label: 'First cue point' },
    ],
  },
  {
    kind: 'toggle',
    key: 'lockPlayingDeck',
    label: 'Lock the deck that is playing',
    help: 'Refuses a load onto that deck only — the other deck stays free, which is how you mix.',
    group: 'feel',
  },

  {
    kind: 'number',
    key: 'waveformPxPerSec',
    label: 'Waveform zoom',
    help: 'Screen pixels per second of audio. Higher shows less, in more detail.',
    group: 'display',
    min: 40,
    max: 400,
    step: 10,
    unit: 'px/s',
  },
  {
    kind: 'toggle',
    key: 'waveformColorByEq',
    label: 'Colour waveform by EQ',
    help: 'Off draws one tone, which is cheaper to paint.',
    group: 'display',
  },
  {
    kind: 'choice',
    key: 'maxFps',
    label: 'Max screen updates',
    help: 'A ceiling on repaints. Lower frees CPU for audio on a slow machine.',
    group: 'display',
    options: [
      { value: 15, label: '15 fps' },
      { value: 24, label: '24 fps' },
      { value: 30, label: '30 fps' },
      { value: 45, label: '45 fps' },
      { value: 60, label: '60 fps' },
    ],
  },
  {
    kind: 'toggle',
    key: 'hiResCanvas',
    label: 'High-resolution waveform',
    help: 'Draw at the screen’s real pixel density. Sharper, and more to paint.',
    group: 'display',
  },
  {
    kind: 'choice',
    key: 'bpmDecimals',
    label: 'BPM decimals',
    help: 'Digits after the point on the deck BPM readout.',
    group: 'display',
    options: [
      { value: 1, label: '1 — 128.5' },
      { value: 2, label: '2 — 128.47' },
    ],
  },

  {
    kind: 'choice',
    key: 'keyMode',
    label: 'Show key as',
    help: 'Musical names, or Camelot numbers for mixing in key.',
    group: 'library',
    options: [
      { value: 'musical', label: 'Musical — Am, F#' },
      { value: 'camelot', label: 'Camelot — 8A, 11B' },
    ],
  },
  {
    kind: 'number',
    key: 'libraryTextScale',
    label: 'Library text size',
    help: 'Scales the track list only. 1.0 is the built-in size.',
    group: 'library',
    min: 0.85,
    max: 1.5,
    step: 0.05,
    unit: '×',
  },

  {
    kind: 'toggle',
    key: 'hintMode',
    label: 'Hint mode',
    help: 'A "?" beside every control, app-wide — hover or focus it for a short explanation, including the matching FLX4 button where one exists.',
    group: 'help',
  },
]

export const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]))

// ————————————————————————————————————————————————————————————————
// Loading stored values — out of range is reported, never quietly fixed
// ————————————————————————————————————————————————————————————————

/**
 * One thing that was wrong in stored data and what was used instead.
 *
 * The whole reason this type exists: a settings file that has gone bad is
 * exactly the case where silently substituting a default is most tempting and
 * most harmful. The user tuned a number, the app used a different one, and
 * nothing on screen ever said so. So `coerce` returns its repairs and the
 * screen shows them.
 */
export interface SettingsIssue {
  key: string
  /** what was stored, rendered for a human */
  got: string
  /** what the app is using instead */
  used: string
  reason: 'out-of-range' | 'wrong-type' | 'unknown-key' | 'not-an-option'
}

export interface CoerceResult {
  values: Settings
  issues: SettingsIssue[]
}

const show = (v: unknown): string =>
  typeof v === 'string' ? JSON.stringify(v) : typeof v === 'number' ? String(v) : String(v)

/**
 * Turn whatever came out of storage into a valid `Settings`, listing every
 * repair it had to make. Never throws: a corrupt store must still boot the app,
 * because a DJ mid-set cannot fix a schema.
 */
export function coerce(raw: unknown): CoerceResult {
  const issues: SettingsIssue[] = []
  const values: Settings = { ...DEFAULTS }
  if (raw == null || typeof raw !== 'object') return { values, issues }
  const obj = raw as Record<string, unknown>

  for (const [key, stored] of Object.entries(obj)) {
    if (key === 'version') continue
    if (!(key in DEFAULTS)) {
      // A key we do not know is usually an older field that was removed. Naming
      // it is how the user finds out their old preference stopped being read.
      issues.push({ key, got: show(stored), used: '(ignored)', reason: 'unknown-key' })
      continue
    }
    const k = key as keyof Settings
    const fallback = DEFAULTS[k]

    // outputDeviceId is the one nullable field, and the only one with no
    // descriptor: its valid set is whatever cards are plugged in right now,
    // which this pure module cannot know. The UI checks it against the live
    // device list instead.
    if (k === 'outputDeviceId') {
      if (stored === null || typeof stored === 'string') values.outputDeviceId = stored
      else issues.push({ key, got: show(stored), used: 'system default', reason: 'wrong-type' })
      continue
    }

    const field = FIELD_BY_KEY.get(k)
    if (!field) continue

    if (field.kind === 'toggle') {
      if (typeof stored === 'boolean') (values[k] as boolean) = stored
      else issues.push({ key, got: show(stored), used: show(fallback), reason: 'wrong-type' })
      continue
    }

    if (field.kind === 'choice') {
      if (field.options.some((o) => o.value === stored)) {
        ;(values[k] as typeof stored) = stored
      } else {
        issues.push({ key, got: show(stored), used: show(fallback), reason: 'not-an-option' })
      }
      continue
    }

    if (typeof stored !== 'number' || !Number.isFinite(stored)) {
      issues.push({ key, got: show(stored), used: show(fallback), reason: 'wrong-type' })
      continue
    }
    if (stored < field.min || stored > field.max) {
      // Clamped rather than defaulted: a value that drifted past the edge is
      // still a statement of which direction the user wanted.
      const clamped = Math.min(field.max, Math.max(field.min, stored))
      ;(values[k] as number) = clamped
      issues.push({ key, got: show(stored), used: show(clamped), reason: 'out-of-range' })
      continue
    }
    ;(values[k] as number) = stored
  }

  return { values, issues }
}

// ————————————————————————————————————————————————————————————————
// Migration from the three keys that predate this schema
// ————————————————————————————————————————————————————————————————

/**
 * The settings that already existed before there was a settings screen, each
 * saved by whoever needed it and owned by nobody:
 * `deckmix:keyMode` in `localStorage`, written from inside the library table.
 *
 * The other two — the library folder handle and the custom MIDI mapping — keep
 * their own keys on purpose. A `FileSystemDirectoryHandle` is not JSON and a
 * mapping is a document, not a preference; folding either into this blob would
 * mean a single bad write loses the library. They are *shown* on the Settings
 * screen and stored where they always were.
 */
export interface LegacyKeys {
  keyMode?: string | null
}

export interface MigrationResult extends CoerceResult {
  /** Keys that were carried over, for the one-line report the screen shows. */
  migrated: string[]
}

export function migrate(stored: unknown, legacy: LegacyKeys = {}): MigrationResult {
  const base = coerce(stored)
  const migrated: string[] = []

  const hasStoredKeyMode =
    stored != null && typeof stored === 'object' && 'keyMode' in (stored as object)

  // The old value only wins while the new schema has nothing to say. Once the
  // user has set the field here, a stale localStorage entry must not reach back
  // in and overwrite it on the next boot.
  if (!hasStoredKeyMode && (legacy.keyMode === 'camelot' || legacy.keyMode === 'musical')) {
    base.values.keyMode = legacy.keyMode
    migrated.push('keyMode')
  }

  return { ...base, migrated }
}

/** One revolution of the platter, in seconds of audio at normal speed. */
export const secPerRev = (rpm: number): number => 60 / rpm

/**
 * Slack allowed when comparing a frame gap against the cap, in milliseconds.
 *
 * Under any real frame interval — 120Hz is 8.3ms — so a cap the user actually
 * asked for still bites, and above the jitter rAF delivers, so a cap set to the
 * display's own rate stops fighting it.
 */
export const FRAME_JITTER_MS = 2

/**
 * Whether the render loop should push a new frame.
 *
 * Pure, and in `core/`, because the arithmetic here was wrong in a way no type
 * checker could see: the gap for a 60fps cap is 16.667ms and rAF on a 60Hz
 * screen delivers frames at 16.667ms ± jitter, so a bare `<` comparison dropped
 * roughly every other frame — **at the default setting**, silently halving the
 * repaint rate that shipped in v0.2.4. A hook cannot be tested; this can.
 *
 * A scratching hand always paints: v0.2.0 already learned that a dropped frame
 * under a moving finger reads as the scratch not working, and a display
 * preference must not become an audio-feel decision.
 */
export function shouldRepaint(
  now: number,
  lastPaint: number,
  maxFps: number,
  scratching: boolean,
): boolean {
  if (scratching) return true
  return now - lastPaint >= 1000 / maxFps - FRAME_JITTER_MS
}
