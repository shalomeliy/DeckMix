import { describe, expect, it } from 'vitest'
import { barOneApplies, chooseBarGrid, detectBarOne, SURE_MARGIN } from '@/core/downbeat'

const PER_SEC = 200
const BPM = 120 // 0.5 s a beat, 100 frames

/**
 * A kick envelope: a 10-frame spike on every beat while the kick plays, nothing
 * in the breaks. `entries` are the beats where the kick comes back after an
 * 8-bar break; `shift` moves every kick by that many beats (0.5 = off the grid).
 */
function track(beats: number, entries: number[], shift = 0): Float32Array {
  const x = new Float32Array(Math.round(beats * 0.5 * PER_SEC))
  const playing = (b: number) => entries.some((e) => b >= e && b < e + 64)
  for (let b = 0; b < beats; b++) {
    if (!playing(b)) continue
    const at = Math.round((b + shift) * 0.5 * PER_SEC)
    for (let j = 0; j < 10 && at + j < x.length; j++) x[at + j] = 1 - j / 10
  }
  return x
}

describe('v0.9.5 detectBarOne', () => {
  const grid = { bpm: BPM, offsetSec: 0 }

  it('finds the "1" where the kick comes back, and is sure when every section agrees', () => {
    // sections enter on beats 66, 162, 258 — all ≡ 2 (mod 4)
    const r = detectBarOne(track(400, [66, 162, 258]), PER_SEC, grid)
    expect(r?.beat).toBe(2)
    expect(r?.sure).toBe(true)
    expect(r!.margin).toBeGreaterThanOrEqual(SURE_MARGIN)
  })

  it('keeps the first beat, unsure, when the kick never leaves (nothing to go on)', () => {
    // the kick plays from the first beat to the last, never gone
    const r = detectBarOne(track(400, [0, 64, 128, 192, 256, 320]), PER_SEC, grid)
    expect(r).not.toBeNull()
    expect(r!.beat).toBe(0)
    expect(r!.sure).toBe(false)
  })

  it('two sections that disagree leave it unsure', () => {
    const r = detectBarOne(track(400, [66, 161]), PER_SEC, grid)
    expect(r).not.toBeNull()
    expect(r!.margin).toBeLessThan(SURE_MARGIN)
    expect(r!.sure).toBe(false)
  })

  // Shalom (28/09): a kick half-way between two lines → the "1" is the beat before it.
  it('a kick entering half a beat late votes for the beat before it', () => {
    const r = detectBarOne(track(400, [65, 161, 257], 0.5), PER_SEC, grid)
    expect(r?.beat).toBe(1)
  })

  it('says nothing for a track too short or silent', () => {
    expect(detectBarOne(track(20, [0]), PER_SEC, grid)).toBeNull()
    expect(detectBarOne(new Float32Array(400 * 100), PER_SEC, grid)).toBeNull()
  })
})

describe('v0.9.5 chooseBarGrid', () => {
  const det = { bpm: 120, offsetSec: 0.1 }
  const owner = { bpm: 120, offsetSec: 1.3 }
  it("the owner's grid wins and is never shown as unsure", () => {
    expect(chooseBarGrid(det, { beat: 2, margin: 0.1, sure: false }, owner)).toEqual({ beatGrid: owner, barOneUnsure: false })
  })
  it('a sure "1" moves the grid by whole beats, shown as sure', () => {
    const r = chooseBarGrid(det, { beat: 3, margin: 0.9, sure: true }, null)
    expect(r.barOneUnsure).toBe(false)
    expect(r.beatGrid!.bpm).toBe(120)
    expect(r.beatGrid!.offsetSec).toBeCloseTo(0.1 + 1.5, 9)
  })
  // Unsure still moves: on unseen songs that beat the first beat 53/61 to 48/61.
  it('an unsure "1" moves the grid too, but is shown as unsure', () => {
    const r = chooseBarGrid(det, { beat: 1, margin: 0.2, sure: false }, null)
    expect(r.beatGrid!.offsetSec).toBeCloseTo(0.6, 9)
    expect(r.barOneUnsure).toBe(true)
  })
  it('no answer keeps the first beat, unsure; no grid at all is nothing to warn about', () => {
    expect(chooseBarGrid(det, null, null)).toEqual({ beatGrid: det, barOneUnsure: true })
    expect(chooseBarGrid(null, null, null)).toEqual({ beatGrid: null, barOneUnsure: false })
  })
  it('a "1" applies only on the beats it was measured on', () => {
    expect(barOneApplies(det, { bpm: 120.02, offsetSec: 0.1 })).toBe(true)
    expect(barOneApplies({ bpm: 128, offsetSec: 0.1 }, { bpm: 64, offsetSec: 0.1 })).toBe(false)
    expect(barOneApplies(null, det)).toBe(false)
  })
})
