import { describe, expect, it } from 'vitest'
import { MixLogger, replayAt } from '@/core/mix-log'

function setup() {
  let now = 0
  const log = new MixLogger(() => now)
  return { log, at: (t: number) => { now = t } }
}

describe('MixLogger', () => {
  it('writes the first value of a knob at once', () => {
    const { log } = setup()
    log.knob('xfade', 0.3)
    expect(log.events).toEqual([{ t: 0, k: 'knob', key: 'xfade', v: 0.3 }])
  })

  it('holds back small and fast moves, and writes the final value once the knob is still', () => {
    const { log, at } = setup()
    log.knob('xfade', 0)
    at(10); log.knob('xfade', 0.5) // big move but inside the 50 ms gap
    expect(log.events).toHaveLength(1)
    at(40); log.flush()
    expect(log.events).toHaveLength(1) // still inside the gap since the first write
    at(70); log.flush()
    expect(log.events.at(-1)).toMatchObject({ key: 'xfade', v: 0.5 }) // a knob that stops always ends on its true value
  })

  it('does not rewrite a slow drift every flush', () => {
    const { log, at } = setup()
    log.knob('vol:A', 0.5)
    for (let t = 5; t < 2000; t += 5) { at(t); log.knob('vol:A', 0.5 + t * 0.00001); if (t % 50 === 0) log.flush() }
    expect(log.events.length).toBeLessThan(5)
  })

  it('a value that returns to the last written one cancels the held-back write', () => {
    const { log, at } = setup()
    log.knob('k', 0.5)
    at(10); log.knob('k', 0.505)
    at(20); log.knob('k', 0.5)
    at(100); log.flush()
    expect(log.events).toHaveLength(1)
  })
})

describe('replayAt', () => {
  it('rebuilds knobs, decks, the running mix and the rating at each time', () => {
    const { log, at } = setup()
    log.event({ k: 'load', deck: 'A', hash: 'a' })
    at(100); log.event({ k: 'play', deck: 'A', on: true }); log.knob('xfade', 0)
    at(200); log.event({ k: 'mix', phase: 'start', mixType: 'swap', from: 'A', to: 'B' })
    at(300); log.knob('xfade', 0.4)
    at(400); log.event({ k: 'mix', phase: 'end', mixType: 'swap', from: 'A', to: 'B' }); log.event({ k: 'rate', rating: 'excellent' })
    const [s0, s1, s2, s3] = replayAt(log.events, [50, 250, 350, 450])
    expect(s0.loaded.A).toBe('a'); expect(s0.playing.A).toBe(false)
    expect(s1.mix?.mixType).toBe('swap'); expect(s1.knobs.xfade).toBe(0)
    expect(s2.knobs.xfade).toBe(0.4)
    expect(s3.mix).toBeNull(); expect(s3.lastRating).toBe('excellent')
  })
})
