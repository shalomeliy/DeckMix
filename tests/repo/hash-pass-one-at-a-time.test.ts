import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// v0.9.56: four parallel whole-file reads + digests froze the screen up to ~117 ms per frame (measured 07/10); one at a time cost
// no extra time. Pinned so a "speed-up" back to several hashers brings the waveform jumps back only on purpose.
describe('the identity (hash) pass reads one file at a time', () => {
  it('HASH_CONCURRENCY is 1 and is what the pass uses', () => {
    const src = readFileSync(new URL('../../src/platform/source-fsaccess/library.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/export const HASH_CONCURRENCY = 1\n/)
    expect(src).toContain('Math.min(HASH_CONCURRENCY, total) }, hasher)')
  })
})
