import { EQ_CUT_DB, tempoToRate } from '@/core/constants'
import { ISOLATOR_PATHS, bandGain } from '@/core/isolator'
import { BufferSourcePlayer, WorkletPlayer, type SourcePlayer } from '@/platform/audio-webaudio/players'
import type { FxRack } from '@/platform/audio-webaudio/fx'
import { settings } from '@/platform/settings-idb/store'
import type { DeckId } from '@/core/types'
import { keyLockSemitones } from '@/core/key-lock'
import type { StretchNode } from '@/platform/audio-webaudio/keylock'

/**
 * Spin-down, spin-up, tempo range and EQ depth are the user's now (Settings ›
 * brakeSec / spinUpSec / tempoRange / eqDb). The defaults still describe a
 * 1200: the feel DJs expect, and short enough that a stop reads as deliberate.
 *
 * Read at the moment of use, not cached in the deck. These fire on a button
 * press or a knob turn — human-rate events, not the 670-a-second jog path — so
 * there is nothing to gain from a local copy and a stale ramp time to lose.
 */

/** How long a pitch bend lingers after the last jog tick before easing back. */
const BEND_HOLD_MS = 90
/** And how long the ease back to grid speed takes. */
const BEND_RELEASE_SEC = 0.12
/**
 * Ceiling on `syncNudge`'s rate correction (v0.3.0), as a fraction of the
 * current playback rate. Bigger than `KEYBOARD_BEND` (a hand-driven bend the
 * DJ is actively watching, so 4% is plenty) because this one has to actually
 * converge on its own; smaller than the jog's bend ceiling because nobody's
 * hand is explaining why the pitch just moved, so it has to stay clearly
 * inaudible. Provisional — tuned against those two existing ceilings, not
 * measured on real hardware yet (see HANDOFF.md).
 */
const MAX_SYNC_BEND = 0.06

/**
 * One playback deck. Owns its Web Audio graph:
 *
 *   player -> head -> dry ----------------> trim -> isolator (low | mid | high, summed) -> filter -> channelGain
 *                 -> key lock (stretch) -> wet -^
 *        channelGain -> fxSeam -> faderGain -> (master bus)
 *                     -> fxSeam -> cueGain   -> (cue bus)
 *
 * Everything from `trim` onwards is fixed. The head of the chain is swappable:
 * a `WorkletPlayer` when the scratch worklet loaded, a `BufferSourcePlayer`
 * when it did not. Position stays sample-accurate either way, so it never
 * depends on the render loop's cadence.
 *
 * `fxSeam` (v0.7.0) is a bypass point, not a processing node itself: by
 * default `channelGain` feeds it directly (gain 1, nothing in between), so
 * cue and master hear exactly what they heard before this existed. When
 * `engine.ts` routes this deck's paired FX rack here (`setFxInsert`), the
 * rack is spliced in ahead of it instead — before the fader/cue split, so
 * cue previews the effect too, same as the dry signal always has.
 */
export class Deck {
  readonly id: DeckId
  private ctx: AudioContext

  private trim: GainNode
  /** v0.9.20: where the player plays into; `dry` and `wet` (through the key lock) take it on to `trim`, one at a time. */
  private head: GainNode
  private dry: GainNode
  private wet: GainNode
  private keyLockNode: StretchNode | null = null
  private keyLockLatencySec = 0
  private _keyLock = false
  private _keyShift = 0
  /**
   * Track seconds the player runs AHEAD of what is heard, while the key lock is in the path. The stretch takes `keyLockLatencySec` to turn
   * input into output, so a deck that played from where it is heard would sound that late against the other deck, and every bar line,
   * SYNC and Mix Assist join would land late by it. Instead the player is moved that far ahead and `position` subtracts it: what the app
   * reads as the position is what comes out of the speakers, keyed or not. Set when the deck starts, the key lock goes in, and on every
   * tempo move — there only the amount changes, the player does not move, so nothing is heard. The cost of running ahead: a start or a jump
   * skips its first `ahead` of audio (a kick's attack on a hot cue), the price of being on time. Zero while paused — the stretch empties its buffer after a stop, so the last thing heard is where the player stopped.
   */
  private ahead = 0
  /** v0.9.33: the EQ is an isolator (`core/isolator.ts`) — three bands that sum back to the song, each knob the volume of its own band. */
  private eqBands: Record<'low' | 'mid' | 'high', GainNode>
  private eqOut: GainNode
  private lpf: BiquadFilterNode
  private hpf: BiquadFilterNode
  private channelGain: GainNode
  private fxSeam: GainNode
  /** the FX rack currently spliced in ahead of `fxSeam`, if any — tracked so `setFxInsert` knows what to tear down. */
  private insertedFx: FxRack | null = null
  readonly faderGain: GainNode
  readonly cueGain: GainNode

