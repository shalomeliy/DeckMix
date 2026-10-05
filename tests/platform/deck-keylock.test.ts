import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * v0.9.20: the key lock's latency compensation (`ahead`) on the real `Deck`, over a fake player and a fake clock. The stretch hears the
 * player `latency` late, so the player runs `latency × rate` ahead and every position, seek and loop subtracts it. Each case below is a
 * place the independent review (05/10) found `ahead` left stale — none of them is audible in a test tone, all of them are a flam on a kick.
 */

let now = 0
const timers: { at: number; f: () => void }[] = []
const advance = (s: number) => {
  now += s
  for (const t of timers.splice(0)) {
    if (t.at <= now) t.f()
    else timers.push(t)
  }
}

vi.mock('@/platform/settings-idb/store', () => ({ settings: { values: { tempoRange: 0.08, brakeSec: 0.55, spinUpSec: 0.32, eqDb: 26 } } }))
class FakePlayer {
  kind = 'buffer'
  canScratch = false
  onEnd?: () => void
  pos = 0
  t0 = 0
  rate = 1
  playing = false
  dur = 0
  load(b: { duration: number }) {
    this.dur = b.duration
    this.pos = 0
    this.playing = false
  }
  unload() {}
  get positionSec() {
    return this.playing ? Math.min(this.dur, this.pos + (now - this.t0) * this.rate) : this.pos
  }
  private rebase() {
    this.pos = this.positionSec
    this.t0 = now
  }
  start(o: number) {
    this.pos = Math.min(o, this.dur)
    this.t0 = now
    this.playing = true
  }
  stop() {
    this.rebase()
    this.playing = false
  }
  seek(s: number) {
    this.pos = Math.max(0, Math.min(s, this.dur))
    this.t0 = now
  }
  setRate(r: number) {
    this.rebase()
    this.rate = r
  }
  rampRate(r: number) {
    this.rebase()
    this.rate = r
  }
  setLoop() {}
  clearLoop() {}
  dispose() {}
}
vi.mock('@/platform/audio-webaudio/players', () => ({ BufferSourcePlayer: FakePlayer, WorkletPlayer: FakePlayer }))
const audioNode = () => ({ connect: (x: unknown) => x, gain: { value: 1, setTargetAtTime() {} }, frequency: { value: 0, setTargetAtTime() {} }, Q: { value: 0 }, type: '' })
const ctx = {
  get currentTime() {
    return now
  },
  createGain: audioNode,
  createBiquadFilter: audioNode,
} as unknown as AudioContext
vi.stubGlobal('window', {
  setTimeout: (f: () => void, ms: number) => {
    timers.push({ at: now + ms / 1000, f })
    return 1
  },
  clearTimeout() {},
})

const LATENCY = 0.0675
async function keyedDeck() {
  const { Deck } = await import('@/platform/audio-webaudio/deck')
  const d = new Deck(ctx, 'A' as never)
  d.attachKeyLock({ connect: (x: unknown) => x, schedule: async () => {} } as never, LATENCY)
  d.load({ duration: 300 } as AudioBuffer)
  d.setKeyLock(true)
  return d
}

beforeEach(() => {
  now = 0
  timers.length = 0
})

describe('key lock latency compensation (v0.9.20)', () => {
  it('a CUE pressed during a vinyl spin-down lands on the cue point, not 67 ms past it', async () => {
    const d = await keyedDeck()
    d.seek(10)
    d.play()
    advance(2)
    d.brakeToStop()
    advance(0.2)
    d.seek(10)
    advance(1)
    expect(d.position).toBeCloseTo(10, 4)
    d.play()
    expect(d.position).toBeCloseTo(10, 4)
  })

  it('a tempo move while keyed keeps the reported position on the heard one', async () => {
    const d = await keyedDeck()
    d.seek(10)
    d.play()
    advance(1)
    d.setTempo(1) // full fader: +8%
    advance(2)
    // What the stretch is putting out now is what the player read `LATENCY` of wall time ago.
    const player = (d as unknown as { player: FakePlayer }).player
    const heard = player.positionSec - LATENCY * player.rate
    expect(Math.abs(d.position - heard)).toBeLessThan(1e-6)
  })

  it('a pause past the loop end the owner set wraps back inside the loop', async () => {
    const d = await keyedDeck()
    d.seek(10)
    d.play()
    d.setLoop(10, 10.5)
    advance(0.54) // the fake player does not wrap: it is now in the last `ahead` of its (shifted) loop, past 10.5
    d.pause()
    expect(d.position).toBeGreaterThanOrEqual(10)
    expect(d.position).toBeLessThan(10.5)
  })
})

describe('key sync shift on the deck (v0.9.21)', () => {
  it('the stretch is told the tempo undo plus the shift, and keeps both through a tempo move', async () => {
    const { Deck } = await import('@/platform/audio-webaudio/deck')
    const { keyLockSemitones } = await import('@/core/key-lock')
    const told: { active?: boolean; semitones?: number }[] = []
    const d = new Deck(ctx, 'A' as never)
    d.attachKeyLock({ connect: (x: unknown) => x, schedule: async (o: { semitones?: number }) => void told.push(o) } as never, LATENCY)
    d.load({ duration: 300 } as AudioBuffer)
    d.setKeyLock(true)
    d.setKeyShift(2)
    expect(told.at(-1)!.semitones).toBeCloseTo(2, 9)
    d.setTempo(1) // +8%
    expect(told.at(-1)!.semitones).toBeCloseTo(keyLockSemitones(1.08) + 2, 9)
    d.setKeyShift(0)
    expect(told.at(-1)!.semitones).toBeCloseTo(keyLockSemitones(1.08), 9)
    // key lock off and on again at the deck: the shift is still there (clearing it is `controls.ts`'s job, with the button)
    d.setKeyShift(-3)
    d.setKeyLock(false)
    expect(told.at(-1)!.active).toBe(false)
    d.setKeyLock(true)
    expect(told.at(-1)).toMatchObject({ active: true })
    expect(told.at(-1)!.semitones).toBeCloseTo(keyLockSemitones(1.08) - 3, 9)
  })
})
