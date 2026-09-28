/**
 * The tagging screen's player (v0.9.0, v0.9.1): a stretch of a decoded track
 * with a click on every beat — a loud one on the "1" Shalom marked — and the
 * vocal clip. Goes to the preview bus, never a deck.
 */
import { BEATS_PER_BAR } from '@/core/beatgrid'

const CLICK_SEC = 0.03
const SOFT = 0.18
const LOUD = 0.7

export class TagPlayer {
  private ctx: BaseAudioContext
  private out: AudioNode
  private nodes: AudioBufferSourceNode[] = []
  private playing: { when: number; startSec: number; len: number } | null = null

  constructor(ctx: BaseAudioContext, out: AudioNode) {
    this.ctx = ctx
    this.out = out
  }

  /**
   * Play `lenSec` of `buffer` once from `startSec`, clicking every beat
   * `beatSec` apart that lines up with `markSec` — loud on the marker and on
   * every fourth beat from it, so each bar's "1" as marked is the loud one
   * (v0.9.1). Music and clicks start on the same context time, so they cannot
   * drift apart.
   */
  playFrom(buffer: AudioBuffer, startSec: number, lenSec: number, beatSec: number, markSec: number, accent = true) {
    this.stop()
    const len = Math.min(lenSec, buffer.duration - startSec)
    if (len <= 0) return
    const clicks = this.clickTrack(len, beatSec, markSec - startSec, accent)
    const when = this.ctx.currentTime + 0.05
    const music = this.ctx.createBufferSource()
    music.buffer = buffer
    music.connect(this.out)
    music.start(when, startSec, len)
    const click = this.ctx.createBufferSource()
    click.buffer = clicks
    click.connect(this.out)
    click.start(when)
    music.onended = () => {
      if (this.nodes[0] === music) this.stop()
    }
    this.nodes = [music, click]
    this.playing = { when, startSec, len }
  }

  /** Where in the track the sound is right now, or `null` when nothing plays — the moving line on the tagging waveform. */
  positionSec(): number | null {
    const p = this.playing
    if (!p) return null
    const t = this.ctx.currentTime - p.when
    if (t > p.len) return null
    return p.startSec + Math.max(0, t)
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
    this.playing = null
  }

  /** Clicks every `beatSec`, phased so one lands at `loudAtSec` (seconds into the buffer, may be past its end); loud there and every fourth beat from it. */
  private clickTrack(lenSec: number, beatSec: number, loudAtSec: number, accent: boolean): AudioBuffer {
    const rate = this.ctx.sampleRate
    const buf = this.ctx.createBuffer(1, Math.max(1, Math.round(lenSec * rate)), rate)
    const data = buf.getChannelData(0)
    const clickLen = Math.round(CLICK_SEC * rate)
    const first = Math.ceil((-loudAtSec - 1e-6) / beatSec)
    for (let k = first; loudAtSec + k * beatSec < lenSec - 1e-6; k++) {
      const t = loudAtSec + k * beatSec
      const loud = accent && ((k % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR === 0
      const amp = loud ? LOUD : SOFT
      const hz = loud ? 1760 : 1175
      const at = Math.round(t * rate)
      for (let i = 0; i < clickLen && at + i < data.length; i++) {
        const env = 1 - i / clickLen
        data[at + i] += amp * env * env * Math.sin((2 * Math.PI * hz * i) / rate)
      }
    }
    return buf
  }
}
