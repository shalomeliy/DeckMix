import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// v0.9.34: the owner (06/10) asked to pull the track list up, with the pads
// gone while it is big and back when it is small. Pads alone free no height —
// the platter column beside them is just as tall (measured: deck 421px either
// way at 1536x710) — so both step aside, and the mixer folds its master row
// beside the crossfader, or the mixer would hold the top at 364px on its own.
// These components can't be rendered in this suite, so the wiring is pinned by
// reading the source; the heights are in docs/handoff/v0.9.34.md.
const read = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8')

describe('track list pulled up hides the pads (v0.9.34)', () => {
  it('the deck shows the pad grid only when the list is not pulled up, and drops the platter with it', () => {
    const src = read('app/components/Deck.tsx')
    expect(src).toContain('const compact = useStore((s) => s.libraryExpanded)')
    expect(src).toMatch(/\{compact \? \([\s\S]*?\) : \(\s*<PadGrid /)
    expect(src).toMatch(/\{!compact && \(\s*<div className="flex shrink-0 items-start gap-2">[\s\S]*?<Platter/)
  })

  it('the tempo fader and the Vinyl / Key lock / Key sync buttons stay on screen in both sizes', () => {
    const src = read('app/components/Deck.tsx')
    expect(src).toContain('{tempoFader(120, false)}')
    expect(src).toContain('{tempoFader(160)}')
    expect(src.match(/\{deckToggles\}/g)?.length).toBe(2)
  })

  it('the mixer folds while the list is pulled up', () => {
    expect(read('app/components/Mixer.tsx')).toContain('const compact = useStore((s) => s.libraryExpanded)')
  })

  it('the handle sits on the list and the size is saved and restored', () => {
    const app = read('app/App.tsx')
    expect(app).toMatch(/<LibraryResizeHandle \/>\s*<Library[ />]/)
    expect(app).toContain('ctl.restoreLibraryLayout()')
    const ctl = read('controls.ts')
    expect(ctl).toContain('saveLibraryExpanded(expanded).catch(')
  })
})
