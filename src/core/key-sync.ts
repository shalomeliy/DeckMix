import { keysCompatible } from '@/core/recommend'

/**
 * Key sync (v0.9.21): move one deck's pitch, by whole semitones and with the key lock holding the tempo apart, to the nearest key that fits
 * the other deck — the same "fits" the next-track suggestions already use (`keysCompatible`: same code, ±1 on the wheel, relative
 * major/minor). Pure.
 */

/** The furthest a deck is moved. Six either way reaches every one of the twelve keys, so a key sync never fails for lack of range. */
export const KEY_SYNC_MAX_SEMITONES = 6

/**
 * A Camelot code moved by `semitones`. One semitone up is seven steps round the wheel (C → C# is 8B → 3B), which is why a neighbour on the
 * wheel is five semitones away and not one. The letter stays: a shifted minor key is still minor.
 */
export function shiftCamelot(camelot: string, semitones: number): string | null {
  const m = /^(\d{1,2})([AB])$/.exec(camelot)
  if (!m || !Number.isInteger(semitones)) return null
  const n = Number(m[1])
  if (n < 1 || n > 12) return null
  const shifted = ((((n - 1 + 7 * semitones) % 12) + 12) % 12) + 1
  return `${shifted}${m[2]}`
}

/**
 * How far a deck sounds from the song's own pitch, in semitones. With the key lock on it is the key sync's shift and nothing else; without
 * it the tempo fader moves the pitch like a record does (+8% is +1.33 semitones), so that is what the other deck is heard at.
 */
export function heardSemitones(rate: number, keyLock: boolean, keyShift: number): number {
  if (keyLock) return keyShift
  return rate > 0 ? 12 * Math.log2(rate) : 0
}

export interface KeySyncPlan {
  /** semitones to move this deck from its own key, −6..+6 */
  shift: number
  /** this deck's key, unmoved */
  from: string
  /** this deck's key after the shift */
  to: string
  /** the other deck's key as heard right now (its own, moved by its key sync or by its tempo fader, rounded to a semitone) */
  target: string
  /**
   * The other deck plays without key lock and its tempo leaves it between two keys (more than a quarter semitone off): `target` is the
   * nearer one, and the caller says so — a key sync onto a key the other deck is not quite in must not read as an exact match.
   */
  targetOffBy: number | null
}

/**
 * The smallest move that makes `mine` fit the other deck as heard. A tie goes downward: pitched down sounds less strained than pitched up
 * by the same amount. (An exact key and a neighbour never tie: the two moves of one size are 2n semitones apart, an even number of steps
 * round the wheel, and a neighbour is one step.) Null when either deck has no key — the caller names which.
 */
export function planKeySync(mine: string | null | undefined, other: string | null | undefined, otherHeard: number): KeySyncPlan | null {
  if (!mine || !other) return null
  const rounded = Math.round(otherHeard)
  const target = shiftCamelot(other, rounded)
  if (!target || !shiftCamelot(mine, 0)) return null
  let best: { shift: number; to: string } | null = null
  for (let size = 0; size <= KEY_SYNC_MAX_SEMITONES && !best; size++) {
    for (const shift of size === 0 ? [0] : [-size, size]) {
      const to = shiftCamelot(mine, shift)!
      if (keysCompatible(to, target)) {
        best = { shift, to }
        break
      }
    }
  }
  if (!best) return null
  const off = otherHeard - rounded
  return { shift: best.shift, from: mine, to: best.to, target, targetOffBy: Math.abs(off) > 0.25 ? off : null }
}
