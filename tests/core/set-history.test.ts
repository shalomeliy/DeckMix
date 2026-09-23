import { describe, expect, it } from 'vitest'
import { formatSetHistory } from '@/core/set-history'
import type { HistoryEntry } from '@/core/types'

const DATE = new Date('2026-09-13T12:00:00Z')

function entry(over: Partial<HistoryEntry>): HistoryEntry {
  return { deckId: 'A', contentHash: 'hash', name: 'Track', artist: null, loadedAtMs: 0, ...over }
}

describe('formatSetHistory', () => {
  it('produces just the header for an empty set', () => {
    expect(formatSetHistory([], DATE)).toBe('DeckMix set — 2026-09-13\n')
  })

  it('numbers a single entry with no artist', () => {
    const text = formatSetHistory([entry({ name: 'Techno 5' })], DATE)
    expect(text).toBe('DeckMix set — 2026-09-13\n1. Techno 5\n')
  })

  it('includes the artist before an em dash when present', () => {
    const text = formatSetHistory([entry({ name: 'Techno 5', artist: 'Artpeace' })], DATE)
    expect(text).toBe('DeckMix set — 2026-09-13\n1. Artpeace — Techno 5\n')
  })

  it('keeps load order and numbers sequentially across several entries', () => {
    const text = formatSetHistory(
      [entry({ name: 'First' }), entry({ name: 'Second', artist: 'Someone' }), entry({ name: 'Third' })],
      DATE,
    )
    expect(text).toBe('DeckMix set — 2026-09-13\n1. First\n2. Someone — Second\n3. Third\n')
  })
})
