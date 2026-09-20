/**
 * What the library table's empty state says once tracks ARE loaded — as
 * opposed to `library-boot.ts`, which covers the panel before anyone has
 * clicked anything.
 *
 * The bug this exists to prevent: an empty table and a header still reading
 * "43 tracks · 34 with BPM" look identical whether the folder genuinely has
 * no readable audio, or `filteredTracks()` narrowed a real library down to
 * nothing (Mix Assist's `mixOnly`, or a text filter). Collapsing those into
 * one "No audio files found" message is exactly the silent skip this
 * project forbids: the message would say the folder has no music when it
 * has 43 tracks and a filter is just hiding them. Pure on purpose — no
 * store, no React — so the three cases are the part worth testing.
 */
export interface LibraryEmptyCopy {
  title: string
  body: string
  /** true when a "Show all tracks" action can resolve this by itself */
  offerMixOnlyReset: boolean
}

export function libraryEmptyCopy(
  query: string,
  mixOnly: boolean,
  /** length of `filteredTracks()` BEFORE the mixOnly narrowing — i.e. what
   * the text filter alone leaves (it already applied `query`, if any).
   * Distinguishes "mixOnly hid a real, filter-matched library" from "there
   * was never anything here [to match]". Checked before `query` below on
   * purpose: a query that matched real tracks, all subsequently hidden by
   * mixOnly, is mixOnly's doing — telling the owner to "clear the filter"
   * would be true but useless, since clearing it alone would not bring
   * anything back. */
  preMixCount: number,
  /**
   * Name of the crate currently narrowing the table (v0.8.1), or `null` for
   * none. Checked first, ahead of mixOnly and the text filter: a crate the
   * owner just clicked is the most deliberate, most recent narrowing, and
   * "this crate is empty" is a different fact from "your search matched
   * nothing" even if both happen to be true at once.
   */
  activeCrateName: string | null = null,
  /**
   * A crate's members are matched against the library by `contentHash`
   * (`CratesRail.tsx`), and a freshly scanned track has none until the
   * background analysis queue reaches it. Right after loading a folder, a
   * crate that genuinely has tracks in it can render exactly like an empty
   * one — "No tracks in X" reads as permanent, so while analysis is still
   * catching up this says so instead of declaring the crate empty.
   */
  crateAnalysisCatchingUp = false,
  /**
   * Title of the seed track behind "find similar" (v0.8.5 M3), or `null`
   * when it isn't active. Checked first, ahead of even the crate — of all
   * four narrowings this file exists to tell apart, a similarity search is
   * the one most likely to legitimately return nothing (the seed is the
   * only embedded track so far, or nothing else in the library scores close
   * to it), and it is also always the most recently clicked one, since
   * choosing a new seed instantly replaces whichever crate/query/mixOnly
   * state was already narrowing the table.
   */
  similarToName: string | null = null,
  /**
   * v0.8.10: Mix Only found suggestions, but every one of them was already
   * loaded this set and the owner chose to hide played tracks. Without its own
   * message this fell through to "no tracks currently mix" — false, and its
   * "turn off Mix Only" advice would not bring anything back.
   */
  allSuggestionsPlayedHidden = false,
): LibraryEmptyCopy {
  if (similarToName) {
    return {
      title: 'No similar tracks found yet',
      body: `Nothing in your library currently sounds close to "${similarToName}" — this fills in as more tracks finish background analysis, or clear the filter to see the whole library.`,
      offerMixOnlyReset: false,
    }
  }
  if (activeCrateName) {
    if (crateAnalysisCatchingUp) {
      return {
        title: `Still checking "${activeCrateName}"`,
        body: 'The library is still analyzing tracks after a scan — this crate will fill back in once it catches up.',
        offerMixOnlyReset: false,
      }
    }
    return {
      title: `No tracks in "${activeCrateName}"`,
      body: 'Drag tracks onto it from the crate rail, or clear the crate filter to see the whole library.',
      offerMixOnlyReset: false,
    }
  }
  if (mixOnly && allSuggestionsPlayedHidden) {
    return {
      title: 'Every mixable track was already played this set',
      body: 'Click the “played” badge in the toolbar to show them again.',
      offerMixOnlyReset: false,
    }
  }
  if (mixOnly && preMixCount > 0) {
    return {
      title: 'No tracks currently mix with what’s playing',
      body: 'Turn off Mix Only to see the whole library again.',
      offerMixOnlyReset: true,
    }
  }
  if (query) {
    return {
      title: 'No tracks match that filter',
      body: 'Clear the filter to see the whole library.',
      offerMixOnlyReset: false,
    }
  }
  return {
    title: 'No audio files found',
    body: 'This folder has no readable .mp3, .wav, .flac, .ogg or .m4a files.',
    offerMixOnlyReset: false,
  }
}
