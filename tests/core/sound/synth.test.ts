import { describe, expect, it } from 'vitest'
import { decodeWav, encodeWav16, makeMix, vetSources, WavFormatError, type VocalClip } from '@/core/sound/synth/index.ts'
import { CELL_NONE, CELL_VOCAL } from '@/core/sound/vocal-timeline.ts'

const SR = 22050

/** A stand-in "voice" for the TEST ONLY: a vibrato tone with a syllable envelope. Never written to disk as data. */
function fakeVoice(sec: number): VocalClip {
  const n = Math.floor(sec * SR)
  const s = new Float32Array(n)
  let ph = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    ph += (2 * Math.PI * (220 + 8 * Math.sin(2 * Math.PI * 5.5 * t))) / SR
    s[i] = Math.sin(ph) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t)) * 0.5
  }
  return { id: 'test-voice', samples: s, sampleRate: SR }
}

const small = { sampleRate: SR, bars: 16 }

// Not `toEqual`: deep-comparing half a million floats made this test slower than the synthesis.
const same = (a: Float32Array, b: Float32Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])

describe('makeMix without vocals', () => {
  it('is rebuilt exactly from its seed, and a different seed is a different song', () => {
    const a = makeMix(7, [], small)
    const b = makeMix(7, [], small)
    const c = makeMix(8, [], small)
    expect(same(a.mixture[0], b.mixture[0])).toBe(true)
    expect(same(a.mixture[0], c.mixture[0])).toBe(false)
  })

  it('stays in the tempo range, below clipping, and says there is no voice anywhere', () => {
    const m = makeMix(3, [], small)
    expect(m.bpm).toBeGreaterThanOrEqual(118)
    expect(m.bpm).toBeLessThanOrEqual(140)
    let peak = 0
    for (const ch of m.mixture) for (const v of ch) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeGreaterThan(0.5)
    expect(peak).toBeLessThanOrEqual(0.9001)
    expect([...m.labels].every((l) => l === CELL_NONE)).toBe(true)
    expect(m.vocalIds).toEqual([])
  })

  it('has real content in every group across seeds (not a silent stem)', () => {
    const energy = (x: Float32Array): number => x.reduce((s, v) => s + v * v, 0)
    const sums = { drums: 0, bass: 0, other: 0 }
    for (let seed = 1; seed <= 6; seed++) {
      const m = makeMix(seed, [], small)
      for (const k of ['drums', 'bass', 'other'] as const) sums[k] += energy(m.stems[k][0])
    }
    expect(sums.drums).toBeGreaterThan(0)
    expect(sums.bass).toBeGreaterThan(0)
    expect(sums.other).toBeGreaterThan(0)
  })
})

describe('makeMix with vocals', () => {
  const clip = fakeVoice(20)
  const m = makeMix(11, [clip], small)

  it('stems add back up to the mixture, so the label is read off a true stem', () => {
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < m.mixture[c].length; i += 997) {
        const sum = m.stems.drums[c][i] + m.stems.bass[c][i] + m.stems.other[c][i] + m.stems.vocals[c][i]
        expect(Math.abs(sum - m.mixture[c][i])).toBeLessThan(1e-5)
      }
    }
  })

  it('labels vocal cells where the vocal stem is loud, and none where it is silent', () => {
    const cell = Math.floor(0.5 * SR)
    expect(m.labels.length).toBe(Math.floor(m.mixture[0].length / cell))
    expect([...m.labels].some((l) => l === CELL_VOCAL)).toBe(true)
    expect([...m.labels].some((l) => l === CELL_NONE)).toBe(true)
    m.labels.forEach((l, k) => {
      let e = 0
      for (let i = k * cell; i < (k + 1) * cell; i++) e += m.stems.vocals[0][i] ** 2
      if (l === CELL_VOCAL) expect(e).toBeGreaterThan(0)
    })
    // The first four bars are left free of voice.
    const introCells = Math.floor((4 * 4 * 60 * 0.9) / m.bpm / 0.5)
    expect([...m.labels.slice(0, introCells)].every((l) => l === CELL_NONE)).toBe(true)
  })

  it('does not change the music when vocals are added', () => {
    const bare = makeMix(11, [], small)
    expect(same(bare.stems.drums[0], m.stems.drums[0])).toBe(false) // gain differs…
    const ratio = m.stems.drums[0].findIndex((v) => v !== 0)
    const i = ratio
    expect(m.stems.drums[0][i] / bare.stems.drums[0][i]).toBeCloseTo(m.stems.drums[1][i] / bare.stems.drums[1][i], 3) // …but only by one overall factor
    expect(m.vocalIds).toEqual(['test-voice'])
  })
})