  private player: SourcePlayer
  /** set by the engine once `addModule` has resolved; null means no scratch */
  private workletAvailable = false

  private _playing = false
  private _hasTrack = false
  private _durationSec = 0
  private _tempo = 0
  private _cueMonitor = false
  // on by default, as every DJ deck ships; the store's initial state matches
  private _vinylMode = true
  private _baseRate = 1
  private _scratching = false
  /** what play state to return to when the hand comes off the platter */
  private _resumePlaying = false
  private bendTimer = 0

  loopStart: number | null = null
  loopEnd: number | null = null

  onEnded?: () => void
  /** the scratch worklet died mid-render; the engine surfaces the reason */
  onProcessorError?: (reason: string) => void

  constructor(ctx: AudioContext, id: DeckId) {
    this.ctx = ctx
    this.id = id

    this.trim = ctx.createGain()
    this.head = ctx.createGain()
    this.dry = ctx.createGain()
    this.wet = ctx.createGain()
    this.wet.gain.value = 0
    this.head.connect(this.dry).connect(this.trim)
    this.wet.connect(this.trim)
    this.eqOut = ctx.createGain()
    this.eqBands = { low: ctx.createGain(), mid: ctx.createGain(), high: ctx.createGain() }
    for (const band of ['low', 'mid', 'high'] as const) {
      let node: AudioNode = this.trim
      for (const f of ISOLATOR_PATHS[band]) {
        const bq = ctx.createBiquadFilter()
        bq.type = f.type
        bq.frequency.value = f.freq
        bq.Q.value = f.q
        node = node.connect(bq)
      }
      node.connect(this.eqBands[band]).connect(this.eqOut)
    }
    this.lpf = ctx.createBiquadFilter()
    this.lpf.type = 'lowpass'
    this.lpf.frequency.value = 22050
    this.lpf.Q.value = 0.7
    this.hpf = ctx.createBiquadFilter()
    this.hpf.type = 'highpass'
    this.hpf.frequency.value = 20
    this.hpf.Q.value = 0.7
    this.channelGain = ctx.createGain()
    this.fxSeam = ctx.createGain()
    this.faderGain = ctx.createGain()
    this.cueGain = ctx.createGain()
    this.cueGain.gain.value = 0

    this.eqOut
      .connect(this.hpf)
      .connect(this.lpf)
      .connect(this.channelGain)
    this.channelGain.connect(this.fxSeam) // bypass by default — see class doc comment
    this.fxSeam.connect(this.faderGain)
    this.fxSeam.connect(this.cueGain)

    this.player = new BufferSourcePlayer(ctx, this.head)
    this.player.onEnd = () => this.handleEnd()
  }

  /**
   * Called by the engine after the worklet module resolves. The swap itself is
   * deferred to the next `load`: a worklet player is handed the samples on
   * load, so upgrading a deck that already holds a track would need a re-decode.
   */
  enableWorklet() {
    this.workletAvailable = true
  }

  get canScratch() {
    return this.player.canScratch
  }

  private handleEnd() {
    this._playing = false
    this.ahead = 0
    this.onEnded?.()
  }

  get playing() {
    return this._playing
  }

  get hasTrack() {
    return this._hasTrack
  }

  get duration() {
    return this._durationSec
  }

