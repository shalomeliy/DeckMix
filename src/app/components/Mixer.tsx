import { useEffect, useState } from 'react'
import * as ctl from '@/controls'
import { useFlash } from '@/app/state/flash'
import { useStore } from '@/app/state/store'
import type { DeckId } from '@/core/types'
import { Button, Fader, HintIcon, Knob } from '@/app/components/controls'
import { FX_EFFECTS, FX_TIME_STEPS, type FxEffect } from '@/core/fx'
import { engine } from '@/platform/audio-webaudio/engine'

const DECK_COLOR: Record<DeckId, string> = { A: 'var(--color-deck-a)', B: 'var(--color-deck-b)' }

const FX_EFFECT_LABEL: Record<FxEffect, string> = {
  delay: 'Delay',
  echo: 'Echo',
  reverb: 'Reverb',
  filter: 'Filter',
  bitcrusher: 'Crush',
  roll: 'Roll',
  flanger: 'Flanger',
  phaser: 'Phaser',
}

const REVERB_INDEX = FX_EFFECTS.indexOf('reverb')
const WORKLET_EFFECTS: ReadonlySet<FxEffect> = new Set(['bitcrusher', 'roll'])

/**
 * Whether `rack` can actually select `effectIndex` right now. Reverb depends
 * on its procedurally-generated impulse response (`FxRack.reverbAvailable`)
 * — read directly off the engine, not mirrored into the store, because it
 * settles once at construction (before React ever renders) and never
 * changes again. Bit Crusher/Roll depend on the FX worklet module, which
 * resolves *after* first render, so that one **is** store-mirrored
 * (`fxWorkletReady`) and passed in — reading it here directly off the
 * engine would miss the moment it flips from unavailable to available.
 */
function isFxEffectAvailable(rack: 0 | 1, effectIndex: number, fxWorkletReady: boolean) {
  if (effectIndex === REVERB_INDEX) return engine.fx[rack].reverbAvailable
  if (WORKLET_EFFECTS.has(FX_EFFECTS[effectIndex])) return fxWorkletReady
  return true
}

function fxTimeLabel(beats: number) {
  return beats < 1 ? `1/${Math.round(1 / beats)}` : `${beats}`
}

function nextAvailableEffect(rack: 0 | 1, from: number, fxWorkletReady: boolean) {
  for (let i = 1; i <= FX_EFFECTS.length; i++) {
    const next = (from + i) % FX_EFFECTS.length
    if (isFxEffectAvailable(rack, next, fxWorkletReady)) return next
  }
  return from
}

/**
 * One FX rack's compact strip (v0.7.0) — rack 0 pairs with deck A, rack 1
 * with deck B (`engine.ts`'s `setFxRouting`). Lives in the mixer column
 * next to its paired deck's `ChannelStrip`, not a full-height panel: the
 * design review found no free vertical/horizontal slot for one at this
 * layout's ~710px height.
 *
 * Effect and time are single cycle-buttons (tap to advance), not a row per
 * option — measured in the running app at 1536×710: a `PadGrid`-style
 * 4/5-button row per control pushed the deck panels' own content into
 * clipping (446px wanted, squeezed to 347px). A cycle-button is the
 * "dropdown-or-cycle-button" alternative the design review already named.
 */
