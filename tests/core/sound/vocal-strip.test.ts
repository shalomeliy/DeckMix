import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NONE_AT, NO_STRIP_GENRES, SMOOTH_RADIUS_CELLS, VOCAL_AT, cellsFromProbabilities, detectVocalStrip } from '@/core/sound/vocal-strip.ts'
import { parseVocalModel } from '@/core/sound/vocal-model.ts'
import { VOCAL_STRIP_VERSION } from '@/platform/vocal-strip-idb/store.ts'
import { vocalStateText, CELL_NONE, CELL_UNSURE, CELL_VOCAL, VOCAL_CELL_SEC } from '@/core/sound/vocal-timeline.ts'
import type { PcmData } from '@/core/ports/analyzer'

const model = parseVocalModel(JSON.parse(readFileSync('src/core/sound/vocal-model.json', 'utf8')))
const SR = 22050
function pcm(seconds: number, fill: (t: number) => number, stereo = true): PcmData {
  const n = Math.round(SR * seconds)
  const l = new Float32Array(n)
  const r = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    l[i] = fill(i / SR)
    r[i] = stereo ? fill(i / SR + 0.0007) : l[i]
  }
  return { channels: [l, r], sampleRate: SR }
}

describe('thresholds are the owner\'s "careful guard" choice and are pinned', () => {
  it('the vocal threshold is below the none threshold\'s complement: it warns early and clears late', () => {
    expect(VOCAL_AT).toBe(0.4)
    expect(NONE_AT).toBe(0.15)
    expect(NONE_AT).toBeLessThan(VOCAL_AT)
    expect(VOCAL_AT).toBeLessThan(0.5) // the model was scored at 0.5; a guard that waits for 0.5 is not careful
  })
})

describe('cellsFromProbabilities', () => {
  const run = (p: number, n = 9) => cellsFromProbabilities(new Array(n).fill(p))
  it('maps a steady probability to the three values, with the middle band "unsure"', () => {
    expect([...run(0.9)].every((c) => c === CELL_VOCAL)).toBe(true)
    expect([...run(VOCAL_AT)].every((c) => c === CELL_VOCAL)).toBe(true)
    expect([...run(0.25)].every((c) => c === CELL_UNSURE)).toBe(true)
    expect([...run(NONE_AT)].every((c) => c === CELL_NONE)).toBe(true)
    expect([...run(0.02)].every((c) => c === CELL_NONE)).toBe(true)
  })
  it('smooths: one clear-voice half second between silent ones does not become "vocal", and one silent one inside a vocal stays', () => {
    expect(SMOOTH_RADIUS_CELLS).toBe(1)
    const spike = cellsFromProbabilities([0, 0, 0, 1, 0, 0, 0])
    expect(spike[3]).not.toBe(CELL_VOCAL) // mean of 3 = 0.33, below VOCAL_AT: shown as unsure, not as a certain voice
    expect(spike[3]).toBe(CELL_UNSURE)
    const dip = cellsFromProbabilities([0.9, 0.9, 0.9, 0.0, 0.9, 0.9, 0.9])
    expect(dip[3]).toBe(CELL_VOCAL) // mean 0.6
  })
  it('an unsure region is never turned into "none" by the smoothing alone', () => {
    const c = cellsFromProbabilities([0.02, 0.02, 0.3, 0.3, 0.02, 0.02])
    expect(c[2]).toBe(CELL_UNSURE)
    expect(c[0]).toBe(CELL_NONE)
  })
  it('empty in, empty out', () => {
    expect(cellsFromProbabilities([]).length).toBe(0)
  })
})

describe('detectVocalStrip', () => {
  const tone = (t: number) => 0.3 * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t))
  it('Trance is a named rule: no timeline, and the note says it was not measured', () => {
    expect(NO_STRIP_GENRES).toContain('Trance')
    const r = detectVocalStrip(pcm(40, tone), 'Trance', model)
    expect(r.state).toBe('no-vocals')
    expect(r.timeline).toBeNull()
    expect(r.note).toContain('לא נמדד')
  })
  it('a track shorter than 30 s is "too-short", not an empty strip', () => {
    expect(detectVocalStrip(pcm(10, tone), 'House', model).state).toBe('too-short')
  })
  it('a silent track is "silent"', () => {
    expect(detectVocalStrip(pcm(40, () => 0), 'House', model).state).toBe('silent')
  })
  it('a real track gives one cell per half second, every cell one of the three values', () => {
    const r = detectVocalStrip(pcm(40, tone), 'House', model)
    expect(r.timeline).not.toBeNull()
    expect(r.timeline!.cells.length).toBe(Math.floor(40 / VOCAL_CELL_SEC))
    expect([...r.timeline!.cells].every((c) => c === 0 || c === 1 || c === 2)).toBe(true)
    expect(r.note).toBeUndefined()
  })
  it('a genre the model was not trained on is still computed, and says so', () => {
    const r = detectVocalStrip(pcm(40, tone), 'Final', model)
    expect(r.timeline).not.toBeNull()
    expect(r.note).toContain('לא מוכר')
  })
  it('mono is reported as mono, not hidden', () => {
    expect(detectVocalStrip(pcm(40, tone, false), 'House', model).state).toBe('mono')
  })
})

describe('what the deck says when there is a note', () => {
  it('the Trance rule is never worded as a measured "no vocals"', () => {
    const r = detectVocalStrip(pcm(40, () => 0.1), 'Trance', model)
    const text = vocalStateText(r.state, r.note)!
    expect(text).toContain('לא נמדד')
    expect(text).not.toBe('שירה: אין שירה')
  })
  it('a measured all-quiet track still reads "no vocals"', () => {
    expect(vocalStateText('no-vocals')).toBe('שירה: אין שירה')
  })
  it('every state with a note shows the note', () => {
    for (const s of ['ready', 'queued', 'mono', 'too-short', 'silent', 'failed'] as const) expect(vocalStateText(s, 'NOTE')).toContain('NOTE')
  })
})

describe('the cache version is tied to what the answer depends on', () => {
  // A change to any of these needs VOCAL_STRIP_VERSION bumped (platform/vocal-strip-idb/store.ts), or strips computed before it are served as current.
  it('pins the thresholds, the smoothing, the rule and the frozen model against the version', () => {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ VOCAL_AT, NONE_AT, SMOOTH_RADIUS_CELLS, NO_STRIP_GENRES }))
      .update(readFileSync('src/core/sound/vocal-model.json'))
      .digest('hex')
    expect({ version: VOCAL_STRIP_VERSION, fingerprint }).toEqual({ version: 1, fingerprint: 'ec9eee2f4a46db4ab819a00b0699be0c58f125abcc4f360e71712fb936cbd819' })
  })
})

describe('the "manual" state', () => {
  it('says the computer learned from the song, and never reads as a measurement', () => {
    const t = vocalStateText('manual')!
    expect(t).toContain('סומן ידנית')
    expect(t).not.toBe('שירה: אין שירה')
  })
})
