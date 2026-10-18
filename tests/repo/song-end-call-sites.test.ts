import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * v0.9.70: the places that decide whether there is room for a mix must reason with the song's end, not the file's length. They went through
 * `songEndSec`; one that quietly goes back to `durationSec` brings back the mix planned into a silent tail. This pins the call sites by text
 * because they sit in `controls.ts`, which has no test harness (needs an AudioContext).
 */
const controls = readFileSync('src/controls.ts', 'utf8')

describe('Mix Assist reasons with the song end', () => {
  it.each([
    ['deckHandoffSide', /handoffSide\(vocal, tag, deck\.beatGrid, songEndSec\(deck\.audibleEndSec, deck\.durationSec\)\)/],
    ['deckPhraseJoin', /nextPhraseStartSec\(deck\.beatGrid, [^\n]*songEndSec\(deck\.audibleEndSec, deck\.durationSec\)/],
    ['refuseTooLateEntry after the load', /refuseTooLateEntry\(target, entrySec, songEndSec\(loaded\.audibleEndSec, loaded\.durationSec\)/],
    ['refuseTooLateEntry on a pad press', /refuseTooLateEntry\(deckId, cue!\.positionSec, songEndSec\(decks\[deckId\]\.audibleEndSec/],
    ['outgoing exit candidates', /\.filter\(\(c\) => c\.sec < fromEnd\)/],
  ])('%s', (_name, re) => {
    expect(controls).toMatch(re)
  })

  it('the deck panel is given the end it filters entry points by', () => {
    expect(readFileSync('src/app/components/Deck.tsx', 'utf8')).toMatch(/endSec=\{songEnd\}/)
    expect(readFileSync('src/app/components/TransitionPointsPanel.tsx', 'utf8')).toMatch(/enoughSongAfterMix\(endSec, beatGrid/)
  })
})
