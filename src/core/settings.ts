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
import type { BassSwapStyle } from '@/core/eq-mix'

/**
 * Bumped whenever a stored value changes meaning. Adding a field does **not**
 * need a bump — an absent key already falls back to its default, which is the
 * same thing a migration would do, and a bump that migrates nothing trains the
 * reader to ignore the number.
 */
export const SCHEMA_VERSION = 1

export type KeyMode = 'musical' | 'camelot'
export type OnLoadPlayhead = 'start' | 'firstCue'
/**
 * What a mouse drag or wheel on the waveform does while that deck is in SYNC or
 * inside an automatic transition (v0.8.28, the owner's choice, 24/09). `likeJog`
 * treats the mouse exactly like a hand on the FLX4's platter — it takes over and
 * cancels the transition — so the two never need two rules remembered. `blocked`
 * refuses and says why on screen, for anyone who grabs the waveform by accident.
 */
export type WaveformMouseInSync = 'likeJog' | 'blocked'
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
  /**
   * v0.9.54: boot on Balanced while the library has analysis to do, and leave it once the analysis is done (v0.9.52–53). Off by default
   * (Shalom, 07/10). Read at boot like `latency`, so it is mirrored the same way (`boot-latency.ts`).
   */
  analysisCushion: boolean

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
  /** Title column width in % of the table (v0.9.43). Set by dragging the header's edge; the Artist column gives up what Title takes. */
  libraryTitleWidth: number
  /** Ceiling on canvas repaints per second. */
  maxFps: number
  /** Draw the waveform at the screen's real pixel density. Sharper, costlier. */
  hiResCanvas: boolean
  /** Decimal places on the deck BPM readout. */
  bpmDecimals: number
  /** Where the playhead sits when a track is loaded. */
  onLoadPlayhead: OnLoadPlayhead
  /** Mouse drag / wheel on the waveform while in SYNC or an auto transition. */
  waveformMouseInSync: WaveformMouseInSync
  /** v0.8.39: Play on a deck while the other plays turns SYNC on by itself; once the other track is gone, the tempo glides back to the track's own BPM. On by default (Shalom, 25/09). */
  autoSyncGlide: boolean
  /** Refuse to load a track onto a deck that is playing. */
  lockPlayingDeck: boolean
  /** Chosen audio output device, or null for the system default. */
  outputDeviceId: string | null
  /** Show a "?" beside every control, with a short explanation on hover/focus. */
  hintMode: boolean
  /** v0.8.38: a ↗ beside each track's BPM that opens a Beatport search and a panel to type what it says. Off by default (Shalom, 25/09). */
  sourceCheck: boolean
  /** v0.9.0: the top bar's "Tag" button, which opens the tagging screen. Off by default — Shalom (25/09): a screen that covers the decks has no place in a live set. */
  taggingMode: boolean
  /** v0.9.10b: the "vocal started / ended" buttons under each deck's vocal strip. Off by default: a live set has no use for them. */
  vocalMarking: boolean
  /**
   * v0.9.41b: the library's "N no artist" button and its suggestions (`core/artist-suggest.ts`). On by default, it is
   * Shalom's own request; he asked (06/10) to be able to turn it off. Artists he already accepted stay either way.
   */
  artistSuggestions: boolean
  /** v0.9.18: how Mix Assist swaps the two basses (`core/eq-mix.ts`). Instant by default (Shalom, 05/10), gradual or together (v0.9.33, 07/10) by choice here. */
  bassSwap: BassSwapStyle
  /**
   * v0.9.22: how far Mix Assist may move the incoming song's key by itself (`autoKeySync` in `controls.ts`), in semitones. 0 = off. Two by
   * default; the owner (05/10) asked for one and off as the other choices. The Key sync button is not bound by it.
   */
  mixAssistKeySync: 0 | 1 | 2
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
  analysisCushion: false,

  keyMode: 'musical',
  waveformPxPerSec: WAVEFORM_PX_PER_SEC,
  waveformColorByEq: true,
  eqDb: EQ_DB,
  libraryTextScale: 1,
  libraryTitleWidth: 20,
  maxFps: 60,
  hiResCanvas: true,
  bpmDecimals: 1,
  onLoadPlayhead: 'start',
  waveformMouseInSync: 'likeJog',
  lockPlayingDeck: true,
  autoSyncGlide: true,
  outputDeviceId: null,
  hintMode: true, // temporary — user asked for hints on by default until further notice (2026-09-04)
  sourceCheck: false,
  taggingMode: false,
  vocalMarking: false,
  artistSuggestions: true,
  bassSwap: 'instant',
  mixAssistKeySync: 2,
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
  /**
   * Words the Settings search (v0.9.55) also matches, never shown as-is — in
   * English and in Hebrew, the way the owner says it ("סולם", not a
   * dictionary entry). On the field itself, not in a list beside the screen,
   * so a new field cannot be born unsearchable: `tests/repo/settings-search-
   * keywords.test.ts` fails when either language is missing.
   */
  keywords: readonly string[]
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
    keywords: ["jog", "wheel", "platter", "calibrate", "measure", "ג'וג", "גלגל", "פלטה", "כיול", "מדידה"],
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
    keywords: ["jog", "nudge", "pitch bend", "tempo", "ג'וג", "גלגל", "דחיפה", "קצב", "מהירות"],
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
    keywords: ["keyboard", "nudge", "pitch bend", "shortcut", "מקלדת", "דחיפה", "קצב", "מקשים", "מהירות"],
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
    keywords: ["pitch", "fader", "speed", "bpm", "range", "טמפו", "מהירות", "פיידר", "קצב", "טווח"],
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
    keywords: ["vinyl", "turntable", "scratch", "rpm", "ויניל", "פטיפון", "סקראץ'", "סיבובים", "פלטה"],
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
    keywords: ["delay", "lag", "buffer", "dropout", "crackle", "glitch", "השהיה", "דיליי", "קפיצות", "קליקים", "גמגום", "סאונד"],
    requiresReload: true,
    options: [
      { value: 'interactive', label: 'Low — tightest response' },
      { value: 'balanced', label: 'Balanced' },
      { value: 'playback', label: 'Safe — fewest dropouts' },
    ],
  },
  {
    kind: 'toggle',
    key: 'analysisCushion',
    label: 'Balanced while the library analyses',
    help: 'When the library has songs to analyse (after a new version), the page opens on Balanced so the analysis does not make playing songs skip. When the analysis is done the page refreshes by itself if nothing would be lost, or shows a "fast jog" button. Only when Audio latency is on Low.',
    group: 'hardware',
    keywords: ["balanced", "latency", "analysis", "dropout", "skip", "השהיה", "ניתוח", "קפיצות", "באלנסד", "סאונד"],
    requiresReload: true,
  },

  {
    kind: 'number',
    key: 'brakeSec',
    label: 'Brake time',
    help: 'Vinyl mode: how long the platter takes to stop.',
    group: 'feel',
    keywords: ["vinyl", "stop", "brake", "ויניל", "עצירה", "בלם", "ברקס"],
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
    keywords: ["vinyl", "start", "spin", "ויניל", "התנעה", "הפעלה", "סיבוב"],
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
    keywords: ["jog", "scratch", "smooth", "cpu", "ג'וג", "סקראץ'", "החלקה", "גלגל", "מעבד"],
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
    keywords: ["eq", "bass", "mid", "treble", "high", "low", "kill", "אקולייזר", "בס", "באס", "גבוהים", "נמוכים", "אמצע", "איקיו"],
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
    keywords: ["load", "cue", "start", "playhead", "טעינה", "קיו", "התחלה", "נקודת", "שיר"],
    options: [
      { value: 'start', label: 'Start of the track' },
      { value: 'firstCue', label: 'First cue point' },
    ],
  },
  {
    kind: 'choice',
    key: 'waveformMouseInSync',
    label: 'Mouse on the waveform during SYNC',
    help: 'Dragging or wheeling the waveform while the deck is in SYNC or an automatic mix.',
    group: 'feel',
    keywords: ["sync", "waveform", "mouse", "drag", "סינק", "גל", "עכבר", "גרירה", "סנכרון"],
    options: [
      { value: 'likeJog', label: 'Like the jog wheel — takes over' },
      { value: 'blocked', label: 'Blocked, with a message' },
    ],
  },
  {
    kind: 'toggle',
    key: 'autoSyncGlide',
    label: 'Auto SYNC in, glide back out',
    help: 'Play on one deck while the other is playing turns SYNC on by itself. When the other track is gone — stopped, its fader down, or the crossfader fully away — this track slides back to its own BPM over 30 seconds.',
    group: 'feel',
    keywords: ["sync", "auto", "glide", "bpm", "tempo", "סינק", "סנכרון", "אוטומטי", "קצב", "מהירות"],
  },
  {
    kind: 'choice',
    key: 'bassSwap',
    label: 'Mix Assist bass swap',
    help: 'Mix Assist brings the new song in with its bass off, and swaps the two basses where the new part starts. Instant: one shuts and the other opens on the same beat. Gradual: over one bar, both at half power in the middle of it. Together: both basses play at full for 2 bars around the swap — fuller, louder, and muddy if the two basslines do not agree.',
    group: 'feel',
    keywords: ["mix assist", "bass", "eq", "transition", "מיקס", "בס", "באס", "מעבר", "החלפה"],
    options: [
      { value: 'instant', label: 'Instant — on the beat' },
      { value: 'gradual', label: 'Gradual — over one bar' },
      { value: 'together', label: 'Together — both basses full for 2 bars' },
    ],
  },
  {
    kind: 'choice',
    key: 'mixAssistKeySync',
    label: 'Mix Assist key sync',
    help: 'Mix Assist moves the new song up or down a little, without changing its speed, so it is in a key that fits the playing one. A bigger gap than this leaves the song in its own key and says so. Small moves are not heard; bigger ones make a voice sound processed.',
    group: 'feel',
    keywords: ["mix assist", "key", "harmonic", "pitch", "semitone", "מיקס", "סולם", "טון", "מפתח", "הרמוני"],
    options: [
      { value: 2, label: 'Up to 2 semitones' },
      { value: 1, label: 'Up to 1 semitone' },
      { value: 0, label: 'Off' },
    ],
  },
  {
    kind: 'toggle',
    key: 'lockPlayingDeck',
    label: 'Lock the deck that is playing',
    help: 'Refuses a load onto that deck only — the other deck stays free, which is how you mix.',
    group: 'feel',
    keywords: ["lock", "deck", "load", "safety", "נעילה", "דק", "טעינה", "הגנה", "נועל"],
  },

  {
    kind: 'number',
    key: 'waveformPxPerSec',
    label: 'Waveform zoom',
    help: 'Screen pixels per second of audio. Higher shows less, in more detail.',
    group: 'display',
    keywords: ["waveform", "zoom", "detail", "גל", "זום", "הגדלה", "גלי קול"],
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
    keywords: ["waveform", "colour", "color", "eq", "גל", "צבע", "צבעים", "גלי קול"],
  },
  {
    kind: 'choice',
    key: 'maxFps',
    label: 'Max screen updates',
    help: 'A ceiling on repaints. Lower frees CPU for audio on a slow machine.',
    group: 'display',
    keywords: ["fps", "frame rate", "cpu", "performance", "refresh", "מסך", "מהירות", "מעבד", "ביצועים", "רענון", "תקיעות"],
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
    keywords: ["waveform", "sharp", "retina", "resolution", "גל", "חדות", "רזולוציה", "איכות"],
  },
  {
    kind: 'choice',
    key: 'bpmDecimals',
    label: 'BPM decimals',
    help: 'Digits after the point on the deck BPM readout.',
    group: 'display',
    keywords: ["bpm", "decimal", "digits", "tempo", "קצב", "ספרות", "נקודה", "עשרוני"],
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
    keywords: ["key", "camelot", "musical", "notation", "harmonic", "סולם", "טון", "מפתח", "קמלוט", "הרמוני"],
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
    keywords: ["font", "text", "size", "zoom", "list", "גופן", "טקסט", "גודל", "אותיות", "רשימה", "ספרייה"],
    min: 0.85,
    max: 1.5,
    step: 0.05,
    unit: '×',
  },
  {
    kind: 'toggle',
    key: 'sourceCheck',
    label: 'Check BPM and key against Beatport',
    help: 'Adds ↗ beside each track’s BPM. It opens a Beatport search for the track in a new tab and a panel where you type what Beatport shows. The app never reads Beatport itself; values you type are kept even when this is off.',
    group: 'library',
    keywords: ["beatport", "bpm", "key", "verify", "online", "ביטפורט", "בדיקה", "קצב", "סולם", "אימות"],
  },
  {
    kind: 'toggle',
    key: 'taggingMode',
    label: 'Tagging (where is the "1", vocals)',
    help: 'Adds a "Tag" button to the top bar. It opens a screen where you mark which beat is the "1" and whether a short clip has vocals, so the app can be measured against your ears. Off during a set: the screen covers the decks.',
    group: 'library',
    keywords: ["tag", "downbeat", "one", "vocal", "label", "תיוג", "תגית", "אחד", "שירה", "ווקאל", "תיבה"],
  },
  {
    kind: 'toggle',
    key: 'vocalMarking',
    label: 'Mark vocals by hand',
    help: 'Adds buttons under each deck\'s vocal strip: press "vocal started" and "vocal ended" while the song plays, as many times as the song needs. Your marks are kept for that song for good and override the computer\'s guess. When you press "finished marking", everything you did not mark becomes empty.',
    group: 'library',
    keywords: ["vocal", "singing", "mark", "voice", "שירה", "ווקאל", "סימון", "קול", "זמר"],
  },
  {
    kind: 'toggle',
    key: 'artistSuggestions',
    label: 'Suggest a missing artist',
    help: 'Adds a "no artist" button above the list. It shows only the songs whose file has no artist, with a suggestion from the file name you can accept (✓) or reject (✕), or a box to type one in. Nothing is written to your files. Artists you already accepted stay when this is off.',
    group: 'library',
    keywords: ["artist", "name", "missing", "suggest", "אמן", "זמר", "שם", "חסר", "הצעה"],
  },

  {
    kind: 'toggle',
    key: 'hintMode',
    label: 'Hint mode',
    help: 'A "?" beside every control, app-wide — hover or focus it for a short explanation, including the matching FLX4 button where one exists.',
    group: 'help',
    keywords: ["help", "hint", "tooltip", "explain", "question", "עזרה", "רמז", "הסבר", "סימן שאלה"],
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
