import * as ctl from '@/controls'
import { useStore } from '@/app/state/store'
import { LONG_PRESS_MS } from '@/core/constants'
import { FX_TIME_STEPS } from '@/core/fx'
import type { DeckId, PadMode } from '@/core/types'
import { FLX4_MAPPING } from '@/platform/transport-webmidi/mappings/flx4'
import {
  bindingKey,
  parseMessage,
  browseDelta,
  relativeDelta,
  type Binding,
  type MidiMapping,
} from '@/core/mapping/mapping'
import { get, set } from 'idb-keyval'

const CUSTOM_KEY = 'deckmix:midiMapping'

/**
 * `padMode`'s `param` (0..3) to a `PadMode`, in the order the FLX4's 4
 * physical mode-select buttons are bound in `mappings/flx4.ts` (Hot Cue /
 * Pad FX1 / Beat Jump / Sampler). A translation table, not a decision — the
 * decision (which 4 modes, in which order) lives in the mapping preset and
 * `core/types.ts`, not here.
 */
const PAD_MODES: PadMode[] = ['hotcue', 'loop', 'beatJump', 'sampler']

/** knob 0..127 -> -1..1 */
function bipolar(v: number, invert?: boolean) {
  const n = (v / 127) * 2 - 1
  return invert ? -n : n
}
/** knob 0..127 -> 0..1 */
function unipolar(v: number, invert?: boolean) {
  const n = v / 127
  return invert ? 1 - n : n
}

/** The FX beat-time knob is continuous hardware quantized to `FX_TIME_STEPS` in software — same "continuous knob, discrete steps" shape as the UI's cycle-button, just driven by position instead of taps. */
function nearestFxTimeStep(t: number) {
  const i = Math.round(t * (FX_TIME_STEPS.length - 1))
  return FX_TIME_STEPS[Math.max(0, Math.min(FX_TIME_STEPS.length - 1, i))]
}

class MidiManager {
  private access: MIDIAccess | null = null
  private mapping: MidiMapping = FLX4_MAPPING
  private cueHeld = new Map<DeckId, () => void>()
  /** Pad presses in progress, keyed `${deck}:${param}` — same shape as `cueHeld`, needed here (not just per-deck) because up to 8 pads per deck can be held independently (v0.5.0's Loop Roll). */
  private padHeld = new Map<string, () => void>()
  /** SYNC press timestamps (v0.3.0) — held past LONG_PRESS_MS promotes master. */
  private syncDownAt = new Map<DeckId, number>()
  private learnResolver: ((b: Omit<Binding, 'action'> & { key: string }) => void) | null =
    null