function FxStrip({ rack, deckId }: { rack: 0 | 1; deckId: DeckId }) {
  const state = useStore((s) => s.fx[rack])
  const fxWorkletReady = useStore((s) => s.fxWorkletReady)
  const color = DECK_COLOR[deckId]
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span className="label self-center" style={{ color }}>
        FX
      </span>
      <span className="relative inline-flex">
        <Button
          variant="toggle"
          size="sm"
          tone={color}
          active
          onClick={() => ctl.setFxEffect(rack, nextAvailableEffect(rack, state.effect, fxWorkletReady))}
          aria-label="FX effect"
        >
          {FX_EFFECT_LABEL[FX_EFFECTS[state.effect]]}
        </Button>
        <HintIcon id="fx.effect" className="absolute -right-1.5 -top-1.5" />
      </span>
      <Knob
        label="Wet"
        size={30}
        min={0}
        max={1}
        value={state.wetDry}
        tone={color}
        onChange={(v) => ctl.setFxWetDry(rack, v)}
        hint="fx.wetDry"
        format={(v) => `${Math.round(v * 100)}`}
      />
      <span className="relative inline-flex">
        <Button
          variant="toggle"
          size="sm"
          tone={color}
          active
          onClick={() => {
            const i = FX_TIME_STEPS.indexOf(state.time as (typeof FX_TIME_STEPS)[number])
            ctl.setFxTime(rack, FX_TIME_STEPS[(i + 1) % FX_TIME_STEPS.length])
          }}
          aria-label="FX beat time"
        >
          {fxTimeLabel(state.time)}
        </Button>
        <HintIcon id="fx.time" className="absolute -right-1.5 -top-1.5" />
      </span>
      <div className="flex items-center gap-1">
        <span className="relative inline-flex">
          <Button
            variant="toggle"
            size="sm"
            active={state.on}
            tone="var(--color-live)"
            onClick={() => ctl.toggleFxOn(rack)}
            aria-label="FX on/off"
          >
            On
          </Button>
          <HintIcon id="fx.on" className="absolute -right-1.5 -top-1.5" />
        </span>
        <span className="relative inline-flex">
          <Button
            variant="toggle"
            size="sm"
            tone={color}
            active={state.route === 'master'}
            onClick={() => ctl.setFxRoute(rack, state.route === 'channel' ? 'master' : 'channel')}
            aria-label="FX routing"
          >
            {state.route === 'channel' ? deckId : 'Mst'}
          </Button>
          <HintIcon id="fx.route" className="absolute -right-1.5 -top-1.5" />
        </span>
      </div>
    </div>
  )
}

/**
 * Sampler channel strip (v0.6.0) — volume + cue send only, no EQ/filter:
 * the sample bank isn't a deck, and ROADMAP.md's spec for it is exactly
 * "gain + toward master/cue". Goes straight to `masterBus`, bypassing the
 * crossfader (an A/B-only control) — see `AudioEngine`'s constructor.
 */
function SamplerStrip() {
  const channel = useStore((s) => s.sampler.channel)
  return (
    <div className="flex flex-col items-center gap-2">
      <span
        className="grid h-4 w-4 place-items-center rounded-[var(--radius-xs)] text-[9px] font-bold text-black"
        style={{ background: 'var(--color-accent)' }}
      >
        S
      </span>
      <span className="relative inline-flex">
        <Button
          variant="toggle"
          size="sm"
          active={channel.cueMonitor}
          tone="var(--color-live)"
          onClick={ctl.toggleSamplerCueMonitor}
          aria-label="Sampler to cue"
        >
          Cue
        </Button>
        <HintIcon id="mixer.samplerCue" className="absolute -right-1.5 -top-1.5" />
      </span>
      <Fader
        label="Sampler"
        value={channel.volume}
        onChange={ctl.setSamplerChannelVolume}
        color="var(--color-accent)"
        length={92}
        hint="mixer.samplerVolume"
        format={(v) => `${Math.round(v * 100)}`}
      />
    </div>
  )
}

