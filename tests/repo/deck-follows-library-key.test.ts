import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// v0.8.35: the fix lives in a pure function (`decksFollowLibraryKeys`, tested in
// tests/core/tag-merge.test.ts), but the bug was a missing *call*. The store
// imports platform/capabilities and can't be built under tsconfig.test.json's
// no-DOM lib, so the wiring is pinned by reading the source: if `setLibrary`
// ever goes back to touching the library alone, a track loaded before its key
// was known says "key unknown" on the deck for the rest of the set again.
describe('setLibrary keeps loaded decks on the library key (v0.8.35)', () => {
  it('store.ts setLibrary runs decksFollowLibraryKeys', () => {
    const src = readFileSync(new URL('../../src/app/state/store.ts', import.meta.url), 'utf8')
    const start = src.indexOf('setLibrary: (patch) =>')
    expect(start, 'setLibrary implementation not found in store.ts').toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n  setMidi:', start))
    expect(body).toContain('decksFollowLibraryKeys(')
  })
})