  async init(): Promise<void> {
    const { setMidi } = useStore.getState()
    if (typeof navigator.requestMIDIAccess !== 'function') {
      setMidi({ status: 'unsupported' })
      return
    }
    setMidi({ status: 'requesting' })
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false })
    } catch {
      setMidi({ status: 'denied' })
      return
    }
    const custom = await get<MidiMapping>(CUSTOM_KEY)
    if (custom) this.mapping = custom

    this.access.onstatechange = () => this.refreshDevices()
    this.attachInputs()
    this.refreshDevices()
    setMidi({ status: 'ready' })
  }

  private attachInputs() {
    if (!this.access) return
    this.access.inputs.forEach((input) => {
      input.onmidimessage = (e) => this.handle(e)
    })
  }

  private refreshDevices() {
    if (!this.access) return
    this.attachInputs()
    const devices = Array.from(this.access.inputs.values()).map((i) => ({
      id: i.id,
      name: i.name ?? 'Unknown',
      manufacturer: i.manufacturer ?? '',
    }))
    useStore.getState().setMidi({ devices })
  }

  private handle(e: MIDIMessageEvent) {
    const data = e.data
    if (!data) return
    const msg = parseMessage(data)
    if (!msg) return

    const key = bindingKey(msg.type, msg.channel, msg.data1)
    useStore.getState().setMidi({
      lastMessage: `${msg.type} ch${msg.channel + 1} #${msg.data1} = ${msg.data2}`,
    })

    if (this.learnResolver) {
      const mode: Binding['mode'] =
        msg.type === 'note' ? 'button' : 'absolute'
      this.learnResolver({ key, mode })
      this.learnResolver = null
      return
    }

    const binding = this.mapping.bindings[key]
    if (!binding) return
    this.dispatch(binding, msg.data2)
  }

  private dispatch(b: Binding, value: number) {
    const deck = b.deck as DeckId | undefined
    switch (b.action) {
      case 'play':
        if (value > 0 && deck) ctl.togglePlay(deck)
        break
      case 'cue':
        if (!deck) break
        if (value > 0) {
          this.cueHeld.set(deck, ctl.cuePlayPreview(deck))
        } else {
          this.cueHeld.get(deck)?.()
          this.cueHeld.delete(deck)
          ctl.cue(deck)
        }
        break
      case 'sync':
        // A tap toggles phase-lock to the master deck; a press held past
        // LONG_PRESS_MS makes this deck the master instead (v0.3.0), checked
        // at release rather than a live timer — robust to a dropped note-off
        // and consistent with cueHeld's own release-driven pattern above.
        if (!deck) break
        if (value > 0) {
          this.syncDownAt.set(deck, performance.now())
        } else {
          const downAt = this.syncDownAt.get(deck)
          this.syncDownAt.delete(deck)
          if (downAt != null && performance.now() - downAt >= LONG_PRESS_MS) ctl.setMasterDeck(deck)
          else ctl.syncDeck(deck)
        }
        break
      case 'load':
        if (value > 0 && deck) {
          const t = ctl.selectedTrack()
          if (t) void ctl.loadTrackToDeck(deck, t)
        }
        break
      case 'beatShift':
        if (value > 0 && deck) ctl.shiftDeckByBeat(deck, (b.param ?? 1) === -1 ? -1 : 1)
        break
      case 'tempo':
        if (deck) ctl.setTempo(deck, bipolar(value, b.invert))
        break
      case 'jog':
        if (deck) ctl.jogTurn(deck, relativeDelta(value, this.mapping.relativeEncoding))
        break
      case 'jogTouch':
        if (deck) ctl.jogTouch(deck, value > 0)
        break
      case 'hotcue': {
        // Wire name kept as `'hotcue'` even though this is now "pad press,
        // mode-interpreted" (v0.5.0) — renaming it would silently break any
        // Learn-saved custom mapping a user already has for a hot-cue pad
        // (`CUSTOM_KEY` in idb-keyval stores this exact string). `ctl.pressPad`
        // does the mode interpretation; this stays a dumb press/release
        // translator, same shape as `cueHeld` above — no branching on
        // `padMode` here, that would deepen the boundary violation this file
        // already carries (CLAUDE.md).
        if (!deck || b.param == null) break
        const key = `${deck}:${b.param}`
        if (value > 0) {
          this.padHeld.set(key, ctl.pressPad(deck, b.param))
        } else {
          this.padHeld.get(key)?.()
          this.padHeld.delete(key)
        }
        break
      }
      case 'padMode':
        if (value > 0 && deck && b.param != null) ctl.setPadMode(deck, PAD_MODES[b.param])
        break
      case 'shift':
        ctl.setShiftHeld(value > 0)
        break
      case 'loopToggle':
        if (value > 0 && deck) ctl.toggleLoop(deck)
        break
      case 'loopHalve':
        if (value > 0 && deck)
          ctl.setLoopBeats(deck, useStore.getState().decks[deck].loopBeats / 2)
        break
      case 'loopDouble':
        if (value > 0 && deck)
          ctl.setLoopBeats(deck, useStore.getState().decks[deck].loopBeats * 2)
        break
      case 'channelVolume':
        if (deck) ctl.setChannelVolume(deck, unipolar(value, b.invert))
        break
      case 'crossfader':
        ctl.setCrossfader(bipolar(value, b.invert))
        break
      case 'eqLow':
        if (deck) ctl.setEq(deck, 'low', bipolar(value, b.invert))
        break
      case 'eqMid':
        if (deck) ctl.setEq(deck, 'mid', bipolar(value, b.invert))
        break
      case 'eqHigh':
        if (deck) ctl.setEq(deck, 'high', bipolar(value, b.invert))
        break
      case 'filter':
        if (deck) ctl.setFilter(deck, bipolar(value, b.invert))
        break
      case 'masterVolume':
        ctl.setMasterVolume(unipolar(value, b.invert))
        break
      case 'cueVolume':
        ctl.setCueVolume(unipolar(value, b.invert))
        break
      case 'cueMix':
        ctl.setCueMix(unipolar(value, b.invert))
        break
      case 'cueMonitor':
        if (value > 0 && deck) ctl.toggleCueMonitor(deck)
        break
      case 'browse':
        ctl.moveSelection(browseDelta(value))
        break
      case 'browseEnter': {
        if (value > 0) {
          const t = ctl.selectedTrack()
          if (t) void ctl.loadTrackToDeck('A', t)
        }
        break
      }
      case 'fxEffect':
        if (value > 0 && b.rack != null && b.param != null) ctl.setFxEffect(b.rack, b.param)
        break
      case 'fxWetDry':
        if (b.rack != null) ctl.setFxWetDry(b.rack, unipolar(value, b.invert))
        break
      case 'fxTime':
        if (b.rack != null) ctl.setFxTime(b.rack, nearestFxTimeStep(unipolar(value, b.invert)))
        break
      case 'fxOn':
        if (value > 0 && b.rack != null) ctl.toggleFxOn(b.rack)
        break
      case 'fxRoute':
        if (value > 0 && b.rack != null) {
          const current = useStore.getState().fx[b.rack].route
          ctl.setFxRoute(b.rack, current === 'channel' ? 'master' : 'channel')
        }
        break
    }
  }

  /** Wait for the next incoming control and bind it to `action`. */
  learn(action: string): Promise<void> {
    useStore.getState().setMidi({ learning: action })
    return new Promise((resolve) => {
      this.learnResolver = ({ key, mode }) => {
        const [act, deck, param] = action.split(':')
        this.mapping = {
          // Spread the whole mapping, not just name + bindings. Learn used to
          // rebuild those two fields by hand, so `relativeEncoding` — added once
          // the FLX4's jogs were measured — would have been dropped the first
          // time anyone learned a control, and the wheels would have silently
          // gone back to reading 63 ticks per tick, backwards. A field added
          // later must not depend on someone remembering this line.
          ...this.mapping,
          name: `${this.mapping.name} (custom)`,
          bindings: {
            ...this.mapping.bindings,
            [key]: {
              action: act as Binding['action'],
              deck: (deck || undefined) as DeckId | undefined,
              param: param ? Number(param) : undefined,
              mode,
            },
          },
        }
        void set(CUSTOM_KEY, this.mapping)
        useStore.getState().setMidi({ learning: null })
        resolve()
      }
    })
  }

  cancelLearn() {
    this.learnResolver = null
    useStore.getState().setMidi({ learning: null })
  }

  async resetMapping() {
    this.mapping = FLX4_MAPPING
    await set(CUSTOM_KEY, null)
  }
}

export const midi = new MidiManager()
