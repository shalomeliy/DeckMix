import { kickGap, summarizeGaps, type KickGap, type KickGapSummary } from '@/core/kick-gap'
import type { Deck } from '@/platform/audio-webaudio/deck'

/** Between reads: just over the 0.74 s the tap holds (32768 samples at 44.1 kHz), so no kick is read twice. A kick on the seam may be missed; the mix has many. */
const READ_EVERY_MS = 760

/**
 * Reads both decks' sound at the same instant, a few times a second, for the length of one mix, and keeps each window's kick gap
 * (`core/kick-gap.ts`). `stop()` takes the taps off and returns the windows read since `markFrom()` (default: all) — the caller says what
 * counts, since the first second of a mix is the lock still closing.
 */
export class KickMeter {
  private readonly outgoing: Deck
  private readonly incoming: Deck
  private readonly ctx: AudioContext
  /** one beat of the outgoing deck in WALL ms (its beat at the tempo it plays), which bounds how far apart two kicks may be to be one pair */
  private readonly beatMs: number
  private readonly tapA: AnalyserNode
  private readonly tapB: AnalyserNode
  private readonly bufA: Float32Array<ArrayBuffer>
  private readonly bufB: Float32Array<ArrayBuffer>
  private timer = 0
  private windows: { at: number; gap: KickGap }[] = []

  constructor(outgoing: Deck, incoming: Deck, ctx: AudioContext, beatMs: number) {
    this.outgoing = outgoing
    this.incoming = incoming
    this.ctx = ctx
    this.beatMs = beatMs
    this.tapA = outgoing.createTap()
    this.tapB = incoming.createTap()
    this.bufA = new Float32Array(this.tapA.fftSize)
    this.bufB = new Float32Array(this.tapB.fftSize)
  }

  start() {
    this.timer = window.setInterval(() => this.read(), READ_EVERY_MS)
  }

  private read() {
    this.tapA.getFloatTimeDomainData(this.bufA)
    this.tapB.getFloatTimeDomainData(this.bufB)
    this.windows.push({ at: this.ctx.currentTime, gap: kickGap(this.bufA, this.bufB, this.ctx.sampleRate, this.beatMs) })
  }

  /** Stops reading and returns the summary of the windows read at or after `fromTime` (audio clock, seconds); null when none could measure. */
  stop(fromTime = 0): { summary: KickGapSummary | null; windows: KickGap[] } {
    window.clearInterval(this.timer)
    this.outgoing.removeTap(this.tapA)
    this.incoming.removeTap(this.tapB)
    const used = this.windows.filter((w) => w.at >= fromTime).map((w) => w.gap)
    return { summary: summarizeGaps(used), windows: used }
  }
}
