import { bindingKey, type MidiMapping } from '@/core/mapping/mapping'

/**
 * Best-effort MIDI map for the Pioneer DDJ-FLX4.
 *
 * The FLX4 speaks MIDI (not HID) for its mapped controls. Deck 1 lives on MIDI
 * channel 0, deck 2 on channel 1; the mixer/browse section uses channel 6.
 * These note/CC numbers follow the layout Pioneer publishes for the FLX4, but
 * firmware revisions vary — use the MIDI monitor + Learn button in Settings to
 * fix any control that misfires.
 */

function deck(ch: number) {
  return {
    // transport
    [bindingKey('note', ch, 0x0b)]: { action: 'play' as const, deck: idx(ch), mode: 'button' as const },
    [bindingKey('note', ch, 0x0c)]: { action: 'cue' as const, deck: idx(ch), mode: 'button' as const },
    [bindingKey('note', ch, 0x58)]: { action: 'sync' as const, deck: idx(ch), mode: 'button' as const },
    [bindingKey('note', ch, 0x46)]: { action: 'load' as const, deck: idx(ch), mode: 'button' as const },
    // tempo fader (14-bit MSB only used here)
    [bindingKey('cc', ch, 0x00)]: { action: 'tempo' as const, deck: idx(ch), mode: 'absolute' as const, invert: true },
    // Jog wheel. The touch sensor is what tells scratch apart from bend, so it
    // is bound separately: note 0x36 goes high while a hand rests on the platter
    // top, and the CCs report rotation either way. **0x36 is confirmed on real
    // hardware** (2026-08-30, both decks) — it was a guess until then, and the
    // rest of this preset still is.
    [bindingKey('note', ch, 0x36)]: { action: 'jogTouch' as const, deck: idx(ch), mode: 'button' as const },
    //
    // **The two jog CCs are complementary, not duplicates — measured 30/08.**
    // 0x22 is the touch-sensitive top platter and 0x21 is the outer rim, and the
    // controller sends whichever one the hand is on: turning by the rim alone
    // produced 3188 messages on 0x21 and **not one** on 0x22, with note 0x36 never
    // firing. Binding both to `jog` is therefore right, and the deck sees one
    // continuous stream. Do not "fix" this by dropping one of them.
    [bindingKey('cc', ch, 0x22)]: { action: 'jog' as const, deck: idx(ch), mode: 'relative' as const },
    [bindingKey('cc', ch, 0x21)]: { action: 'jog' as const, deck: idx(ch), mode: 'relative' as const },
    // loop
    [bindingKey('note', ch, 0x14)]: { action: 'loopToggle' as const, deck: idx(ch), mode: 'button' as const },
    [bindingKey('note', ch, 0x12)]: { action: 'loopHalve' as const, deck: idx(ch), mode: 'button' as const },
    [bindingKey('note', ch, 0x13)]: { action: 'loopDouble' as const, deck: idx(ch), mode: 'button' as const },
    // performance pads — always the same 8 notes; what they do depends on
    // the deck's pad-grid mode (v0.5.0, `controls.ts`'s `pressPad`), not on
    // anything bound here. The wire action stays `'hotcue'` even for a pad
    // in a different mode (see `manager.ts`'s dispatch comment) — renaming
    // it would silently break an existing Learn-saved mapping.
    ...Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        bindingKey('note', ch + 7, 0x00 + i),
        { action: 'hotcue' as const, deck: idx(ch), param: i, mode: 'button' as const },
      ]),
    ),
    // pad-grid mode select (v0.5.0) — 4 physical buttons (Hot Cue / Pad FX1 /
    // Beat Jump / Sampler on the real unit), `param` indexing `PAD_MODES` in
    // `manager.ts` in that same order. **Not hardware-confirmed** — an
    // unmeasured guess like most of this file before 30/08; fix via the
    // Learn button in Settings if a press does nothing or hits the wrong pad.
    [bindingKey('note', ch, 0x1b)]: { action: 'padMode' as const, deck: idx(ch), param: 0, mode: 'button' as const },
    [bindingKey('note', ch, 0x1c)]: { action: 'padMode' as const, deck: idx(ch), param: 1, mode: 'button' as const },
    [bindingKey('note', ch, 0x1d)]: { action: 'padMode' as const, deck: idx(ch), param: 2, mode: 'button' as const },
    [bindingKey('note', ch, 0x1e)]: { action: 'padMode' as const, deck: idx(ch), param: 3, mode: 'button' as const },
  }
}

function idx(ch: number): 'A' | 'B' {
  return ch === 0 ? 'A' : 'B'
}

