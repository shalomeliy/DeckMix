import { Deck } from '@/platform/audio-webaudio/deck'
import { FxRack } from '@/platform/audio-webaudio/fx'
import { SamplerEngine } from '@/platform/audio-webaudio/sampler'
import { bootLatencyHint } from '@/platform/settings-idb/boot-latency'
import { equalPowerMix } from '@/core/fx'
import { RecorderTap } from '@/platform/audio-webaudio/recorder-tap'
// Bundled and transpiled by Vite, handed to addModule as a URL. The processor
// itself imports nothing: an AudioWorkletGlobalScope has no DOM, so a single
// transitive DOM-touching import turns into an opaque addModule rejection.
import scratchProcessorUrl from '@/platform/audio-webaudio/scratch-processor?worker&url'
import recorderProcessorUrl from '@/platform/audio-webaudio/recorder-processor?worker&url'
import fxProcessorUrl from '@/platform/audio-webaudio/fx-processor?worker&url'
import type { DeckId } from '@/core/types'

interface AudioContextWithSink extends AudioContext {
  setSinkId?: (id: string | { type: 'none' }) => Promise<void>
  sinkId?: string
}

/**
 * Global audio engine. Builds a 4-channel output bus so a DJ controller's
 * built-in interface can carry master on 1/2 and headphone cue on 3/4 — the
 * split a DJ controller's sound card expects. Falls back to a stereo master + software-monitored
 * cue when the output device only exposes 2 channels.
 */
export class AudioEngine {
  ctx: AudioContextWithSink
  decks: Record<DeckId, Deck>
  /** the sampler bank's playback engine (v0.6.0) — one instance, wired into the same master/cue split as the two decks. */
  sampler: SamplerEngine
  /** two global FX racks (v0.7.0) — rack 0 pairs with deck A, rack 1 with deck B, when channel-routed. See `setFxRouting`. */
  fx: [FxRack, FxRack]

  private masterBus: GainNode
  /**
   * What `wireOutput()` actually reads from — always present, downstream of
   * whatever's currently routed to master (nothing, by default: `masterBus`
   * connects to it directly). This is the seam `setFxRouting('master')`
   * splices a rack into, and the stable tap point v0.7.5's recording will
   * use, so FX always sits ahead of both.
   */
  private masterPostFx: GainNode
  private cueBus: GainNode
  private samplerBus: GainNode
  private samplerCueGain: GainNode
  private merger: ChannelMergerNode | null = null
  private stereoSum: GainNode | null = null
  private cueMix = 0
  private multichannel = false
  /** rack indices currently routed to master, in the fixed order they chain (0 then 1) — see `rebuildMasterChain`. */
  private masterChain: (0 | 1)[] = []

  constructor() {
    // Fixed for the life of the context — AudioContext takes latencyHint at
    // construction and offers no way to change it afterwards. That is why the
    // Settings field is marked `requiresReload` instead of appearing to apply,
    // and why this one value is read from the synchronous mirror rather than
    // from the settings store: see `boot-latency.ts`.
    this.ctx = new AudioContext({ latencyHint: bootLatencyHint() }) as AudioContextWithSink
    this.masterBus = this.ctx.createGain()
    this.masterPostFx = this.ctx.createGain()
    this.cueBus = this.ctx.createGain()
    this.decks = {
      A: new Deck(this.ctx, 'A'),
      B: new Deck(this.ctx, 'B'),
    }
    this.fx = [
      new FxRack(this.ctx, () => this.fxWorkletReady),
      new FxRack(this.ctx, () => this.fxWorkletReady),
    ]
    // Sampler channel (v0.6.0): its own bus, same master/cue split as a deck
    // (`faderGain`/`cueGain`), but connected straight to `masterBus` — the
    // crossfader is an A/B control and has no meaning for a sample bank.
    this.samplerBus = this.ctx.createGain()
    this.samplerCueGain = this.ctx.createGain()
    this.samplerCueGain.gain.value = 0
    this.sampler = new SamplerEngine(this.ctx, this.samplerBus)
    this.samplerBus.connect(this.masterBus)
    this.samplerBus.connect(this.samplerCueGain)
    this.samplerCueGain.connect(this.cueBus)
    // A worklet that dies mid-render takes its deck's audio with it, silently.
    // Route it to the same place a failed addModule goes, so the UI says so.
    for (const d of [this.decks.A, this.decks.B]) {
      d.onProcessorError = (reason) => {
        this.scratchError = `${reason} (deck ${d.id})`
        // A dead processor is not a working scratch engine, even though the
        // module is still loaded. Leaving workletReady true records the reason
        // in a field the UI never reads, because the pill is gated on
        // availability — the failure would stay silent for the second time.
        this.workletReady = false
        this.onScratchStateChange?.()
      }
    }
    this.decks.A.faderGain.connect(this.masterBus)
    this.decks.B.faderGain.connect(this.masterBus)
    this.decks.A.cueGain.connect(this.cueBus)
    this.decks.B.cueGain.connect(this.cueBus)
    this.rebuildMasterChain() // masterBus -> masterPostFx direct; no rack routed yet
    this.wireOutput()
  }

