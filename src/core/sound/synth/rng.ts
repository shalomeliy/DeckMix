/**
 * Seeded randomness for the training-mix generator (v0.12.15). Never `Math.random`: a mix that
 * cannot be rebuilt from its seed cannot be debugged, and the manifest records only the seed.
 */
export type Rng = () => number

/** mulberry32 — small, fast, and good enough for choosing notes and gains. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const uniform = (r: Rng, lo: number, hi: number): number => lo + (hi - lo) * r()
export const chance = (r: Rng, p: number): boolean => r() < p
export const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
export const dbToGain = (db: number): number => Math.pow(10, db / 20)