export const FLX4_MAPPING: MidiMapping = {
  name: 'Pioneer DDJ-FLX4',
  /**
   * Measured on the hardware (2026-08-30), not assumed: the jogs send 63 and 65,
   * one either side of 64, one message per tick. The preset shipped reading those
   * as two's-complement, which turned every tick into 63 the wrong way round.
   */
  relativeEncoding: 'offset-64',
  bindings: {
    ...deck(0),
    ...deck(1),
    // mixer (channel 6)
    [bindingKey('cc', 6, 0x13)]: { action: 'channelVolume', deck: 'A', mode: 'absolute' },
    [bindingKey('cc', 6, 0x14)]: { action: 'channelVolume', deck: 'B', mode: 'absolute' },
    [bindingKey('cc', 6, 0x1f)]: { action: 'crossfader', mode: 'absolute' },
    [bindingKey('cc', 6, 0x07)]: { action: 'eqHigh', deck: 'A', mode: 'absolute' },
    [bindingKey('cc', 6, 0x0b)]: { action: 'eqMid', deck: 'A', mode: 'absolute' },
    [bindingKey('cc', 6, 0x0f)]: { action: 'eqLow', deck: 'A', mode: 'absolute' },
    [bindingKey('cc', 6, 0x08)]: { action: 'eqHigh', deck: 'B', mode: 'absolute' },
    [bindingKey('cc', 6, 0x0c)]: { action: 'eqMid', deck: 'B', mode: 'absolute' },
    [bindingKey('cc', 6, 0x10)]: { action: 'eqLow', deck: 'B', mode: 'absolute' },
    [bindingKey('cc', 6, 0x17)]: { action: 'filter', deck: 'A', mode: 'absolute' },
    [bindingKey('cc', 6, 0x18)]: { action: 'filter', deck: 'B', mode: 'absolute' },
    [bindingKey('cc', 6, 0x09)]: { action: 'masterVolume', mode: 'absolute' },
    [bindingKey('cc', 6, 0x0d)]: { action: 'cueVolume', mode: 'absolute' },
    [bindingKey('cc', 6, 0x0e)]: { action: 'cueMix', mode: 'absolute' },
    [bindingKey('note', 6, 0x54)]: { action: 'cueMonitor', deck: 'A', mode: 'button' },
    [bindingKey('note', 6, 0x55)]: { action: 'cueMonitor', deck: 'B', mode: 'button' },
    // browse
    [bindingKey('cc', 6, 0x40)]: { action: 'browse', mode: 'relative' },
    [bindingKey('note', 6, 0x41)]: { action: 'browseEnter', mode: 'button' },
    // SHIFT (v0.5.0) — one physical button for the whole controller, not
    // per deck, so it lives here with the other shared/mixer controls
    // rather than inside `deck(ch)`. **Not hardware-confirmed.**
    [bindingKey('note', 6, 0x3f)]: { action: 'shift', mode: 'button' },
    // FX (v0.7.0) — two global racks (0 paired with deck A, 1 with deck B),
    // controls live in the mixer section like filter/EQ above, not inside
    // `deck(ch)`. `fxEffect` follows `padMode`'s shape (one button per
    // index, `param` selects `FX_EFFECTS[param]`). **None of this is
    // hardware-confirmed** — the FLX4's real Beat FX section layout was
    // never measured; fix via the Learn button in Settings if a press does
    // nothing or hits the wrong control.
    [bindingKey('cc', 6, 0x19)]: { action: 'fxWetDry', rack: 0, mode: 'absolute' },
    [bindingKey('cc', 6, 0x1a)]: { action: 'fxWetDry', rack: 1, mode: 'absolute' },
    [bindingKey('cc', 6, 0x1b)]: { action: 'fxTime', rack: 0, mode: 'absolute' },
    [bindingKey('cc', 6, 0x1c)]: { action: 'fxTime', rack: 1, mode: 'absolute' },
    [bindingKey('note', 6, 0x56)]: { action: 'fxOn', rack: 0, mode: 'button' },
    [bindingKey('note', 6, 0x57)]: { action: 'fxOn', rack: 1, mode: 'button' },
    [bindingKey('note', 6, 0x58)]: { action: 'fxRoute', rack: 0, mode: 'button' },
    [bindingKey('note', 6, 0x59)]: { action: 'fxRoute', rack: 1, mode: 'button' },
    ...Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [
        bindingKey('note', 6, 0x20 + i),
        { action: 'fxEffect' as const, rack: 0 as const, param: i, mode: 'button' as const },
      ]),
    ),
    ...Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [
        bindingKey('note', 6, 0x24 + i),
        { action: 'fxEffect' as const, rack: 1 as const, param: i, mode: 'button' as const },
      ]),
    ),
  },
}
