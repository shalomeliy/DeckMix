import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAX_GAP_SEC, MIN_VOICE_SEC, NO_STRIP_GENRES, SMOOTH_RADIUS_CELLS, VOICE_OFF_AT, VOICE_ON_AT, cellsFromProbabilities, detectVocalStrip } from '@/core/sound/vocal-strip.ts'
import { parseVocalModel } from '@/core/sound/vocal-model.ts'
import { VOCAL_STRIP_VERSION } from '@/platform/vocal-strip-idb/store.ts'
import { vocalStateText, CELL_NONE, CELL_VOCAL, VOCAL_CELL_SEC } from '@/core/sound/vocal-timeline.ts'
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

describe("the strip follows the owner's rule: a breath inside singing is still one vocal part", () => {
  // Cells are half a second. `v` = clear voice (0.9), `.` = clear no-voice (0.02).
  const probs = (pattern: string) => [...pattern].map((ch) => (ch === 'v' ? 0.9 : 0.02))
  const cells = (pattern: string) => [...cellsFromProbabilities(probs(pattern))].map((c) => (c === CELL_VOCAL ? 'v' : '.')).join('')

  it('the settings are pinned: a change is a decision, measured against his marks', () => {
    expect({ VOICE_ON_AT, VOICE_OFF_AT, SMOOTH_RADIUS_CELLS, MAX_GAP_SEC, MIN_VOICE_SEC }).toEqual({ VOICE_ON_AT: 0.5, VOICE_OFF_AT: 0.25, SMOOTH_RADIUS_CELLS: 2, MAX_GAP_SEC: 0.5, MIN_VOICE_SEC: 2 })
    expect(VOICE_OFF_AT).toBeLessThan(VOICE_ON_AT)
  })
  it('two values only: a strip never comes out "unsure" any more', () => {
    for (const p of [0, 0.2, 0.3, 0.35, 0.44, 0.5, 1]) {
      expect([...cellsFromProbabilities(new Array(20).fill(p))].every((c) => c === CELL_VOCAL || c === CELL_NONE)).toBe(true)
    }
  })
  it('a word-by-word voice with short breaths is one section, not a flicker', () => {
    // 3 s of voice, 1 s breath, 3 s voice, 1.5 s breath, 3 s voice
    const out = cells('.'.repeat(20) + 'v'.repeat(6) + '..' + 'v'.repeat(6) + '...' + 'v'.repeat(6) + '.'.repeat(20))
    expect(out.match(/v+/g)?.length).toBe(1)
  })
  it('a long stop (here 5 s) splits the singing in two', () => {
    const out = cells('.'.repeat(20) + 'v'.repeat(10) + '.'.repeat(10) + 'v'.repeat(10) + '.'.repeat(20)) // 5 s stop
    expect(out.match(/v+/g)?.length).toBe(2)
  })
  it('a lone shout under 2 s is not drawn as singing; 2 s of voice is', () => {
    expect(cells('.'.repeat(20) + 'vv' + '.'.repeat(20))).not.toContain('v')
    expect(cells('.'.repeat(20) + 'vvv' + '.'.repeat(20))).not.toContain('v') // 1.5 s
    expect(cells('.'.repeat(20) + 'vvvv' + '.'.repeat(20))).toBe('.'.repeat(20) + 'vvvv' + '.'.repeat(20)) // 2 s, edges exact
  })
  it('since 06/10 (his "1.5 s can be silence"): the fill rule is 0.5 s, the smoothing still joins up to 1.5 s, a 2 s pause splits', () => {
    // Not the 2 s rule any more: before 06/10 a 2 s pause was filled. What joins 1.5 s now is the ±1 s smoothing, not the rule.
    const v = 'v'.repeat(10)
    const pad = '.'.repeat(20)
    expect(cells(pad + v + '...' + v + pad)).toBe(pad + 'v'.repeat(23) + pad)
    expect(cells(pad + v + '....' + v + pad)).toBe(pad + v + '....' + v + pad)
    expect(cells(pad + v + '.....' + v + pad)).toBe(pad + v + '.....' + v + pad)
    expect(cells(pad + v + '......' + v + pad)).toBe(pad + v + '......' + v + pad)
  })
  it('hysteresis: a value wobbling between the two thresholds does not start or stop a voice', () => {
    const wobble = (start: number) => [...new Array(10).fill(start), ...Array.from({ length: 40 }, (_, i) => (i % 2 ? 0.3 : 0.4))]
    expect([...cellsFromProbabilities(wobble(0.02)).slice(10)].every((c) => c === CELL_NONE)).toBe(true)
    expect([...cellsFromProbabilities(wobble(0.9)).slice(10)].every((c) => c === CELL_VOCAL)).toBe(true)
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
  it('a Techno or House strip learned from his own marks says so on screen; other genres do not', () => {
    const shipped = parseVocalModel(JSON.parse(readFileSync('src/core/sound/vocal-model.json', 'utf8')), JSON.parse(readFileSync('src/core/sound/vocal-genre-models.json', 'utf8')))
    const t = detectVocalStrip(pcm(40, tone), 'Techno', shipped)
    expect(t.timeline).not.toBeNull()
    expect(t.note).toBe('נלמד מהסימונים שלך ב-Techno')
    expect(detectVocalStrip(pcm(40, tone), 'House', shipped).note).toBe('נלמד מהסימונים שלך ב-House')
    expect(detectVocalStrip(pcm(40, tone), 'Hip Hop', shipped).note).toBeUndefined()
  })
  it('a Techno song where it finds no voice still says "no voice" on screen, not only where the strip came from', () => {
    const g = JSON.parse(readFileSync('src/core/sound/vocal-genre-models.json', 'utf8'))
    g.models.Techno.shift = -50 // every cell far below the threshold: the strip finds no voice at all
    const silentTechno = parseVocalModel(JSON.parse(readFileSync('src/core/sound/vocal-model.json', 'utf8')), g)
    const t = detectVocalStrip(pcm(40, tone), 'Techno', silentTechno)
    expect(t.state).toBe('no-vocals')
    expect(vocalStateText(t.state, t.note)).toBe('שירה: אין שירה — נלמד מהסימונים שלך ב-Techno')
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
  it('pins the thresholds, the smoothing, the rule, the frozen model and the genre models from his marks against the version', () => {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ VOICE_ON_AT, VOICE_OFF_AT, SMOOTH_RADIUS_CELLS, MAX_GAP_SEC, MIN_VOICE_SEC, NO_STRIP_GENRES }))
      .update(readFileSync('src/core/sound/vocal-model.json'))
      .update(readFileSync('src/core/sound/vocal-genre-models.json'))
      .digest('hex')
    expect({ version: VOCAL_STRIP_VERSION, fingerprint }).toEqual({ version: 5, fingerprint: 'ccb6eef8af6a39d6318b1bd93bc8dc12ae26ef327da01c677e70c019ffe616a0' })
  })
})

describe('the "manual" state', () => {
  it('says the computer learned from the song, and never reads as a measurement', () => {
    const t = vocalStateText('manual')!
    expect(t).toContain('סומן ידנית')
    expect(t).not.toBe('שירה: אין שירה')
  })
})
