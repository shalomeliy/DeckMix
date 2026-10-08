import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * v0.9.62: a press on the FLX4 gave no sign on screen. The five actions that flash do it from `controls.ts`, the one place MIDI, mouse,
 * keyboard and AI all pass through, so a controller press lights the same control as a click. The jog and anything drawn every frame must
 * never call it (~670 jog messages a second would re-render a component each time; v0.9.58 spent a version removing stutter).
 */
describe('press flash', () => {
  const ctl = readFileSync('src/controls.ts', 'utf8')

  const body = (name: string): string => {
    const at = ctl.search(new RegExp(`export (async )?function ${name}\\b`))
    expect(at, `${name} exists`).toBeGreaterThanOrEqual(0)
    const next = ctl.slice(at + 10).search(/\nexport (async )?function /)
    return ctl.slice(at, next < 0 ? undefined : at + 10 + next)
  }

  it.each([
    ['syncDeck', 'sync:${deckId}'],
    ['saveDeckTempo', 'deck:${deckId}'],
    ['loadTrackToDeck', 'deck:${deckId}'],
    ['startAutoTransition', 'mix'],
  ])('%s flashes %s', (fn, key) => {
    expect(body(fn)).toContain(`pressFlash(${key.includes('$') ? '`' : "'"}${key}${key.includes('$') ? '`' : "'"})`)
  })

  it('export flashes the deck whose button was pressed', () => {
    expect(body('exportVocalMarks')).toContain('pressFlash(`export:${fromDeck}`)')
  })

  it('a flash is cleared when another key takes over the counter (it used to stay on and swallow the next one)', () => {
    expect(readFileSync('src/app/state/flash.ts', 'utf8')).toMatch(/if \(!n\) \{\s*setLit\(0\)/)
  })

  it('Mix Assist and Save tempo flash after their refusals, not before', () => {
    const mix = body('startAutoTransition')
    expect(mix.indexOf("pressFlash('mix')")).toBeGreaterThan(mix.indexOf('has no beat grid yet'))
    const save = body('saveDeckTempo')
    expect(save.indexOf('pressFlash(')).toBeGreaterThan(save.indexOf('has no identity yet'))
  })

  it.each(['jogTurn', 'jogTouch', 'setTempo', 'setCrossfader', 'setChannelVolume', 'setEq', 'setFilter'])('%s never flashes (it streams)', (fn) => {
    expect(body(fn)).not.toContain('pressFlash')
  })

  it('the flash is 150 ms in both places and reduced motion still shortens it', () => {
    expect(readFileSync('src/app/state/flash.ts', 'utf8')).toContain('FLASH_MS = 150')
    const css = readFileSync('src/index.css', 'utf8')
    expect(css).toMatch(/\.press-flash\s*\{\s*animation: press-flash 150ms/)
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation-duration: 0\.01ms/)
  })
})
