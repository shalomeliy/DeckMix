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
  /**
   * The gestures that work on this control but can't be seen on it (v0.8.24):
   * Shift+click, Alt+click, double-click, drag, a keyboard key. Listed here
   * and nowhere else — `hint()` prints them and the Keys screen tabulates
   * them from this same list, so the two can't disagree. Until v0.8.24 they
   * lived in prose (the pad grid's was ~70 words, and shown nowhere) and
   * Shift+click deleting a cue was on no screen at all.
   * `tests/repo/gestures-named.test.ts` fails when a handler in `src/app`
   * isn't named in this table.
   */
  gestures?: readonly Gesture[]
}

/** One hidden way to use a control. `action` fills the FLX4 column on the Keys screen. */
export interface Gesture {
  does: string
  mouse?: string
  key?: string
  action?: ControlAction
  param?: number
}

/** Shared by every knob, so the Keys screen lists each once, not once per knob. */
const KNOB_RESET: Gesture = { mouse: 'Double-click a knob', does: 'reset it to its default' }
const KNOB_STEP: Gesture = { key: 'Arrow keys on a focused knob or fader', does: 'move it one step' }

const HINT_BASE = {
  // — deck —
  'deck.cue': {
    text: 'Jump to the cue point. Hold to preview from cue, release to jump back.',
    action: 'cue',
    gestures: [{ key: 'A (deck A) · ; (deck B)', does: 'cue', action: 'cue' }],
  },
  'deck.play': {
    text: 'Play or pause the deck.',
    action: 'play',
    gestures: [{ key: 'Q (deck A) · P (deck B)', does: 'play / pause', action: 'play' }],
  },
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
  'deck.bpm': {
    text: 'Open the beat grid editor for this track.',
    gestures: [{ mouse: 'Click the BPM number', does: 'open the beat grid editor' }],
  },
  'deck.platter': {
    text: 'Drag sideways to scratch.',
    action: 'jog',
    gestures: [
      { mouse: 'Drag the platter sideways', does: 'scratch', action: 'jog' },
      { key: 'S / D (deck A) · K / L (deck B), held', does: 'bend the deck slower / faster' },
    ],
  },
  'deck.waveform': {
    text: 'Click to jump there. Drag it like a record, or use the mouse wheel to move the track in small steps.',
    gestures: [
      { mouse: 'Click the waveform', does: 'jump the playhead there' },
      { mouse: 'Drag the waveform sideways', does: 'move the track like a hand on a record', action: 'jog' },
      { mouse: 'Mouse wheel on the waveform', does: 'move the track a quarter beat per notch' },
      { mouse: 'Shift + mouse wheel on the waveform', does: 'move the track a whole beat per notch' },
    ],
  },
  // v0.12.0: the whole-track strip above the scrolling waveform.
  'deck.overview': {
    text: 'The whole track, start to end. The dark part has already played. Click to jump there, or drag along it to travel through the track.',
    gestures: [
      { mouse: 'Click the overview', does: 'jump the playhead there' },
      { mouse: 'Drag along the overview', does: 'travel through the track' },
    ],
  },
  // v0.9.1: the tagging screen's marker. Only while that screen shows a song's waveform.
  'tagging.marker': {
    text: 'Tagging: the yellow line is the "1". Click or drag on the waveform to move it; it snaps to the nearest beat.',
    gestures: [
      { mouse: 'Click or drag on the tagging waveform', does: 'put the "1" on the nearest beat' },
      { key: '← / →', does: 'move the "1" one beat (tagging screen)' },
      { key: 'Shift + ← / →', does: 'move the "1" a hundredth of a second, for a beat line that misses the hit (tagging screen)' },
      { key: 'Space', does: 'play from two bars before the "1", or stop (tagging screen)' },
    ],
  },
  // v0.9.11: the vocal tagging screen's keys. Physical keys, so they work on a Hebrew layout.
  'tagging.vocal': {
    text: 'Vocal tagging: answer the 5-second clip with the keys 1, 2 or 3, or play it with Space.',
    gestures: [
      { key: 'Space', does: 'play the 5-second clip (vocal tagging screen)' },
      { key: '1 / 2 / 3', does: 'answer: vocals / no vocals / not sure (vocal tagging screen)' },
    ],
  },
  // — pads, one hint per mode (v0.8.24; was one ~70-word hint shown nowhere) —
  'pads.hotcue': {
    text: 'Hot Cue: click an empty pad to set a cue at the playhead; click a set one to jump there. A "Mix in" pad runs the saved mix.',
    action: 'hotcue',
    gestures: [
      {
        mouse: 'Shift+click a set pad',
        key: 'hold Shift',
        does: 'delete the cue (the pads say "× delete" while Shift is held)',
        action: 'shift',
      },
      { mouse: '× on a set pad', does: 'delete the cue' },
      { mouse: '✎ on a set pad, or Alt+click', key: 'F2 on a focused set pad', does: 'rename the cue' },
      { mouse: 'Drag a pad onto another', does: 'move the cue there, or swap the two' },
    ],
  },
  'pads.loop': {
    text: 'Loop: each pad starts or stops a loop of that many beats.',
    action: 'hotcue',
    gestures: [
      {
        mouse: 'Shift+pad',
        key: 'hold Shift',
        does: 'Loop Roll — loops only while held, then carries on where the track would have been',
        action: 'shift',
      },
    ],
  },
  'pads.beatJump': {
    text: 'Beat Jump: each pad jumps the playhead forward that many beats.',
    action: 'hotcue',
    gestures: [{ mouse: 'Shift+pad', key: 'hold Shift', does: 'jump backward instead', action: 'shift' }],
  },
  'pads.sampler': {
    text: 'Sampler: press a loaded pad to play its sample. Hover a pad for its mode, gain, sync and clear controls.',
    action: 'hotcue',
    gestures: [
      { mouse: 'Drag a library track onto a pad', does: 'load it into that slot' },
      { mouse: 'Shift+pad', key: 'hold Shift', does: 'reach slots 9–16', action: 'shift' },
      { mouse: 'Alt+click a loaded pad', does: 'rename the slot' },
    ],
  },
  'deck.padMode': {
    text: 'Switch what this deck’s pad grid does: Hot Cue, Loop, Beat Jump, or Sampler.',
    action: 'padMode',
  },
  'deck.shift': {
    text: 'Hold for each pad mode’s second action: jump back, Loop Roll, sampler slots 9–16, delete a hot cue.',
    action: 'shift',
    gestures: [{ key: 'Shift', does: 'hold for the pads’ second action', action: 'shift' }],
  },

  // — mixer —
  'mixer.eqHigh': { text: 'High-frequency cut/boost. Fully down, it cuts the highs completely.', action: 'eqHigh', gestures: [KNOB_RESET, KNOB_STEP] },
  'mixer.eqMid': { text: 'Mid-frequency cut/boost.', action: 'eqMid', gestures: [KNOB_RESET, KNOB_STEP] },
  'mixer.eqLow': { text: 'Low-frequency cut/boost. Fully down, it cuts the bass completely.', action: 'eqLow', gestures: [KNOB_RESET, KNOB_STEP] },
  'mixer.filter': { text: 'Sweeps a high-pass/low-pass filter across the channel.', action: 'filter', gestures: [KNOB_RESET, KNOB_STEP] },
  'mixer.channelVolume': { text: 'This channel’s level into the mix.', action: 'channelVolume' },
  'mixer.masterVolume': { text: 'Overall output level.', action: 'masterVolume' },
  'mixer.cueVolume': { text: 'Headphone cue level.', action: 'cueVolume' },
  'mixer.cueMix': { text: 'Blend between the cue mix and the main mix in your headphones.', action: 'cueMix' },
  'mixer.crossfader': { text: 'Blends the output between deck A and deck B.', action: 'crossfader' },
  'mixer.samplerVolume': {
    text: 'The sampler bank’s overall level — separate from each slot’s own gain. Goes straight to master, not through the crossfader.',
  },
  'mixer.samplerCue': { text: 'Send the sampler channel to the headphone cue mix.' },

  // — FX (v0.7.0, extended in v0.8.13) —
  'fx.effect': {
    text: 'Choose this rack’s effect: Delay, Echo, Reverb, an auto filter-sweep, Bit Crusher, Roll, Flanger or Phaser. Separate from the static Filter knob on each channel.',
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
  'topbar.output': { text: 'Which sound card DeckMix plays through.' },
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
  'library.folder': { text: 'Pick the folder DeckMix scans for tracks.' },
  'library.addFiles': { text: 'Add individual track files without scanning a whole folder.' },
  'library.mixOnly': {
    text: 'Show only tracks that mix well with what’s currently playing. Filled dot = tight match, ring = looser, ✓ = already loaded this set. Unless you sort by a column, tight matches come first, then looser ones, then the ✓ ones. Select a row to see why it was suggested.',
  },
  'library.played': {
    text: 'Suggested tracks you already loaded to a deck this session sit at the bottom, marked ✓. Click to hide them, click again to show them.',
  },
  'library.excellentMatches': {
    text: 'Tracks that followed what’s playing now in a transition you once rated excellent. This is different from the table below: clicking a track here loads it and runs the whole mix right away, entering at the point that worked last time — it doesn’t just load the track.',
  },
  'library.search': {
    text: 'Filter the track list by title, artist, genre or key, or a BPM range like 120-130.',
    gestures: [
      { mouse: '⌕ in a column header (Title, Artist, BPM, Key)', does: 'search that column only — the box shows its tag, e.g. "BPM ▸"' },
      { key: 'Esc in the search box', does: 'drop the column tag first, then clear the text' },
    ],
  },
  'library.checkSource': {
    text: 'Check this track’s BPM and key against Beatport. Opens a Beatport search for the artist and title in a new tab, and this panel, where you type what Beatport shows. Nothing changes until you press Update. Values you type lose the * or ? mark and survive a rescan; Back to original drops them. Turn the ↗ on or off in Settings › Library.',
    gestures: [
      { key: 'Enter in a field', does: 'update' },
      { key: 'Esc', does: 'close the panel, keeping ours' },
    ],
  },
  'library.rows': {
    text: 'Click a row to select it. Click the Genre cell to change it. The two buttons on the right load straight to deck A or B. With Settings › Library › Check BPM and key against Beatport on, ↗ beside the BPM checks it.',
    gestures: [
      { mouse: 'Double-click a row', does: 'load it (a suggestion goes to the empty deck, otherwise deck A)' },
      { mouse: 'Drag a row onto a deck', does: 'load it there' },
      { mouse: 'Drag a row onto a crate', does: 'add it to that crate' },
      { key: '↑ / ↓', does: 'select the previous / next track' },
      { key: 'Enter or Space on a focused row', does: 'select it' },
      { key: '[ / ]', does: 'load the selected track to deck A / B' },
    ],
  },
} as const satisfies Record<string, HintSpec>

/** Exported for `tests/core/hints.test.ts` — not meant to be read elsewhere; call `hint()`. */
export { HINT_BASE }

export type HintId = keyof typeof HINT_BASE

/** How a gesture is done, mouse first: `Shift+click a set pad / hold Shift`. */
function gestureHow(g: Gesture): string {
  return [g.mouse, g.key].filter(Boolean).join(' / ')
}

/** The hint text for one control, then its hidden gestures, then its FLX4 line when it has one. */
export function hint(id: HintId): string {
  const spec: HintSpec = HINT_BASE[id]
  const gestures = (spec.gestures ?? []).map((g) => ` ${gestureHow(g)} → ${g.does}.`).join('')
  const hw = spec.action ? flx4Label(spec.action, spec.param) : null
  return `${spec.text}${gestures}${hw ? ` Also on FLX4: ${hw}.` : ''}`
}

export type GesturePlace = 'Deck' | 'Pads' | 'Mixer' | 'Library'

export interface GestureRow {
  place: GesturePlace
  does: string
  mouse: string | null
  key: string | null
  flx4: string | null
}

const PLACE_BY_PREFIX: Record<string, GesturePlace | undefined> = {
  deck: 'Deck',
  beatgrid: 'Deck',
  pads: 'Pads',
  mixer: 'Mixer',
  fx: 'Mixer',
  library: 'Library',
}

const PLACE_ORDER: GesturePlace[] = ['Deck', 'Pads', 'Mixer', 'Library']

/**
 * Every gesture in `HINT_BASE`, as the Keys screen's rows — grouped by where
 * it works, a shared gesture (`KNOB_RESET`) listed once. The FLX4 column is
 * `flx4Label`'s live answer, never typed here.
 */
export function gestureTable(): GestureRow[] {
  const seen = new Set<Gesture>()
  const rows: GestureRow[] = []
  for (const [id, spec] of Object.entries(HINT_BASE) as [HintId, HintSpec][]) {
    const place = PLACE_BY_PREFIX[id.split('.')[0]]
    if (!place) continue
    for (const g of spec.gestures ?? []) {
      if (seen.has(g)) continue
      seen.add(g)
      rows.push({
        place,
        does: g.does,
        mouse: g.mouse ?? null,
        key: g.key ?? null,
        flx4: g.action ? flx4Label(g.action, g.param) : null,
      })
    }
  }
  return rows.sort((a, b) => PLACE_ORDER.indexOf(a.place) - PLACE_ORDER.indexOf(b.place))
}