  load(buffer: AudioBuffer) {
    if (this.workletAvailable && this.player.kind !== 'worklet') {
      // Construct before disposing. Constructing an AudioWorkletNode can throw,
      // and disposing first would leave the deck holding a torn-down player
      // with no way back — a dead deck from a failure that was recoverable.
      const next = new WorkletPlayer(this.ctx, this.head)
      const previous = this.player
      this.player = next
      previous.dispose()
      next.onEnd = () => this.handleEnd()
      next.onProcessorError = () =>
        this.onProcessorError?.('the scratch engine stopped on this deck')
      next.setRate(this.rate)
    }
    this.player.load(buffer)
    // Duration and "is a track loaded" are captured as plain values rather than
    // asked of the buffer each time. The worklet player takes ownership of the
    // samples, so an AudioBuffer that has been handed over goes on answering
    // `!== null` and reporting a duration long after its bytes are gone. These
    // two fields are the deck's own truth.
    this._durationSec = buffer.duration
    this._hasTrack = true
    this._playing = false
    this.ahead = 0
    this.loopStart = this.loopEnd = null
  }

  unload() {
    this.player.unload()
    this.ahead = 0
    this._durationSec = 0
    this._hasTrack = false
    this._playing = false
  }

  get position(): number {
    if (!this._hasTrack) return 0
    return clamp(this.player.positionSec - this.ahead, 0, this._durationSec)
  }

  private get rate() {
    return this._baseRate * tempoToRate(this._tempo, settings.values.tempoRange)
  }

  /** The track's saved speed (v0.9.47): the fader's centre. Applied exactly like a fader move — same rate, same key-lock correction. */
  setBaseRate(r: number) {
    this._baseRate = r > 0 ? r : 1
    this.setTempo(this._tempo)
  }

  play() {
    if (!this._hasTrack || this._playing) return
    const pos = this.position
    this.ahead = this.aheadWhenPlaying()
    this.syncLoop()
    this.player.start(pos + this.ahead)
    this._playing = true
  }

  pause() {
    if (!this._playing) return
    this.player.stop()
    this._playing = false
    this.settleAhead()
  }

  togglePlay() {
    if (this._playing) {
      if (this._vinylMode) this.brakeToStop()
      else this.pause()
    } else if (this._vinylMode) {
      this.spinUpToPlay()
    } else {
      this.play()
    }
  }

  seek(sec: number) {
    // Not playing but `ahead` still set: a vinyl spin-down (`brakeToStop` keeps it until the platter stops). A CUE pressed in that half second
    // landed `ahead` past the cue point, and the next PLAY started there — a flam against the grid nothing showed (independent review, 05/10).
    if (!this._playing) this.settleAhead()
    this.player.seek(clamp(sec, 0, this.duration) + this.ahead)
  }

  /** CUE: jump to cue point; hold-to-play handled by caller. */
  cueTo(sec: number) {
    this.seek(sec)
  }

  setTempo(tempo: number) {
    this._tempo = tempo
    if (!this._scratching) this.player.setRate(this.rate)
    if (this._keyLock && this.keyLockNode) void this.keyLockNode.schedule({ semitones: this.stretchSemitones })
    // The stretch holds `latency` of wall time, which is `latency × rate` of track: a new rate changes what to subtract, not where the player
    // is — so no seek. Left alone it went stale by 5 ms at +8% and 34 ms on the ±50% range.
    if (this._playing && this.keyed) {
      this.ahead = this.aheadWhenPlaying()
      this.syncLoop()
    }
  }

  // ——— key lock (v0.9.20) ———

  /** Called by the engine once a stretch node exists for this deck. Until then `setKeyLock(true)` refuses and the caller says why. */
  attachKeyLock(node: StretchNode, latencySec: number) {
    this.keyLockNode = node
    this.keyLockLatencySec = latencySec
    this.head.connect(node)
    node.connect(this.wet)
  }

  get keyLock() {
    return this._keyLock
  }

  /**
   * Key lock ("master tempo"): the tempo fader changes the speed and the pitch stays the song's own. The player still runs at the fader's
   * rate — position, loops, scratch, SYNC all unchanged — and the stretch transposes its output back down (or up) by exactly what the rate
   * shifted it (`keyLockSemitones`). Bends and SYNC's small nudges are not corrected: they are short, and a turntable's are heard too.
   * Returns false when there is no stretch node to put in the path (the caller says so on screen).
   */
  setKeyLock(on: boolean): boolean {
    if (on && !this.keyLockNode) return false
    if (on === this._keyLock) return true
    const heard = this.position
    this._keyLock = on
    this.route()
    // Toggled mid-play: the player jumps by the latency so the new path is heard where the old one was. A drop of about one latency is
    // audible at the switch; a DJ switches this between songs, not mid-drop.
    if (this._playing && !this._scratching) {
      this.ahead = this.aheadWhenPlaying()
      this.syncLoop()
      this.player.seek(heard + this.ahead)
    }
    return true
  }

