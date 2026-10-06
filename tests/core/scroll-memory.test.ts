import { describe, expect, it } from 'vitest'
import {
  boxReplaced,
  createScrollMemory,
  listViewKey,
  opensAtTop,
  ownerTookOver,
  recordScroll,
  restoreExpired,
  restoreLanded,
  switchView,
} from '@/core/scroll-memory'

const view = (o: Partial<Parameters<typeof listViewKey>[0]> = {}) =>
  listViewKey({ similarTo: null, mixOnly: false, dupOnly: false, deckIds: ['t1', null], ...o })

describe('scroll memory per list view (v0.9.39)', () => {
  it("Shalom's bug: genre filter, scroll down, play, pause — the whole library comes back where he left it", () => {
    const m = createScrollMemory('all')
    recordScroll(m, 2000, true) // he scrolled down the filtered library
    // Play: Mix Only switches on by itself, and the suggestions open at their top (v0.9.42).
    expect(switchView(m, 'mix:all:t1|-')).toBe(0)
    restoreLanded(m, 0)
    recordScroll(m, 0, true)
    // Pause (or the song ends). v0.12.10's single offset restored that clamp.
    expect(switchView(m, 'all')).toBe(2000)
  })

  it('ignores scroll events while a restore is pending — the clamp is the browser, not the owner', () => {
    const m = createScrollMemory('all')
    recordScroll(m, 1500, true)
    switchView(m, 'mix')
    recordScroll(m, 300, true)
    switchView(m, 'all')
    // First commit: the rendered rows are still the short list's height, so 1500 is clamped.
    restoreLanded(m, 400)
    recordScroll(m, 400, true)
    expect(m.pending).toBe(1500)
    restoreLanded(m, 1500)
    expect(m.pending).toBeNull()
    expect(switchView(m, 'mix')).toBe(300)
  })

  it('a restore that times out keeps the remembered offset, never the clamp (review finding: sticky bottom)', () => {
    const m = createScrollMemory('all')
    recordScroll(m, 1200, true)
    switchView(m, 'dups')
    recordScroll(m, 0, true)
    switchView(m, 'all') // the library got shorter meanwhile: 1200 no longer exists
    restoreLanded(m, 60)
    recordScroll(m, 60, true) // the clamp's scroll event, while pending
    restoreExpired(m)
    switchView(m, 'dups')
    expect(switchView(m, 'all')).toBe(1200)
  })

  it('a transient empty list records nothing', () => {
    const m = createScrollMemory('all')
    recordScroll(m, 900, true)
    recordScroll(m, 0, false)
    switchView(m, 'mix')
    expect(switchView(m, 'all')).toBe(900)
  })

  it('a box an empty state replaced is put back where the view was', () => {
    const m = createScrollMemory('all')
    recordScroll(m, 700, true)
    expect(boxReplaced(m)).toBe(700)
    expect(boxReplaced(createScrollMemory('all'))).toBeNull()
  })

  it("the owner's hand ends a pending restore and his position is what is kept", () => {
    const m = createScrollMemory('all')
    recordScroll(m, 1200, true)
    switchView(m, 'mix')
    switchView(m, 'all')
    ownerTookOver(m, 700) // he scrolled before the restore landed
    expect(m.pending).toBeNull()
    recordScroll(m, 650, true)
    switchView(m, 'mix')
    expect(switchView(m, 'all')).toBe(650)
  })

  it('the same view is not a switch', () => {
    const m = createScrollMemory('all')
    recordScroll(m, 500, true)
    expect(switchView(m, 'all')).toBeNull()
    expect(m.pending).toBeNull()
  })
})

describe('listViewKey: every toggle that swaps the list is its own view', () => {
  it('Duplicates only, Mix Only and More like this each get their own key (review finding: dupOnly shared "all")', () => {
    const keys = [view(), view({ dupOnly: true }), view({ mixOnly: true }), view({ mixOnly: true, dupOnly: true }), view({ similarTo: 'x' })]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("the suggestions are keyed by the decks' tracks — another play is another list", () => {
    expect(view({ mixOnly: true, deckIds: ['t1', null] })).not.toBe(view({ mixOnly: true, deckIds: ['t2', null] }))
    expect(view({ mixOnly: true })).toBe(view({ mixOnly: true }))
  })

  it('the library view does not change when a deck loads a track', () => {
    expect(view({ deckIds: ['t1', null] })).toBe(view({ deckIds: ['t9', 't3'] }))
  })
})

describe('the suggestions open at the top (v0.9.42)', () => {
  it('every PLAY lands at the top of the suggestions, even after he scrolled them last time, and pause restores the library', () => {
    const m = createScrollMemory('all')
    recordScroll(m, 1800, true)
    const mix = view({ mixOnly: true })
    expect(switchView(m, mix)).toBe(0)
    restoreLanded(m, 0)
    recordScroll(m, 400, true) // he scrolled the suggestions
    expect(switchView(m, 'all')).toBe(1800)
    restoreLanded(m, 1800)
    expect(switchView(m, mix)).toBe(0) // the same song played again: top again, not 400
    expect(opensAtTop(mix)).toBe(true)
    expect(opensAtTop(view())).toBe(false)
    expect(opensAtTop(view({ dupOnly: true }))).toBe(false)
  })
})