  private wireOutput() {
    this.merger?.disconnect()
    this.stereoSum?.disconnect()
    this.masterPostFx.disconnect()
    this.cueBus.disconnect()

    const maxCh = this.ctx.destination.maxChannelCount
    this.multichannel = maxCh >= 4

    if (this.multichannel) {
      this.ctx.destination.channelCount = 4
      this.ctx.destination.channelCountMode = 'explicit'
      this.ctx.destination.channelInterpretation = 'discrete'
      const merger = this.ctx.createChannelMerger(4)
      const splitM = this.ctx.createChannelSplitter(2)
      const splitC = this.ctx.createChannelSplitter(2)
      this.masterPostFx.connect(splitM)
      this.cueBus.connect(splitC)
      splitM.connect(merger, 0, 0)
      splitM.connect(merger, 1, 1)
      splitC.connect(merger, 0, 2)
      splitC.connect(merger, 1, 3)
      merger.connect(this.ctx.destination)
      this.merger = merger
    } else {
      // Stereo device: fold cue into master so the user still hears a preview.
      const sum = this.ctx.createGain()
      this.masterPostFx.connect(sum)
      this.cueBus.connect(sum)
      sum.connect(this.ctx.destination)
      this.stereoSum = sum
      this.applyCueMix()
    }
  }

  /**
   * Rebuild the chain between `masterBus` and `masterPostFx` from
   * `masterChain` — full teardown and relink, same disconnect-then-rebuild
   * shape `wireOutput()` already uses for the output-device stage, applied
   * here to the (much rarer) master-FX-routing stage instead. Independent
   * of `wireOutput()` on purpose: an output-device change must never drop a
   * rack that's routed to master, and a routing change must never touch the
   * output-device wiring.
   */
  private rebuildMasterChain() {
    this.masterBus.disconnect()
    for (const i of this.masterChain) this.fx[i].output.disconnect()
    let node: AudioNode = this.masterBus
    for (const i of this.masterChain) {
      node.connect(this.fx[i].input)
      node = this.fx[i].output
    }
    node.connect(this.masterPostFx)
  }

  /**
   * Route `fx[rackIndex]` to its paired deck's channel (before the fader/cue
   * split, so cue previews it — `Deck.setFxInsert`'s doc comment) or to the
   * master chain. Only ever one or the other: moving a rack always tears
   * down its previous spot first, so a rack can't end up inserted twice.
   */
  setFxRouting(rackIndex: 0 | 1, target: 'channel' | 'master') {
    const rack = this.fx[rackIndex]
    const deck = this.decks[rackIndex === 0 ? 'A' : 'B']
    deck.setFxInsert(null)
    this.masterChain = this.masterChain.filter((i) => i !== rackIndex)
    if (target === 'channel') {
      deck.setFxInsert(rack)
    } else {
      this.masterChain = [...this.masterChain, rackIndex].sort()
    }
    this.rebuildMasterChain()
  }

  get isMultichannel() {
    return this.multichannel
  }