  /**
   * Key sync (v0.9.21): whole semitones to move this deck's key, on top of the key lock's undoing of the tempo. Only heard while the key lock
   * is in the path — the caller turns it on first, and clears this when the owner turns the key lock off or loads another track.
   */
  setKeyShift(semitones: number) {
    if (semitones === this._keyShift) return
    this._keyShift = semitones
    if (this._keyLock && this.keyLockNode) void this.keyLockNode.schedule({ semitones: this.stretchSemitones })
  }

  get keyShift() {
    return this._keyShift
  }

  private get stretchSemitones() {
    return keyLockSemitones(this.rate) + this._keyShift
  }

  /** The stretch is in the path when the key lock is on and no hand is on the platter: a scratch has to sound like a record. */
  private get keyed() {
    return this._keyLock && !!this.keyLockNode && !this._scratching
  }

  private aheadWhenPlaying() {
    return this.keyed ? this.keyLockLatencySec * this.rate : 0
  }

  /** The deck has stopped: what was heard last is where the player stopped (the stretch plays out its buffer), so nothing to subtract. */
  private settleAhead() {
    if (this.ahead === 0) return
    this.ahead = 0
    // Stopped inside the player's loop but past the owner's loop end (the player's loop sits `ahead` later): bring it back by the same wrap
    // the loop would have made, or the next PLAY starts outside the loop the owner set and walks out of it.
    if (this.loopStart != null && this.loopEnd != null) {
      const p = this.player.positionSec
      if (p >= this.loopEnd) this.player.seek(this.loopStart + ((p - this.loopEnd) % (this.loopEnd - this.loopStart)))
    }
    this.syncLoop()
  }

  private route() {
    const now = this.ctx.currentTime
    const keyed = this.keyed
    this.dry.gain.setTargetAtTime(keyed ? 0 : 1, now, 0.005)
    this.wet.gain.setTargetAtTime(keyed ? 1 : 0, now, 0.005)
    if (this.keyLockNode) {
      void this.keyLockNode.schedule(keyed ? { active: true, semitones: this.stretchSemitones } : { active: false })
    }
  }

  /** The player's loop sits `ahead` later than the loop the owner set, so the loop he hears is the one he set. */
  private syncLoop() {
    if (this.loopStart != null && this.loopEnd != null) this.player.setLoop(this.loopStart + this.ahead, this.loopEnd + this.ahead)
  }

  get vinylMode() {
    return this._vinylMode
  }

  /** Vinyl mode makes stop/start spin down and up instead of cutting. */
  setVinylMode(on: boolean) {
    this._vinylMode = on
  }

  get scratching() {
    return this._scratching
  }

  /**
   * Hand the rate over to a hand on the platter.
   *
   * The deck keeps reporting `playing` throughout: a finger on a spinning
   * record has not paused the deck, and letting the transport flicker on every
   * touch would flash the UI and fight the render loop. What was playing is
   * remembered so the release knows whether to spin back up or stay held.
   */
  beginScratch() {
    if (!this._hasTrack || this._scratching) return
    // A hand on the platter takes the key lock out of the path (`keyed`): the player steps back to what is heard, so the record is where it sounds.
    const heard = this.position
    this._scratching = true
    if (this._keyLock) this.route()
    if (this.ahead !== 0) {
      this.ahead = 0
      this.syncLoop()
      this.player.seek(heard)
    }
    this._resumePlaying = this._playing
    if (!this._playing) {
      // a stopped deck still has to feed the pointer for a scratch to be heard
      this.player.setRate(0)
      this.player.start(this.position)
      this._playing = true
    }
    this.player.setRate(0)
  }