describe('wav', () => {
  it('round-trips 16-bit stereo', () => {
    const l = Float32Array.from([0, 0.5, -0.5, 1])
    const r = Float32Array.from([0.25, -0.25, 0, -1])
    const w = decodeWav(encodeWav16([l, r], 44100))
    expect(w.sampleRate).toBe(44100)
    expect(w.channels[0][1]).toBeCloseTo(0.5, 3)
    expect(w.channels[1][3]).toBeCloseTo(-1, 3)
  })

  it('reads past a LIST chunk before the data, and names what it cannot read', () => {
    const base = encodeWav16([Float32Array.from([0.5, -0.5])], 8000)
    const list = new Uint8Array([76, 73, 83, 84, 4, 0, 0, 0, 0, 0, 0, 0]) // "LIST", size 4, 4 bytes
    const withList = new Uint8Array(base.length + list.length)
    withList.set(base.subarray(0, 36), 0)
    withList.set(list, 36)
    withList.set(base.subarray(36), 36 + list.length)
    expect(decodeWav(withList).channels[0][0]).toBeCloseTo(0.5, 3)
    expect(() => decodeWav(new Uint8Array(20))).toThrow(WavFormatError)
  })
})

describe('vetSources', () => {
  const src = (license: string) => ({ id: 'x', license, origin: 'o' })
  it('lets CC0 and CC BY through, and names the reason for everything else', () => {
    const { ok, refused } = vetSources([src('CC BY 4.0'), src('cc0-1.0'), src('CC BY-NC-SA 4.0'), src(''), src('MIT')])
    expect(ok).toHaveLength(2)
    expect(refused.map((x) => x.reason)).toEqual([
      expect.stringContaining('allow-list'),
      'no license recorded',
      expect.stringContaining('allow-list'),
    ])
  })
})

describe('realism (round 3)', () => {
  const clip = fakeVoice(20)
  const opts = { sampleRate: SR, bars: 24 }
  const rmsDb = (x: Float32Array, a: number, b: number): number => {
    let s = 0
    for (let i = a; i < b; i++) s += x[i] * x[i]
    return 10 * Math.log10(s / (b - a) + 1e-12)
  }
  /** Mean level of the mixture in cells that carry a voice minus cells that do not, in dB, over several seeds. */
  function levelLift(realism: boolean): number {
    const cell = Math.floor(0.5 * SR)
    let lift = 0
    let n = 0
    for (const seed of [21, 22, 23, 24]) {
      const m = makeMix(seed, [clip], { ...opts, realism })
      let v = 0
      let nv = 0
      let q = 0
      let nq = 0
      m.labels.forEach((l, k) => {
        const d = rmsDb(m.mixture[0], k * cell, (k + 1) * cell)
        if (l === CELL_VOCAL) (v += d), nv++
        else if (l === CELL_NONE) (q += d), nq++
      })
      if (nv && nq) (lift += v / nv - q / nq), n++
    }
    return lift / n
  }

  it('is a different mix from the plain one, and still rebuilds from its seed', () => {
    const plain = makeMix(31, [clip], { ...opts, realism: false })
    const real = makeMix(31, [clip], opts)
    expect(same(plain.mixture[0], real.mixture[0])).toBe(false)
    expect(same(real.mixture[0], makeMix(31, [clip], opts).mixture[0])).toBe(true)
  })

  it('lets a laid-on voice raise the level of the mix less than the plain mix does', () => {
    // The point of the bus compressor: round 2 showed the classifier learning "louder = vocal".
    expect(levelLift(true)).toBeLessThan(levelLift(false))
  })

  it('keeps the stems summing to the mixture with the compressor in', () => {
    const m = makeMix(32, [clip], opts)
    for (let i = 0; i < m.mixture[0].length; i += 991) {
      const sum = m.stems.drums[0][i] + m.stems.bass[0][i] + m.stems.other[0][i] + m.stems.vocals[0][i]
      expect(Math.abs(sum - m.mixture[0][i])).toBeLessThan(1e-5)
    }
  })
})
