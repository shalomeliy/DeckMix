/**
 * Bit Crusher + Roll worklet processors (v0.8.13, planned as v0.7.1) — the
 * two FX effects that need real-time DSP no existing native Web Audio node
 * provides. Bundled in one file, one `addModule`/`ensureFxWorklet` call for
 * both, registered as two independent processors so each keeps its own
 * `parameterDescriptors`/port protocol instead of branching on a shared mode.
 *
 * This file must import nothing beyond `@/core/fx`'s pure math — see
 * `scratch-processor.ts`'s header comment: an AudioWorkletGlobalScope has no
 * DOM, and one accidental transitive DOM-touching import turns `addModule`
 * into an opaque rejection.
 */
import { BIT_CRUSH_BITS, BIT_CRUSH_HOLD_HZ, crushSample } from '@/core/fx'

/**
 * Sample-and-hold downsampling + bit-depth reduction — the classic lo-fi
 * "digital crush". Both halves are fixed constants (`BIT_CRUSH_HOLD_HZ`,
 * `BIT_CRUSH_BITS`), same role as Delay/Echo's fixed `FEEDBACK_GAIN`, not
 * beat-synced.
 *
 * Two bugs, found live with Shalom on 2026-09-22, are why this looks the way
 * it does — worth keeping both notes, not just the fix:
 *
 * 1. An earlier version held each output value for a beat-synced interval
 *    (reusing the seconds range Delay's `delayTime`/Filter's sweep period
 *    use via `FxRack.setTime`) — a unit-scale mistake, not a style choice:
 *    that range is 0.05-2s, three to four orders of magnitude longer than
 *    the sub-millisecond hold an audible "crunch" needs. It read as a slow
 *    stutter, not a crush.
 * 2. Dropping the hold entirely (bit-depth quantization alone, every sample)
 *    fixed the stutter but undersold the effect the other way: on real
 *    music, 4-bit quantization alone reads as a subtle loudness/grain
 *    change, not the dramatic "digital crunch" the effect promises — most of
 *    that character actually comes from the aliasing a downsampled hold
 *    produces, not from bit-depth reduction by itself.
 *
 * So both halves are back, fixed at `BIT_CRUSH_HOLD_HZ`/`BIT_CRUSH_BITS`
 * rather than either being user- or beat-controlled — no knob to get the
 * magnitude of wrong a third time. The rack's "Time" button is consequently
 * a no-op for this effect (no `onTime` hook registered in `fx.ts`).
 */
class BitCrusherProcessor extends AudioWorkletProcessor {
  /** Held output value per channel, resampled every `holdFrames`. */
  private held: number[] = []
  private framesUntilResample = 0
  private readonly holdFrames = Math.max(1, Math.round(sampleRate / BIT_CRUSH_HOLD_HZ))

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]
    const out = outputs[0]
    const n = out[0]?.length ?? 0
    const nCh = out.length
    if (this.held.length !== nCh) this.held = new Array(nCh).fill(0)
    if (!input || input.length === 0) return true

    for (let i = 0; i < n; i++) {
      if (this.framesUntilResample <= 0) {
        // Mono-to-stereo upmix on the input side, same reasoning as
        // `scratch-processor.ts`'s channel mapping: this is an insert effect
        // that must never go silent on one side just because its source has
        // fewer channels than the rack's stereo path.
        for (let c = 0; c < nCh; c++) {
          const src = input[c < input.length ? c : input.length - 1]?.[i] ?? 0
          this.held[c] = crushSample(src, BIT_CRUSH_BITS)
        }
        this.framesUntilResample = this.holdFrames
      }
      for (let c = 0; c < nCh; c++) out[c][i] = this.held[c]
      this.framesUntilResample--
    }
    return true
  }
}

registerProcessor('bit-crusher', BitCrusherProcessor)

type RollMessage = { type: 'trigger'; lengthSec: number }

/**
 * Beat-synced stutter/retrigger loop. Captures a short window of live audio
 * starting the moment a `trigger` message arrives, then loops that fixed
 * buffer until the next trigger. A loop length sent while already looping
 * does **not** resize the running loop — it only takes effect on the next
 * trigger (Shalom's decision, 2026-09-22): there is no audio to stretch a
 * captured buffer into without either fabricating samples that were never
 * played, or recapturing, which is exactly what a fresh trigger already does.
 */
class RollProcessor extends AudioWorkletProcessor {
  /** Ceiling on a captured loop, in frames — allocated once at the highest realistic sample rate (48kHz), so a 44.1kHz context just leaves headroom. Matches `ROLL_LENGTH_RANGE`'s max in `platform/audio-webaudio/fx.ts`; real-time reallocation inside `process()` risks a GC-driven glitch, so this is fixed up front. */
  private static readonly MAX_FRAMES = 3 * 48000

  /** Crossfade folded into the buffer once, right after capture ends, so the loop's wrap seam doesn't click — same declick philosophy as `fx.ts`'s `DECLICK_SEC`, applied to the loop boundary instead of the on/off gain. */
  private static readonly SEAM_SEC = 0.005

  private buffers: Float32Array[] = []
  private state: 'idle' | 'capturing' | 'looping' = 'idle'
  private captureIndex = 0
  private captureLength = 0
  private playIndex = 0

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    this.port.onmessage = (e: MessageEvent<RollMessage>) => {
      if (e.data.type !== 'trigger') return
      this.captureLength = Math.min(
        RollProcessor.MAX_FRAMES,
        Math.max(1, Math.round(e.data.lengthSec * sampleRate)),
      )
      this.captureIndex = 0
      this.state = 'capturing'
    }
  }

  /** Blends the buffer's tail into its head over `SEAM_SEC`, once, so `playIndex` wrapping from the last frame to the first is not a discontinuity. */
  private seamCrossfade(nCh: number) {
    const seamFrames = Math.min(this.captureLength >> 1, Math.round(RollProcessor.SEAM_SEC * sampleRate))
    for (let c = 0; c < nCh; c++) {
      const buf = this.buffers[c]
      for (let i = 0; i < seamFrames; i++) {
        const t = i / seamFrames
        const tail = this.captureLength - seamFrames + i
        buf[tail] = buf[tail] * (1 - t) + buf[i] * t
      }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]
    const out = outputs[0]
    const n = out[0]?.length ?? 0
    const nCh = out.length
    if (this.buffers.length !== nCh) {
      this.buffers = Array.from({ length: nCh }, () => new Float32Array(RollProcessor.MAX_FRAMES))
    }
    if (!input || input.length === 0) return true

    for (let i = 0; i < n; i++) {
      if (this.state === 'capturing') {
        for (let c = 0; c < nCh; c++) {
          const src = input[c < input.length ? c : input.length - 1]?.[i] ?? 0
          this.buffers[c][this.captureIndex] = src
          out[c][i] = src // live audio passes through while the buffer fills, not silence
        }
        this.captureIndex++
        if (this.captureIndex >= this.captureLength) {
          this.seamCrossfade(nCh)
          this.state = 'looping'
          this.playIndex = 0
        }
      } else if (this.state === 'looping') {
        for (let c = 0; c < nCh; c++) out[c][i] = this.buffers[c][this.playIndex]
        this.playIndex = (this.playIndex + 1) % this.captureLength
      } else {
        for (let c = 0; c < nCh; c++) out[c][i] = 0
      }
    }
    return true
  }
}

registerProcessor('roll', RollProcessor)
