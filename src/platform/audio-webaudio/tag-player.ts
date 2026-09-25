/**
 * The tagging screen's player (v0.9.0): a stretch of a decoded track, looped,
 * with a click on every beat — a loud one on the beat under test as the "1".
 * Both the music and the clicks are one buffer each, started on the same
 * context time and looped over the same length, so the clicks cannot drift
 * off the music however long Shalom listens.
 */
import { BEATS_PER_BAR } from '@/core/beatgrid'
import type { BeatGrid } from '@/core/types'

const CLICK_SEC = 0.03
const SOFT = 0.18
const LOUD = 0.7

export class TagPlayer {
  private ctx: BaseAudioContext
  private out: AudioNode
  private nodes: AudioBufferSourceNode[] = []

  constructor(ctx: BaseAudioContext, out: AudioNode) {
    this.ctx = ctx
    this.out = out
  }

  /** Loop `bars` bars of `buffer` from `startSec`, clicking every beat of `grid`, loud on beat `loudBeat` (0–3) of each bar. */
  playBars(buffer: AudioBuffer, startSec: number, bars: number, grid: BeatGrid, loudBeat: number) {
    this.stop()
    const beatSec = 60 / grid.bpm
    const lenSec = Math.min(bars * BEATS_PER_BAR * beatSec, buffer.duration - startSec)
    if (lenSec <= 0) return
    const clicks = this.clickTrack(lenSec, beatSec, loudBeat)
    const when = this.ctx.currentTime + 0.05
    const music = this.ctx.createBufferSource()
    music.buffer = buffer
    music.loop = true
    music.loopStart = startSec
    music.loopEnd = startSec + lenSec
    music.connect(this.out)
    music.start(when, startSec)
    const click = this.ctx.createBufferSource()
    click.buffer = clicks
    click.loop = true
    click.loopEnd = lenSec
    click.connect(this.out)
    click.start(when)
    this.nodes = [music, click]
  }

  /** A clip played once, no clicks — the vocal question. */
  playClip(buffer: AudioBuffer, startSec: number, lenSec: number) {
    this.stop()
    const music = this.ctx.createBufferSource()
    music.buffer = buffer
    music.connect(this.out)
    music.start(this.ctx.currentTime + 0.02, startSec, lenSec)
    this.nodes = [music]
  }

  stop() {
    for (const n of this.nodes) {
      try {
        n.stop()
      } catch {
        /* never started, or already ended */
      }
      n.disconnect()
    }
    this.nodes = []
  }

  private clickTrack(lenSec: number, beatSec: number, loudBeat: number): AudioBuffer {
    const rate = this.ctx.sampleRate
    const buf = this.ctx.createBuffer(1, Math.max(1, Math.round(lenSec * rate)), rate)
    const data = buf.getChannelData(0)
    const clickLen = Math.round(CLICK_SEC * rate)
    for (let beat = 0; beat * beatSec < lenSec - 1e-6; beat++) {
      const loud = beat % BEATS_PER_BAR === loudBeat
      const amp = loud ? LOUD : SOFT
      const hz = loud ? 1760 : 1175
      const at = Math.round(beat * beatSec * rate)
      for (let i = 0; i < clickLen && at + i < data.length; i++) {
        const env = 1 - i / clickLen
        data[at + i] += amp * env * env * Math.sin((2 * Math.PI * hz * i) / rate)
      }
    }
    return buf
  }
}