  /**
   * Temporary pitch bend — nudging a playing deck forward or back to line it up
   * without touching tempo. This is a *rate* change, not a seek: seeking moves
   * the playhead and would tear a beatgrid, while bending is what a hand on the
   * rim of a running turntable actually does. The bend decays back to grid
   * speed on its own, so the deck cannot be left running off-speed.
   */
  pitchBend(amount: number) {
    if (!this._playing || this._scratching) return
    const bent = this.rate * (1 + amount)
    this.player.setRate(bent)
    this.clearBendTimer()
    this.bendTimer = window.setTimeout(() => {
      this.bendTimer = 0
      if (this._scratching || !this._playing) return
      this.player.rampRate(this.rate, BEND_RELEASE_SEC)
    }, BEND_HOLD_MS)
  }

  /**
   * A bend held open until it is released, for a key or a button that has a
   * down and an up. `pitchBend` decays on a timer because a jog tick has no
   * end; a held key does, and letting the timer win under it would make the
   * bend expire while the finger is still down.
   */
  holdBend(amount: number) {
    if (!this._playing || this._scratching) return
    this.clearBendTimer()
    this.player.setRate(this.rate * (1 + amount))
  }

  /** Ease back to grid speed. Safe to call when no bend is open. */
  releaseBend() {
    this.clearBendTimer()
    if (this._scratching || !this._playing) return
    this.player.rampRate(this.rate, BEND_RELEASE_SEC)
  }

  /**
   * Phase-align correction for SYNC (v0.3.0): closes `deltaSec` of measured
   * phase error via a bounded rate ramp — up (or down) then back to grid
   * speed over `windowSec` — never a seek. Seeking moves the playhead and
   * would tear the beat grid the same way `pitchBend`'s own doc comment
   * warns against; this is the same family of correction, just computed from
   * a measured gap (core/beatgrid.ts's `phaseDeltaSec`) instead of a jog tick,
   * so it takes an explicit window rather than the jog's fixed decay.
   *
   * A symmetric ramp of amplitude `k`, up for `windowSec/2` then back down for
   * the other half, covers `~ (windowSec/2) * rate * k` extra seconds versus
   * holding grid speed the whole window — solved for `k` and clamped to
   * `MAX_SYNC_BEND` so a large gap just takes more correction cycles to close
   * rather than ever becoming one audible snap.
   */
  syncNudge(deltaSec: number, windowSec: number) {
    if (!this._playing || this._scratching) return
    const half = windowSec / 2
    const k = clamp(deltaSec / (half * this.rate), -MAX_SYNC_BEND, MAX_SYNC_BEND)
    this.player.rampRate(this.rate * (1 + k), half)
    this.clearBendTimer()
    this.bendTimer = window.setTimeout(() => {
      this.bendTimer = 0
      if (this._scratching || !this._playing) return
      this.player.rampRate(this.rate, half)
    }, half * 1000)
  }

  private clearBendTimer() {
    if (this.bendTimer) {
      window.clearTimeout(this.bendTimer)
      this.bendTimer = 0
    }
  }

  /**
   * v0.9.75, the kick-gap meter (`core/kick-gap.ts`): a read-only tap on what this deck sounds like before its EQ and fader — after the
   * key lock's stretch, so the delay the stretch adds is in it, as in the room. Connected to nothing else; `removeTap` takes it off.
   */
  createTap(): AnalyserNode {
    const a = this.ctx.createAnalyser()
    a.fftSize = 32768
    a.smoothingTimeConstant = 0
    this.trim.connect(a)
    return a
  }

  removeTap(a: AnalyserNode) {
    this.trim.disconnect(a)
  }

  /** Rate in playback multiples: 1 = normal forward, negative = backwards. */
  scratchRate(rate: number) {
    if (!this._scratching) return
    this.player.setRate(rate)
  }

  /**
   * Release the platter. In vinyl mode the record spins back up to speed over
   * the spin-up time rather than snapping, which is what makes a release sound
   * like a turntable instead of an edit.
   */
  endScratch() {
    if (!this._scratching) return
    this._scratching = false
    if (this._keyLock) this.route()
    if (this._resumePlaying && this.keyed) {
      const heard = this.position
      this.ahead = this.aheadWhenPlaying()
      this.syncLoop()
      this.player.seek(heard + this.ahead)
    }
    if (this._resumePlaying) {
      if (this._vinylMode) this.player.rampRate(this.rate, settings.values.spinUpSec)
      else this.player.setRate(this.rate)
    } else {
      this.player.stop()
      this._playing = false
      this.player.setRate(this.rate)
    }
  }

