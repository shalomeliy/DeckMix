import type { ControlAction } from '@/core/mapping/mapping'
import { flx4Label } from '@/core/mapping/flx4-labels'

/**
 * Hint mode's text, one entry per control across the whole app.
 *
 * English only for now — the strings are plain, not composed with any UI
 * chrome, so a future version can add a second table keyed the same way
 * (`HINT_BASE_HE`, or a `Record<Lang, …>` wrapper) without touching every
 * call site that already passes a `HintId`.
 *
 * `action` is optional: when set, `hint()` appends the physical FLX4 control
 * that does the same thing, looked up live from `flx4-labels.ts` — so the
 * hardware line can never be typed by hand and drift from the real mapping.
 * Left unset for controls with no hardware equivalent (mouse-only UI, or
 * Settings/library chrome) rather than inventing filler text.
 */
interface HintSpec {
  text: string
  action?: ControlAction
  param?: number
}

const HINT_BASE = {
  // — deck —
  'deck.cue': {
    text: 'Jump to the cue point. Hold to preview from cue, release to jump back.',
    action: 'cue',
  },
  'deck.play': { text: 'Play or pause the deck.', action: 'play' },
  'deck.sync': {
    text: 'Tap to lock this deck’s tempo and phase to the master deck. Hold to make this deck the master instead.',
    action: 'sync',
  },
  'deck.loop': {
    text: 'Turn the active loop on or off. ÷2/×2 halve or double its length.',
    action: 'loopToggle',
  },
  'deck.pfl': { text: 'Send this deck to the headphone cue mix.', action: 'cueMonitor' },
  'deck.vinyl': { text: 'Vinyl mode: stop and start spin down and up instead of cutting.' },
  'deck.tempo': {
    text: 'Pitch the track up or down, within the tempo range set in Settings.',
    action: 'tempo',
  },
  'deck.bpm': { text: 'Open the beat grid editor for this track.' },
  'deck.platter': {
    text: 'Drag sideways to scratch.',
    action: 'jog',
  },
  'deck.waveform': { text: 'Click anywhere on the waveform to jump the playhead there.' },
  'deck.padGrid': {
    text: 'The 8 pads. What they do depends on the mode selected above: Hot Cue (set/jump, × or shift-click clears, drag to move, alt-click to rename), Loop (start/stop a loop of that length, hold SHIFT for a momentary Loop Roll), Beat Jump (jump forward, or back with SHIFT), or Sampler (drag a track from the library onto a pad to load it, press to trigger, hold SHIFT for the other 8 slots — hover a pad for its mode/gain/sync/clear controls).',
    action: 'hotcue',
  },
  'deck.padMode': {
    text: 'Switch what this deck’s pad grid does: Hot Cue, Loop, Beat Jump, or Sampler.',
    action: 'padMode',
  },
  'deck.shift': {
    text: 'Hold to access the alternate action on Loop/Beat Jump pads (Loop Roll, jump backward).',
    action: 'shift',
  },

  // — mixer —
  'mixer.eqHigh': { text: 'High-frequency cut/boost. Fully down, it cuts the highs completely.', action: 'eqHigh' },
  'mixer.eqMid': { text: 'Mid-frequency cut/boost.', action: 'eqMid' },
  'mixer.eqLow': { text: 'Low-frequency cut/boost. Fully down, it cuts the bass completely.', action: 'eqLow' },
  'mixer.filter': { text: 'Sweeps a high-pass/low-pass filter across the channel.', action: 'filter' },
  'mixer.channelVolume': { text: 'This channel’s level into the mix.', action: 'channelVolume' },
  'mixer.masterVolume': { text: 'Overall output level.', action: 'masterVolume' },
  'mixer.cueVolume': { text: 'Headphone cue level.', action: 'cueVolume' },
  'mixer.cueMix': { text: 'Blend between the cue mix and the main mix in your headphones.', action: 'cueMix' },
  'mixer.crossfader': { text: 'Blends the output between deck A and deck B.', action: 'crossfader' },
  'mixer.samplerVolume': {
    text: 'The sampler bank’s overall level — separate from each slot’s own gain. Goes straight to master, not through the crossfader.',
  },
  'mixer.samplerCue': { text: 'Send the sampler channel to the headphone cue mix.' },

  // — FX (v0.7.0) —
  'fx.effect': {
    text: 'Choose this rack’s effect: Delay, Echo, Reverb, or an auto filter-sweep. Separate from the static Filter knob on each channel.',
    action: 'fxEffect',
  },
  'fx.wetDry': { text: 'Blend between the dry signal and the effect.', action: 'fxWetDry' },
  'fx.time': {
    text: 'How long the effect takes, synced to the beat — 1/4 to 4 beats.',
    action: 'fxTime',
  },
  'fx.on': { text: 'Turn this FX rack on or off.', action: 'fxOn' },
  'fx.route': {
    text: 'Where this rack sits: on its own channel (also heard in cue) or on the master mix.',
    action: 'fxRoute',
  },

  // — beat grid panel —
  'beatgrid.nudge': { text: 'Shift the whole grid earlier or later without changing its BPM.' },
  'beatgrid.halveDouble': {
    text: 'Halve or double the detected BPM — fixes a grid found at half or double the real tempo.',
  },
  'beatgrid.tap': { text: 'Tap along with the beat a few times to set BPM by ear.' },
  'beatgrid.setDownbeat': { text: 'Mark the current playhead position as beat one of a bar.' },

  // — top bar —
  'topbar.startEngine': {
    text: 'Starts the audio engine. Browsers require a click before any sound can play.',
  },
  'topbar.output': { text: 'Which sound card SoundGrid plays through.' },
  'topbar.quantize': { text: 'Snap cue points and loops to the nearest beat on the grid.' },
  'topbar.connectMidi': { text: 'Reconnect to the DDJ-FLX4 if it was plugged in after the page loaded.' },
  'topbar.settings': {
    text: 'Controller calibration, feel, display and library preferences — and this Hint mode toggle.',
  },
  'topbar.ai': {
    text: 'Type a command in plain language, e.g. "loop 8 beats on deck A". Always asks before doing anything. Off by default.',
  },
  'topbar.recordMaster': {
    text: 'Records everything coming out of the master mix (both decks, FX included) to a WAV file. Mouse only for now.',
  },
  'topbar.recordMasterMark': {
    text: 'Marks where the next track starts, so the saved recording splits into one file per track instead of one long file.',
  },

  // — library —
  'library.folder': { text: 'Pick the folder SoundGrid scans for tracks.' },
  'library.addFiles': { text: 'Add individual track files without scanning a whole folder.' },
  'library.mixOnly': { text: 'Show only tracks that mix well with what’s currently playing.' },
  'library.played': {
    text: 'Suggested tracks you already loaded to a deck this session sit at the bottom, marked ✓. Click to hide them, click again to show them.',
  },
  'library.search': { text: 'Filter the track list by title, artist or genre.' },
  'library.rows': {
    text: 'Click a row to select it, or drag it onto a deck to load. Click the Genre cell to change it. The two buttons on the right load straight to deck A or B.',
  },
} as const satisfies Record<string, HintSpec>

/** Exported for `tests/core/hints.test.ts` — not meant to be read elsewhere; call `hint()`. */
export { HINT_BASE }

export type HintId = keyof typeof HINT_BASE

/** The hint text for one control, with its FLX4 line appended when it has one. */
export function hint(id: HintId): string {
  const spec: HintSpec = HINT_BASE[id]
  const hw = spec.action ? flx4Label(spec.action, spec.param) : null
  return hw ? `${spec.text} Also on FLX4: ${hw}.` : spec.text
}
