import { describe, expect, it } from 'vitest'
import { heardSemitones, planKeySync, shiftCamelot } from '@/core/key-sync'
import { keysCompatible } from '@/core/recommend'
import { parseKey } from '@/core/key-parse'

describe('shiftCamelot (v0.9.21)', () => {
  it('one semitone up is seven steps round the wheel', () => {
    expect(shiftCamelot('8B', 1)).toBe('3B') // C → C#/Db
    expect(shiftCamelot('8A', 1)).toBe(parseKey('A#m')!.camelot) // Am → Bbm
    expect(shiftCamelot('8A', -1)).toBe(parseKey('G#m')!.camelot)
    expect(shiftCamelot('8A', 12)).toBe('8A')
    expect(shiftCamelot('8A', 0)).toBe('8A')
  })
  it('matches parseKey for every key and every shift', () => {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    for (const q of ['', 'm']) {
      for (let pc = 0; pc < 12; pc++) {
        for (let s = -6; s <= 6; s++) {
          const from = parseKey(names[pc] + q)!.camelot
          const to = parseKey(names[(pc + s + 12) % 12] + q)!.camelot
          expect(shiftCamelot(from, s)).toBe(to)
        }
      }
    }
  })
  it('refuses what is not a Camelot code or a whole semitone', () => {
    expect(shiftCamelot('Am', 1)).toBeNull()
    expect(shiftCamelot('13A', 1)).toBeNull()
    expect(shiftCamelot('8A', 0.5)).toBeNull()
  })
})

describe('heardSemitones', () => {
  it('with key lock only the shift is heard; without it the fader moves the pitch', () => {
    expect(heardSemitones(1.08, true, 2)).toBe(2)
    expect(heardSemitones(1.08, false, 2)).toBeCloseTo(1.3324, 4)
    expect(heardSemitones(1, false, 0)).toBe(0)
  })
})

describe('planKeySync', () => {
  it('no move when the keys already fit', () => {
    expect(planKeySync('8A', '8A', 0)).toMatchObject({ shift: 0, to: '8A', target: '8A' })
    expect(planKeySync('8A', '9A', 0)).toMatchObject({ shift: 0 })
    expect(planKeySync('8A', '8B', 0)).toMatchObject({ shift: 0 })
  })
  it('Am against Bbm moves one semitone up, not five', () => {
    expect(planKeySync('8A', '3A', 0)).toMatchObject({ shift: 1, to: '3A' })
  })
  it('always finds a fit within six semitones, and never a larger move than needed', () => {
    for (const a of ['A', 'B']) {
      for (const b of ['A', 'B']) {
        for (let i = 1; i <= 12; i++) {
          for (let j = 1; j <= 12; j++) {
            const plan = planKeySync(`${i}${a}`, `${j}${b}`, 0)!
            expect(Math.abs(plan.shift)).toBeLessThanOrEqual(6)
            expect(keysCompatible(plan.to, `${j}${b}`)).toBe(true)
            for (let s = 0; s < Math.abs(plan.shift); s++) {
              expect(keysCompatible(shiftCamelot(`${i}${a}`, s)!, `${j}${b}`)).toBe(false)
              expect(keysCompatible(shiftCamelot(`${i}${a}`, -s)!, `${j}${b}`)).toBe(false)
            }
          }
        }
      }
    }
  })
  it('on a tie goes downward', () => {
    // 8A vs 2A: +1 → 3A and −1 → 1A both sit next to 2A on the wheel
    expect(planKeySync('8A', '2A', 0)).toMatchObject({ shift: -1, to: '1A' })
    // 8A vs 2B: only 2A fits (the relative minor), and +6 and −6 both land on it — the furthest a key sync ever moves
    expect(planKeySync('8A', '2B', 0)).toMatchObject({ shift: -6, to: '2A' })
  })
  it('follows the other deck as heard, moved by its own key sync or its tempo fader', () => {
    expect(planKeySync('8A', '8A', 1)).toMatchObject({ target: '3A', shift: 1, targetOffBy: null })
    // +8% without key lock is +1.33 semitones: nearer to +1, and flagged as between keys
    const plan = planKeySync('8A', '8A', 12 * Math.log2(1.08))!
    expect(plan.target).toBe('3A')
    expect(plan.targetOffBy).toBeCloseTo(0.3324, 3)
    expect(planKeySync('8A', '8A', 12 * Math.log2(1.01))!.targetOffBy).toBeNull()
  })
  it('nothing to plan without both keys', () => {
    expect(planKeySync(null, '8A', 0)).toBeNull()
    expect(planKeySync('8A', undefined, 0)).toBeNull()
    expect(planKeySync('8A', 'garbage', 0)).toBeNull()
  })
})