  /**
   * Vinyl stop: spin down to a standstill, then park. The pause lands when the
   * platter has actually stopped, not when the command was issued — otherwise
   * the audio would cut mid-spin and the whole point is lost.
   */
  brakeToStop(seconds = settings.values.brakeSec) {
    if (!this._playing) return
    this.player.rampRate(0, seconds)
    this._playing = false
    window.setTimeout(() => {
      // A play/seek during the spin-down wins: only park if nothing else has
      // taken the deck since.
      if (this._playing || this._scratching) return
      this.player.stop()
      this.player.setRate(this.rate)
      this.settleAhead()
    }, seconds * 1000)
  }

  /** Vinyl start: from a standstill up to speed. */
  spinUpToPlay(seconds = settings.values.spinUpSec) {
    if (!this._hasTrack || this._playing) return
    const pos = this.position
    this.ahead = this.aheadWhenPlaying()
    this.syncLoop()
    this.player.setRate(0)
    this.player.start(pos + this.ahead)
    this._playing = true
    this.player.rampRate(this.rate, seconds)
  }

  setVolume(v: number) {
    this.channelGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01)
  }

  setEq(band: 'low' | 'mid' | 'high', knob: number) {
    // full cut at -1 (−70 dB on its band only)
    this.eqBands[band].gain.setTargetAtTime(bandGain(knob, settings.values.eqDb, EQ_CUT_DB), this.ctx.currentTime, 0.01)
  }

  /** -1 => heavy HPF, 0 => bypass, +1 => heavy LPF */
  setFilter(knob: number) {
    const now = this.ctx.currentTime
    if (Math.abs(knob) < 0.02) {
      this.lpf.frequency.setTargetAtTime(22050, now, 0.02)
      this.hpf.frequency.setTargetAtTime(20, now, 0.02)
      return
    }
    if (knob > 0) {
      const f = expScale(1 - knob, 400, 22050)
      this.lpf.frequency.setTargetAtTime(f, now, 0.02)
      this.hpf.frequency.setTargetAtTime(20, now, 0.02)
    } else {
      const f = expScale(1 + knob, 40, 8000)
      this.hpf.frequency.setTargetAtTime(f, now, 0.02)
      this.lpf.frequency.setTargetAtTime(22050, now, 0.02)
    }
  }

  /**
   * Splice this deck's paired FX rack in ahead of `fxSeam`, or remove it
   * (`null`) to go back to a bare bypass. Called only from `engine.ts` in
   * response to a routing change — routing is rare (a DJ sets it up, then
   * leaves it), unlike on/off which `FxRack` itself handles internally
   * without ever touching this graph, so a reconnect here on every toggle
   * would be the wrong cost to pay.
   */
  setFxInsert(rack: FxRack | null) {
    if (this.insertedFx === rack) return
    if (this.insertedFx) {
      this.channelGain.disconnect(this.insertedFx.input)
      this.insertedFx.output.disconnect(this.fxSeam)
    } else {
      this.channelGain.disconnect(this.fxSeam)
    }
    if (rack) {
      this.channelGain.connect(rack.input)
      rack.output.connect(this.fxSeam)
    } else {
      this.channelGain.connect(this.fxSeam)
    }
    this.insertedFx = rack
  }

  setCueMonitor(on: boolean) {
    this._cueMonitor = on
    this.cueGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01)
  }

  get cueMonitor() {
    return this._cueMonitor
  }

  setLoop(startSec: number, endSec: number) {
    this.loopStart = startSec
    this.loopEnd = endSec
    this.player.setLoop(startSec + this.ahead, endSec + this.ahead)
  }

  clearLoop() {
    this.loopStart = this.loopEnd = null
    this.player.clearLoop()
  }

}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v
}

function expScale(t: number, min: number, max: number) {
  return min * Math.pow(max / min, clamp(t, 0, 1))
}