function ChannelStrip({ deckId }: { deckId: DeckId }) {
  const ch = useStore((s) => s.mixer.channels[deckId])
  const color = DECK_COLOR[deckId]
  return (
    <div className="flex flex-col items-center gap-2">
      <span
        className="grid h-4 w-4 place-items-center rounded-[var(--radius-xs)] text-[9px] font-bold text-black"
        style={{ background: color }}
      >
        {deckId}
      </span>
      {/* EQ + filter in a recessed well, laid out horizontally to keep the
          mixer short enough that the library still gets real estate */}
      <div className="flex items-start gap-1 rounded-[var(--radius-md)] bg-surface-0/60 px-2 py-1.5 shadow-[inset_0_0_0_1px_var(--color-hairline)]">
        <Knob label="Hi" size={30} value={ch.eqHigh} tone={color} onChange={(v) => ctl.setEq(deckId, 'high', v)} hint="mixer.eqHigh" />
        <Knob label="Mid" size={30} value={ch.eqMid} tone={color} onChange={(v) => ctl.setEq(deckId, 'mid', v)} hint="mixer.eqMid" />
        <Knob label="Low" size={30} value={ch.eqLow} tone={color} onChange={(v) => ctl.setEq(deckId, 'low', v)} hint="mixer.eqLow" />
        <div className="mx-0.5 h-9 w-px self-center bg-hairline" />
        <Knob label="Filter" size={30} value={ch.filter} tone="var(--color-accent)" onChange={(v) => ctl.setFilter(deckId, v)} hint="mixer.filter" />
      </div>
      <Fader
        label="Vol"
        value={ch.volume}
        onChange={(v) => ctl.setChannelVolume(deckId, v)}
        color={color}
        length={92}
        hint="mixer.channelVolume"
        format={(v) => `${Math.round(v * 100)}`}
      />
    </div>
  )
}

/**
 * What the handoff's button says about where B sings. v0.12.13: B's voice comes in on the bass swap again (`handoffSec`, the end of A's
 * transition), and A goes down after it; from v0.9.63 to v0.12.12 it came in when A was out (`endSec`).
 */
function handoffSingsText(t: { toDeckId: string; fromDeckId: string; handoffSec?: number | null }): string {
  return t.handoffSec != null ? `דק ${t.toDeckId} שר כשדק ${t.fromDeckId} יגיע ל-${ctl.formatMinSec(t.handoffSec)}` : 'מסירת שירה'
}

/**
 * The seconds left on the red cancel button (v0.9.33, the owner's request, 07/10): until the new song comes in while the mix waits for its
 * line, then until the mix is over. Whole seconds, rounded up, so it reads 1 until the very end and never shows 0 while the fade runs.
 */
function TransitionCountdown() {
  const [c, setC] = useState<{ to: 'join' | 'end'; sec: number } | null>(null)
  useEffect(() => {
    const tick = () => {
      const next = ctl.transitionCountdown()
      setC((prev) => (prev?.to === next?.to && prev?.sec === next?.sec ? prev : next))
    }
    tick()
    const id = window.setInterval(tick, 200)
    return () => window.clearInterval(id)
  }, [])
  if (!c) return null
  const sec = Math.ceil(c.sec - 1e-6)
  return (
    <span className="mx-1 inline-block rounded bg-black/25 px-1.5 tabular-nums" data-testid="mix-countdown">
      {c.to === 'join' ? `כניסה בעוד ${ctl.formatMinSec(sec)}` : `נגמר בעוד ${sec} שנ'`}
    </span>
  )
}

