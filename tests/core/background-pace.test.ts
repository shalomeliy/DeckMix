import { describe, expect, it } from 'vitest'
import { createPacer, MIN_REST_MS } from '@/core/background-pace'

/** A fake clock: `sleep` resolves only when the test advances time past it. */
function fakeTime() {
  let t = 0
  let timers: { at: number; resolve: () => void }[] = []
  return {
    now: () => t,
    sleep: (ms: number) => new Promise<void>((resolve) => timers.push({ at: t + ms, resolve })),
    async advance(ms: number) {
      t += ms
      const due = timers.filter((x) => x.at <= t)
      timers = timers.filter((x) => x.at > t)
      for (const x of due) x.resolve()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    },
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** A job the test finishes by hand, recording when it started. */
function manualJob(log: string[], name: string) {
  let finish!: () => void
  const done = new Promise<void>((r) => (finish = r))
  return {
    job: async () => {
      log.push(`start ${name}`)
      await done
      log.push(`end ${name}`)
      return name
    },
    finish: () => finish(),
  }
}

describe('background analysis pacing (v0.9.51)', () => {
  it('runs every job at once while nothing plays — full speed, as before', async () => {
    const time = fakeTime()
    const pacer = createPacer({ isPlaying: () => false, ...time })
    const log: string[] = []
    const a = manualJob(log, 'a')
    const b = manualJob(log, 'b')
    void pacer.run(a.job)
    void pacer.run(b.job)
    await flush()
    expect(log).toEqual(['start a', 'start b'])
  })

  it('while a deck plays, one job at a time, and the next waits out a rest as long as the job took', async () => {
    const time = fakeTime()
    const pacer = createPacer({ isPlaying: () => true, ...time })
    const log: string[] = []
    const a = manualJob(log, 'a')
    const b = manualJob(log, 'b')
    const ra = pacer.run(a.job)
    void pacer.run(b.job)
    await flush()
    expect(log).toEqual(['start a'])
    await time.advance(2000)
    a.finish()
    // the caller gets its result straight away; only the next job is held back
    expect(await ra).toBe('a')
    await time.advance(1999)
    expect(log).toEqual(['start a', 'end a'])
    await time.advance(1)
    expect(log).toEqual(['start a', 'end a', 'start b'])
  })

  it('a very short job still rests the minimum', async () => {
    const time = fakeTime()
    const pacer = createPacer({ isPlaying: () => true, ...time })
    const log: string[] = []
    void pacer.run(async () => void log.push('a'))
    void pacer.run(async () => void log.push('b'))
    await flush()
    expect(log).toEqual(['a'])
    await time.advance(MIN_REST_MS - 1)
    expect(log).toEqual(['a'])
    await time.advance(1)
    expect(log).toEqual(['a', 'b'])
  })

  it('a job that throws still frees the slot — one failed song never stalls the queue', async () => {
    const time = fakeTime()
    const pacer = createPacer({ isPlaying: () => true, ...time })
    const log: string[] = []
    await expect(pacer.run(async () => Promise.reject(new Error('bad file')))).rejects.toThrow('bad file')
    void pacer.run(async () => void log.push('next'))
    await time.advance(MIN_REST_MS)
    expect(log).toEqual(['next'])
  })

  it('when the music stops, the next job is not made to rest', async () => {
    const time = fakeTime()
    let playing = true
    const pacer = createPacer({ isPlaying: () => playing, ...time })
    const log: string[] = []
    const a = manualJob(log, 'a')
    void pacer.run(a.job)
    void pacer.run(async () => void log.push('b'))
    await flush()
    playing = false
    await time.advance(5000)
    a.finish()
    await flush()
    expect(log).toEqual(['start a', 'end a', 'b'])
  })

  it('after the music stops, several looping workers run side by side again — not one at a time until the pass drains', async () => {
    const time = fakeTime()
    let playing = true
    const pacer = createPacer({ isPlaying: () => playing, ...time })
    let running = 0
    let peakAfterStop = 0
    let stopped = false
    const finishers: (() => void)[] = []
    const job = () =>
      new Promise<void>((resolve) => {
        running++
        if (stopped) peakAfterStop = Math.max(peakAfterStop, running)
        finishers.push(() => {
          running--
          resolve()
        })
      })
    const worker = async () => {
      for (let i = 0; i < 6; i++) await pacer.run(job)
    }
    const all = Promise.all([worker(), worker(), worker(), worker()])
    await flush()
    expect(running).toBe(1)
    stopped = true
    playing = false
    finishers.shift()!()
    await time.advance(10_000)
    expect(peakAfterStop).toBeGreaterThan(1)
    while (finishers.length) {
      finishers.splice(0).forEach((f) => f())
      await flush()
    }
    await all
  })
})

describe('a deck load holds new background jobs (v0.9.61)', () => {
  it('starts nothing while a song is being decoded for a deck, then runs at full speed', async () => {
    const time = fakeTime()
    let loading = true
    const pacer = createPacer({ isPlaying: () => false, isLoading: () => loading, ...time })
    const log: string[] = []
    const a = manualJob(log, 'a')
    void pacer.run(a.job)
    await flush()
    expect(log).toEqual([])
    await time.advance(500)
    expect(log).toEqual([])
    loading = false
    await time.advance(100)
    expect(log).toEqual(['start a'])
  })

  it('does not hold forever if the load never reports being done', async () => {
    const time = fakeTime()
    const pacer = createPacer({ isPlaying: () => false, isLoading: () => true, ...time })
    const log: string[] = []
    const a = manualJob(log, 'a')
    void pacer.run(a.job)
    for (let i = 0; i < 160; i++) await time.advance(100)
    expect(log).toEqual(['start a'])
  })
})
