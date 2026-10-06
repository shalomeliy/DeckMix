import { describe, expect, it } from 'vitest'
import { createScrollMemory, endRestore, recordScroll, restoreLanded, switchView } from '@/core/scroll-memory'

describe('scroll memory per list view (v0.9.39)', () => {
  it("Shalom's bug: genre filter, scroll down, play, pause — the whole library comes back where he left it", () => {
    const m = createScrollMemory('all')
    recordScroll(m, 2000, true) // he scrolled down the filtered library
    // Play: Mix Only switches on by itself; first visit to the suggestions starts at the top.
    expect(switchView(m, 'mix')).toBe(0)
    restoreLanded(m, 0)
    // The browser clamps 2000 down to the short suggestions list and fires a scroll event for it.
    recordScroll(m, 0, true)
    // Pause (or the song ends): Mix Only switches off. The old single offset restored this 0.
    expect(switchView(m, 'all')).toBe(2000)
  })

  it('ignores scroll events while a restore is pending — the clamp is the browser, not the owner', () => {
    const m = createScrollMemory('all')
    recordScroll(m, 1500, true)
    switchView(m, 'mix')
    recordScroll(m, 50, true) // a clamp while the restore is pending: ignored
    restoreLanded(m, 0)
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

  it('a transient empty list records nothing', () => {
    const m = createScrollMemory('all')
    recordScroll(m, 900, true)
    recordScroll(m, 0, false)
    switchView(m, 'mix')
    expect(switchView(m, 'all')).toBe(900)
  })

  it("the owner's hand ends a pending restore and his position is what is kept", () => {
    const m = createScrollMemory('all')
    recordScroll(m, 1200, true)
    switchView(m, 'mix')
    restoreLanded(m, 0)
    switchView(m, 'all')
    endRestore(m, 700) // he scrolled before the restore landed
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