export function Mixer() {
  const mixer = useStore((s) => s.mixer)
  const activeTransition = useStore((s) => s.activeTransition)
  const compact = useStore((s) => s.libraryExpanded)
  const mixFlash = useFlash('mix')
  return (
    <section className={`panel flex flex-col items-center gap-2.5 overflow-hidden p-2.5${mixFlash ? ' press-flash' : ''}`}>
      <span className="label self-start">Mix</span>

      {/* Mix Assist (v0.4.6): fixed, always in the same spot, no menu, no
          confirmation dialog — ROADMAP.md is explicit this must be an
          instant emergency exit, not a click buried anywhere a DJ mid-set
          would have to hunt for it. Bigger and louder than every other
          control in this panel on purpose. */}
      {activeTransition && (
        <button
          type="button"
          onClick={() => ctl.cancelTransition()}
          className="w-full rounded-[var(--radius-md)] py-2.5 text-sm font-bold uppercase tracking-wide text-white shadow-[var(--shadow-control)] transition-transform active:translate-y-px"
          style={{ background: 'var(--color-danger)' }}
        >
          <TransitionCountdown />
          {activeTransition.aligning
            ? `דק ${activeTransition.toDeckId} מחכה למטה עד שהקיקים יושבים · ביטול`
            : activeTransition.handoffSec != null
            ? activeTransition.waitingForBar && activeTransition.waitingUntilSec != null
              ? `דק ${activeTransition.toDeckId} נכנס כשדק ${activeTransition.fromDeckId} יגיע ל-${ctl.formatMinSec(activeTransition.waitingUntilSec)} · ${activeTransition.swap ? 'החלפת שירה' : handoffSingsText(activeTransition)} · ביטול`
              : activeTransition.swap
                ? `החלפת שירה ב-${ctl.formatMinSec(activeTransition.handoffSec)} · ביטול`
                : `מסירת שירה · ${handoffSingsText(activeTransition)} · ביטול`
            : activeTransition.waitingUntilSec != null
            ? `Waiting for ${ctl.formatMinSec(activeTransition.waitingUntilSec)} · cancel`
            : activeTransition.waitingForBar
              ? 'Starting on next bar · cancel'
              : 'Cancel transition'}
        </button>
      )}

      <div className="flex items-start gap-4">
        <ChannelStrip deckId="A" />
        <FxStrip rack={0} deckId="A" />
        <FxStrip rack={1} deckId="B" />
        <ChannelStrip deckId="B" />
        <SamplerStrip />
      </div>

      {/* While the track list is pulled up (v0.9.34) the master knobs sit
          beside the crossfader instead of above it: with the decks' pads gone,
          that row is what would otherwise set the height of the whole top. */}
      <div className={compact ? 'mt-auto flex items-end gap-5 pt-1' : 'contents'}>
        <div className="flex items-center gap-4 pt-0.5">
          <Knob
            label="Master"
            size={32}
            value={mixer.masterVolume}
            min={0}
            max={1}
            tone="var(--color-grid-text)"
            onChange={ctl.setMasterVolume}
            hint="mixer.masterVolume"
            format={(v) => `${Math.round(v * 100)}`}
          />
          <LimiterLight />
          <Knob label="Cue Vol" size={32} value={mixer.cueVolume} min={0} max={1} tone="var(--color-live)" onChange={ctl.setCueVolume} hint="mixer.cueVolume" />
          <Knob label="Cue Mix" size={32} value={mixer.cueMix} min={0} max={1} tone="var(--color-live)" onChange={ctl.setCueMix} hint="mixer.cueMix" />
        </div>

        <div className={`flex flex-col items-center gap-1.5 ${compact ? '' : 'mt-auto w-full pt-2'}`}>
          <Fader
            value={mixer.crossfader}
            min={-1}
            max={1}
            vertical={false}
            onChange={ctl.setCrossfader}
            length={188}
            detent
            hint="mixer.crossfader"
          />
          <div className="flex w-[188px] justify-between">
            <span className="text-2xs font-bold" style={{ color: DECK_COLOR.A }}>
              A
            </span>
            <span className="label">Crossfader</span>
            <span className="text-2xs font-bold" style={{ color: DECK_COLOR.B }}>
              B
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}

/**
 * The master limiter at work (v0.9.33, `engine.ts`'s `limiter`): lit while it turns the output down by 1 dB or more. It only acts on the
 * moments two songs' peaks add up past full scale, and changing the sound without saying so is what this project forbids — so it says so.
 * Read ten times a second: the light is for a glance, not a meter.
 */
function LimiterLight() {
  // Only whole dB are kept: a raw reading changes every tick (−0.1 in silence) and would re-render the strip ten times a second for nothing.
  const [db, setDb] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setDb(Math.min(0, Math.round(engine.limiterReductionDb))), 100)
    return () => window.clearInterval(id)
  }, [])
  const on = db <= -1
  const text = on ? `הלימיטר מוריד עכשיו ${-db}dB משיאים, כדי שלא תהיה צריבה ברמקולים` : 'לימיטר: נדלק כששיאי הצליל עוברים את המקסימום'
  return (
    <span
      role="status"
      aria-label={text}
      className="text-2xs font-bold"
      style={{ color: on ? 'var(--color-warn)' : 'var(--color-grid-muted)', opacity: on ? 1 : 0.5 }}
      title={text}
      data-testid="limiter-light"
    >
      LIM
    </span>
  )
}
