import { describe, expect, it } from 'vitest'
import { libraryEmptyCopy } from '@/core/library-list-copy'

/**
 * v0.6.0 post-close bug: Mix Assist's `mixOnly` auto-turns-on when a deck
 * starts playing, but nothing turned it back off when playback stopped, and
 * its own toggle button only renders while a deck is playing — so once
 * playback ended there was no control left to undo it. A folder with 43
 * tracks and 34 tagged BPMs rendered "No audio files found", because the
 * empty-state copy only ever checked the text filter, never `mixOnly`.
 */
describe('libraryEmptyCopy', () => {
  it('names Duplicates only when it is what emptied the table', () => {
    const copy = libraryEmptyCopy('x', false, 0, null, false, null, false, true)
    expect(copy.title).toBe('No duplicates in this view')
  })

  it('blames the text filter when it matched nothing, even with mixOnly on', () => {
    const copy = libraryEmptyCopy('trance', true, 0)
    expect(copy.title).toBe('No tracks match that filter')
    expect(copy.offerMixOnlyReset).toBe(false)
  })

  /**
   * A deck is playing (mixOnly on), the query DID match real tracks, but
   * mixOnly hid every one of them. "Clear the filter" would be true but
   * useless here — clearing it alone would not bring anything back, since
   * mixOnly is still filtering what's left. mixOnly must win this case.
   */
  it('blames mixOnly, not the filter, when the filter matched tracks mixOnly then hid', () => {
    const copy = libraryEmptyCopy('trance', true, 5)
    expect(copy.title).not.toBe('No tracks match that filter')
    expect(copy.offerMixOnlyReset).toBe(true)
  })

  /** The exact bug: a real library, no filter text, mixOnly hiding all of it. */
  it('names mixOnly, not a missing folder, when it hid a real library', () => {
    const copy = libraryEmptyCopy('', true, 43)
    expect(copy.title).not.toBe('No audio files found')
    expect(copy.body).toMatch(/mix only/i)
    expect(copy.offerMixOnlyReset).toBe(true)
  })

  it('reports a genuinely empty folder as exactly that', () => {
    const copy = libraryEmptyCopy('', false, 0)
    expect(copy.title).toBe('No audio files found')
    expect(copy.offerMixOnlyReset).toBe(false)
  })

  it('does not blame mixOnly when it never had anything to hide', () => {
    // mixOnly true but the folder itself was already empty before it filtered
    const copy = libraryEmptyCopy('', true, 0)
    expect(copy.title).toBe('No audio files found')
    expect(copy.offerMixOnlyReset).toBe(false)
  })

  /**
   * v0.8.1: a crate the owner just clicked is empty. This must win over
   * every other reason, even a stale mixOnly/query combination left over
   * from before the crate was selected — "this crate is empty" is the true,
   * actionable fact, not "no audio files found" or "clear the filter".
   */
  // v0.8.21: this case used to pass `preMixCount: 5`, but that count is taken
  // inside the crate — 5 means the crate is NOT empty. An empty crate is 0.
  it('names the crate, not mixOnly or the query, when a selected crate is empty', () => {
    const copy = libraryEmptyCopy('trance', true, 0, 'Friday set')
    expect(copy.title).toBe('No tracks in "Friday set"')
    expect(copy.offerMixOnlyReset).toBe(false)
  })

  it('blames Mix Only, not the crate, when the crate has tracks and Mix Only hid them (v0.8.21)', () => {
    const copy = libraryEmptyCopy('', true, 5, 'Techno')
    expect(copy.title).toBe('No tracks currently mix with what’s playing')
    expect(copy.offerMixOnlyReset).toBe(true)
  })

  it('falls back to the query/mixOnly logic when no crate is active', () => {
    const copy = libraryEmptyCopy('', false, 0, null)
    expect(copy.title).toBe('No audio files found')
  })

  /**
   * Live bug (2026-09-13): a crate whose real members hadn't been hashed yet
   * by the background analysis queue rendered as a genuinely empty crate —
   * "No tracks in X" — right after a folder scan, indistinguishable from a
   * crate that actually has nothing in it. `CratesRail.tsx`'s own "N not
   * found" badge had the same problem.
   */
  it('says it is still checking, not that the crate is empty, while analysis catches up', () => {
    const copy = libraryEmptyCopy('', false, 0, 'Trance', true)
    expect(copy.title).toBe('Still checking "Trance"')
    expect(copy.title).not.toBe('No tracks in "Trance"')
    expect(copy.offerMixOnlyReset).toBe(false)
  })

  it('reports the crate as empty once analysis has settled', () => {
    const copy = libraryEmptyCopy('', false, 0, 'Trance', false)
    expect(copy.title).toBe('No tracks in "Trance"')
  })
})

describe('libraryEmptyCopy — played tracks hidden (v0.8.10)', () => {
  it('says every suggestion was played, instead of claiming nothing mixes', () => {
    const copy = libraryEmptyCopy('', true, 12, null, false, null, true)
    expect(copy.title).toBe('Every mixable track was already played this set')
    expect(copy.title).not.toBe('No tracks currently mix with what’s playing')
    // Turning Mix Only off would not bring the hidden ones back — the badge does.
    expect(copy.offerMixOnlyReset).toBe(false)
  })

  it('is ignored when Mix Only is off', () => {
    const copy = libraryEmptyCopy('', false, 0, null, false, null, true)
    expect(copy.title).toBe('No audio files found')
  })

  it('v0.9.36: a header ▾ filter that leaves nothing is named, not "No audio files found"', () => {
    const copy = libraryEmptyCopy('', false, 0, null, false, null, false, false, true)
    expect(copy.title).toBe('No tracks match these filters')
  })
})
