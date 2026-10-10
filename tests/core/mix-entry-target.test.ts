import { describe, expect, it } from 'vitest'
import { mixEntryVerdict } from '@/core/mix-entry-target'

describe('mixEntryVerdict', () => {
  it('same track, hashed on both sides: ok', () => {
    expect(mixEntryVerdict({ toTrackId: 't1', toContentHash: 'h' }, { id: 't1', contentHash: 'h' })).toBe('ok')
  })
  it('hash missing when the mix ended but the deck has it now: still ok (was reported as a different track)', () => {
    expect(mixEntryVerdict({ toTrackId: 't1' }, { id: 't1', contentHash: 'h' })).toBe('ok')
  })
  it('same track but never hashed: says so, not "other track"', () => {
    expect(mixEntryVerdict({ toTrackId: 't1' }, { id: 't1' })).toBe('no-hash')
  })
  it('another track loaded, or deck empty: other-track', () => {
    expect(mixEntryVerdict({ toTrackId: 't1', toContentHash: 'h' }, { id: 't2', contentHash: 'x' })).toBe('other-track')
    expect(mixEntryVerdict({ toTrackId: 't1' }, null)).toBe('other-track')
  })
})