  /** The time authority every Clock consumer ultimately reads. */
  get currentTime() {
    return this.ctx.currentTime
  }

  /**
   * Loads the scratch worklet, once. Resolves to false when it cannot be had —
   * the decks then stay on the AudioBufferSourceNode path, which plays
   * correctly but cannot scratch. That difference must reach the UI: a deck
   * that silently answers a scratch with a seek is the exact failure this
   * project forbids, so `scratchError` records why and is surfaced, not logged.
   */
  private workletLoad: Promise<boolean> | null = null
  private workletReady = false
  scratchError: string | null = null

  /**
   * Fired whenever scratch availability changes. Recording the reason is not
   * enough on its own: a worklet can die long after boot, and a field nobody
   * re-reads is the same silent failure the reporting was added to prevent.
   * `controls.ts` owns the subscription — this layer must not reach into the store.
   */
  onScratchStateChange?: () => void

  async ensureScratchEngine(): Promise<boolean> {
    if (!this.workletLoad) {
      this.workletLoad = (async () => {
        if (typeof AudioWorkletNode === 'undefined') {
          this.scratchError = 'this browser has no AudioWorklet'
          return false
        }
        try {
          await this.ctx.audioWorklet.addModule(scratchProcessorUrl)
          // addModule resolving is NOT proof the processor exists. Measured:
          // point it at a module that registers nothing and it still resolves
          // "ok" — the failure only surfaces later, when constructing the node
          // throws, by which time a deck already believes it can scratch. So
          // construct one here and throw it away. A probe node on a context
          // that is not connected to anything costs nothing and turns a
          // deferred, confusing failure into an immediate, named one.
          const probe = new AudioWorkletNode(this.ctx, 'scratch-player', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
          })
          if (!probe.parameters.get('rate')) {
            throw new Error("worklet loaded but exposes no 'rate' parameter")
          }
          probe.disconnect()
          this.decks.A.enableWorklet()
          this.decks.B.enableWorklet()
          this.workletReady = true
          return true
        } catch (err) {
          this.scratchError = err instanceof Error ? err.message : String(err)
          return false
        }
      })()
    }
    return this.workletLoad
  }

  /**
   * Whether the scratch engine loaded — not whether a deck is currently using
   * it. A deck only swaps player on its next `load`, so asking the deck would
   * answer "no" for every moment between boot and the first track.
   */
  get scratchAvailable() {
    return this.workletReady
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume()
    await this.ensureScratchEngine()
    await this.ensureFxWorklet()
  }

  /**
   * Loads the Bit Crusher/Roll worklet, once — same `addModule` +
   * throwaway-probe shape as `ensureScratchEngine`. Both processors share one
   * module load: if the module fails to register at all, neither effect can
   * work, so one boolean covers both rather than tracking per-effect state
   * for a platform-level failure that either affects both or neither.
   */
  private fxWorkletLoad: Promise<boolean> | null = null
  private fxWorkletReady = false
  fxWorkletError: string | null = null

  async ensureFxWorklet(): Promise<boolean> {
    if (!this.fxWorkletLoad) {
      this.fxWorkletLoad = (async () => {
        if (typeof AudioWorkletNode === 'undefined') {
          this.fxWorkletError = 'this browser has no AudioWorklet'
          return false
        }
        try {
          await this.ctx.audioWorklet.addModule(fxProcessorUrl)
          // addModule resolving is not proof either processor registered —
          // same lesson `ensureScratchEngine` already documents. Probe both.
          const crusherProbe = new AudioWorkletNode(this.ctx, 'bit-crusher', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
          })
          crusherProbe.disconnect()
          const rollProbe = new AudioWorkletNode(this.ctx, 'roll', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
          })
          rollProbe.disconnect()
          this.fxWorkletReady = true
          return true
        } catch (err) {
          this.fxWorkletError = err instanceof Error ? err.message : String(err)
          return false
        }
      })()
    }
    return this.fxWorkletLoad
  }

  get fxWorkletAvailable() {
    return this.fxWorkletReady
  }

  async listOutputs(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return []
    // Labels require a prior getUserMedia grant in most browsers.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach((t) => t.stop())
    } catch {
      /* user declined; we'll still return devices with blank labels */
    }
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === 'audiooutput')
  }

  async setOutputDevice(deviceId: string): Promise<'ok' | 'unsupported' | 'error'> {
    if (typeof this.ctx.setSinkId !== 'function') return 'unsupported'
    try {
      await this.ctx.setSinkId(deviceId)
      this.wireOutput()
      return 'ok'
    } catch (err) {
      console.error('setSinkId failed', err)
      return 'error'
    }
  }

  setMasterVolume(v: number) {
    this.masterBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01)
  }

  setSamplerVolume(v: number) {
    this.samplerBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01)
  }

  /** Send the sampler channel to the headphone cue mix, same on/off shape as a deck's `setCueMonitor`. */
  setSamplerCueMonitor(on: boolean) {
    this.samplerCueGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01)
  }

  setCueVolume(v: number) {
    this.cueBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01)
  }

  /** 0 = cue only in the phones, 1 = master only. Only meaningful in stereo-fold mode. */
  setCueMix(v: number) {
    this.cueMix = v
    this.applyCueMix()
  }

  private applyCueMix() {
    if (this.multichannel) return
    const now = this.ctx.currentTime
    this.masterBus.gain.setTargetAtTime(0.15 + 0.85 * this.cueMix, now, 0.01)
    this.cueBus.gain.setTargetAtTime(1 - this.cueMix, now, 0.01)
  }

  /** Equal-power crossfader. -1 => A only, +1 => B only. */
  setCrossfader(x: number) {
    const { dry: a, wet: b } = equalPowerMix((x + 1) / 2)
    const now = this.ctx.currentTime
    this.decks.A.faderGain.gain.setTargetAtTime(a, now, 0.005)
    this.decks.B.faderGain.gain.setTargetAtTime(b, now, 0.005)
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return await this.ctx.decodeAudioData(data)
  }

  /**
   * Loads the recorder-tap worklet, once — same `addModule` + throwaway-probe
   * shape as `ensureScratchEngine`, so a worklet that fails to register (or
   * loads but exposes nothing sane) is caught here, immediately, instead of
   * surfacing later as a recording that silently captures nothing.
   */
  private recorderWorkletLoad: Promise<boolean> | null = null
  private recorderWorkletReady = false
  recorderError: string | null = null

  async ensureRecorderEngine(): Promise<boolean> {
    if (!this.recorderWorkletLoad) {
      this.recorderWorkletLoad = (async () => {
        if (typeof AudioWorkletNode === 'undefined') {
          this.recorderError = 'this browser has no AudioWorklet'
          return false
        }
        try {
          await this.ctx.audioWorklet.addModule(recorderProcessorUrl)
          const probe = new AudioWorkletNode(this.ctx, 'recorder-tap', {
            numberOfInputs: 1,
            numberOfOutputs: 0,
          })
          probe.disconnect()
          this.recorderWorkletReady = true
          return true
        } catch (err) {
          this.recorderError = err instanceof Error ? err.message : String(err)
          return false
        }
      })()
    }
    return this.recorderWorkletLoad
  }

  get recorderAvailable() {
    return this.recorderWorkletReady
  }

  /**
   * One `RecorderTap` per call, tapping `masterPostFx` — the stable
   * post-FX point `masterPostFx`'s own doc comment reserves for exactly
   * this (v0.7.0). Two calls (a sampler-slot capture and a master
   * recording) can run at once, each with its own node, its own chunk
   * stream, no shared mutable state.
   */
  async createMasterTap(): Promise<RecorderTap> {
    const ok = await this.ensureRecorderEngine()
    if (!ok) throw new Error(this.recorderError ?? 'recorder engine unavailable')
    // masterPostFx is always stereo — wireOutput()'s multichannel branch
    // splits it into 2 channels either way, it only changes what happens
    // downstream at the destination, not this node's own channel count.
    return new RecorderTap(this.ctx, this.masterPostFx, 2)
  }
}

export const engine = new AudioEngine()
