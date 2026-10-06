import { describe, expect, it } from 'vitest'
import { git, read, requireGit } from './repo.ts'
import { HINT_BASE, type HintId } from '@/core/hints.ts'

/**
 * v0.8.24: every gesture the UI answers to but doesn't show — a modifier
 * click, a double-click, a drag, a drop, a keyboard key — is named in
 * `core/hints.ts`'s gesture table, which Hint mode and the Keys screen both
 * read. Until then Shift+click deleted a hot cue with nothing on any screen
 * saying so, and the pad grid's explanation was a 70-word hint shown nowhere.
 *
 * A new handler in `src/app` fails here until it is either named against the
 * hint that lists its gesture, or exempted with a reason — the same "named
 * set, not omission" rule `COMPANION_EXT` follows in the library scan.
 */

// Wide on purpose (v0.8.24 review): any variable's modifier flags, not just
// `e.`; key/double-click/wheel/context-menu props, capture variants included;
// and window-level listeners, which is where App.tsx's own keys live.
const HANDLER =
  /\b\w+\.(?:shiftKey|altKey|ctrlKey|metaKey)\b|getModifierState|on(?:DoubleClick|ContextMenu|Wheel|KeyDown|KeyUp)(?:Capture)?=|addEventListener\('(?:dblclick|keydown|keyup|wheel|contextmenu)'|\bdraggable\b|onDrop=/g

type Named = { token: string; count: number; gesture: HintId } | { token: string; count: number; exempt: string }

const ESC_CLOSES = 'Esc closes this screen — said on the screen itself ("Esc to close")'
const ENTER_ACTIVATES = 'Enter/Space activate a focused control, the way every button does'

const NAMED: Record<string, Named[]> = {
  'src/app/App.tsx': [
    { token: "addEventListener('keydown'", count: 1, exempt: 'the global keys — checked key by key in the last test below' },
    { token: "addEventListener('keyup'", count: 1, exempt: 'release half of the same global keys' },
  ],
  'src/app/components/PadGrid.tsx': [
    { token: 'e.shiftKey', count: 1, gesture: 'pads.hotcue' },
    { token: 'e.altKey', count: 1, gesture: 'pads.hotcue' },
    // two on the sampler pad: pointerdown captures Alt so the click that
    // follows can rename instead of triggering
    { token: 'e.altKey', count: 2, gesture: 'pads.sampler' },
    { token: 'draggable', count: 1, gesture: 'pads.hotcue' },
    { token: 'onDrop=', count: 2, gesture: 'pads.sampler' },
    { token: 'onKeyDown=', count: 1, gesture: 'pads.hotcue' }, // F2 renames
    { token: 'onKeyDown=', count: 2, exempt: 'Enter saves / Escape cancels inside the open rename box' },
  ],
  'src/app/components/Library.tsx': [
    { token: 'draggable', count: 1, gesture: 'library.rows' },
    { token: 'onDoubleClick=', count: 1, gesture: 'library.rows' },
    { token: 'onDoubleClick=', count: 3, exempt: 'stops a row double-click inside the genre/note cell editors and on the ↗ Beatport link' },
    { token: 'onKeyDown=', count: 1, gesture: 'library.rows' },
    { token: 'onKeyDown=', count: 1, gesture: 'library.search' }, // Esc: tag first, then text
    // v0.9.41: the "no artist" view's Artist cell
    { token: 'onDoubleClick=', count: 1, exempt: 'stops a row double-click on the artist suggestion ✓/✕ buttons from loading the track' },
    { token: 'onKeyDown=', count: 1, exempt: 'Enter saves the artist typed into the "type artist…" box, Esc empties it' },
    { token: 'onDoubleClick=', count: 1, exempt: 'stops a double-click on the ↶ undo of an owner-set artist from loading the track' },
  ],
  // v0.9.36: the Genre ▾ list (v0.9.24) moved here, shared with every column's ▾
  'src/app/components/ColumnFilter.tsx': [
    { token: "addEventListener('keydown'", count: 1, exempt: `column ▾ lists: ${ESC_CLOSES}` },
  ],
  // v0.9.34: the bar on the track list's top edge.
  'src/app/components/LibraryResizeHandle.tsx': [
    { token: 'onDoubleClick=', count: 1, gesture: 'library.resize' },
    { token: 'onKeyDown=', count: 1, gesture: 'library.resize' },
  ],
  'src/app/components/SourceCheckPanel.tsx': [{ token: 'onKeyDown=', count: 1, gesture: 'library.checkSource' }],
  'src/app/components/Deck.tsx': [{ token: 'onDrop=', count: 1, gesture: 'library.rows' }],
  // v0.9.10b: the vocal strip's mark edges — drag, Shift = finer (once in the drag, once in the wheel nudge), wheel.
  'src/app/components/VocalStrip.tsx': [
    { token: 'e.shiftKey', count: 2, gesture: 'deck.vocalStrip' },
    { token: 'onWheel=', count: 1, gesture: 'deck.vocalStrip' },
  ],
  'src/app/components/Waveform.tsx': [
    // v0.8.28: wheel = quarter beat, Shift+wheel = whole beat
    { token: "addEventListener('wheel'", count: 1, gesture: 'deck.waveform' },
    // two: Shift picks the whole-beat step, and reads Chromium's Shift+wheel deltaX
    { token: 'e.shiftKey', count: 2, gesture: 'deck.waveform' },
  ],
  'src/app/components/CratesRail.tsx': [
    { token: 'onDrop=', count: 1, gesture: 'library.rows' },
    { token: 'onKeyDown=', count: 1, exempt: ENTER_ACTIVATES },
  ],
  'src/app/components/AiControlBar.tsx': [{ token: 'onKeyDown=', count: 1, exempt: 'Enter sends the typed command' }],
  'src/app/components/controls.tsx': [
    { token: 'onDoubleClick=', count: 1, gesture: 'mixer.eqHigh' },
    { token: 'onKeyDown=', count: 2, gesture: 'mixer.eqHigh' }, // knob + fader arrow steps
    { token: 'onKeyDown=', count: 1, exempt: 'Escape hides an open hint bubble' },
  ],
  'src/app/components/KeysScreen.tsx': [{ token: "addEventListener('keydown'", count: 1, exempt: ESC_CLOSES }],
  'src/app/components/SetHistory.tsx': [{ token: "addEventListener('keydown'", count: 1, exempt: ESC_CLOSES }],
  'src/app/components/Settings.tsx': [{ token: "addEventListener('keydown'", count: 1, exempt: ESC_CLOSES }],
  'src/app/components/TaggingScreen.tsx': [
    { token: "addEventListener('keydown'", count: 1, exempt: ESC_CLOSES },
    // v0.9.1: arrows move the "1", Shift makes the step small, Space plays
    { token: "addEventListener('keydown'", count: 1, gesture: 'tagging.marker' },
    { token: 'e.shiftKey', count: 1, gesture: 'tagging.marker' },
    { token: "addEventListener('keyup'", count: 1, exempt: 'swallows Space on release, so a still-focused button is not pressed by it' },
    // v0.9.11: Space plays the clip, 1 / 2 / 3 answer it (physical keys, so a Hebrew layout works)
    { token: "addEventListener('keydown'", count: 1, gesture: 'tagging.vocal' },
    { token: "addEventListener('keyup'", count: 1, exempt: 'swallows Space on release, so a still-focused button is not pressed by it' },
    { token: 'e.ctrlKey', count: 1, exempt: 'a modifier guard, not a gesture: Ctrl/Alt/Meta + a digit is left to the browser' },
    { token: 'e.metaKey', count: 1, exempt: 'a modifier guard, not a gesture: Ctrl/Alt/Meta + a digit is left to the browser' },
    { token: 'e.altKey', count: 1, exempt: 'a modifier guard, not a gesture: Ctrl/Alt/Meta + a digit is left to the browser' },
  ],
}

/** Comments name gestures too ("already draggable"); only code counts. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const count = (src: string): Map<string, number> => {
  const m = new Map<string, number>()
  for (const [t] of src.matchAll(HANDLER)) m.set(t, (m.get(t) ?? 0) + 1)
  return m
}

describe('every hidden gesture in src/app is named in the gesture table', () => {
  it('each file has exactly the handlers named for it', () => {
    requireGit()
    const files = git('ls-files', 'src/app').split('\n').filter((f) => /\.tsx?$/.test(f))
    for (const f of files) {
      const found = Object.fromEntries(count(stripComments(read(f))))
      const named: Record<string, number> = {}
      for (const n of NAMED[f] ?? []) named[n.token] = (named[n.token] ?? 0) + n.count
      expect(found, `${f}: a gesture handler was added or removed — name it in NAMED and in core/hints.ts`).toEqual(named)
    }
  })

  it('each named gesture points at a hint that lists gestures', () => {
    for (const list of Object.values(NAMED)) {
      for (const n of list) {
        if (!('gesture' in n)) continue
        const spec = HINT_BASE[n.gesture] as { gestures?: readonly unknown[] }
        expect(spec.gestures?.length ?? 0, `${n.gesture} lists no gestures`).toBeGreaterThan(0)
      }
    }
  })

  it('every keyboard key App.tsx answers to is in the gesture table', () => {
    const app = stripComments(read('src/app/App.tsx'))
    const codes = new Set([
      ...[...app.matchAll(/case '(\w+)'/g)].map((m) => m[1]),
      ...[...app.matchAll(/e\.code === '(\w+)'/g)].map((m) => m[1]),
      ...[...app.matchAll(/^\s+(Key\w):/gm)].map((m) => m[1]),
    ])
    const LABEL: Record<string, string> = {
      Semicolon: ';',
      ArrowUp: '↑',
      ArrowDown: '↓',
      BracketLeft: '[',
      BracketRight: ']',
      ShiftLeft: 'Shift',
      ShiftRight: 'Shift',
    }
    // Whole tokens, with "(deck A)" asides removed first — otherwise the
    // letter A is "named" by every row that mentions deck A.
    const keys = new Set(
      Object.values(HINT_BASE)
        .flatMap((s) => ((s as { gestures?: readonly { key?: string }[] }).gestures ?? []).map((g) => g.key ?? ''))
        .flatMap((k) => k.replace(/\([^)]*\)/g, ' ').split(/[\s/·,]+/)),
    )
    expect(codes.size).toBeGreaterThan(8)
    for (const code of codes) {
      const label = LABEL[code] ?? code.replace(/^Key/, '')
      expect(keys.has(label), `key ${code} (${label}) works but no gesture names it`).toBe(true)
    }
  })
})
