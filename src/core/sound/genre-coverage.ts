/**
 * v0.9.38: for every genre in the library, how many songs the owner has finished marking and whether the vocal strip has a model learned
 * from them. A genre without one is shown by name with how many songs are missing, never left out (the project's "never skip silently").
 */
import { NO_STRIP_GENRES } from '@/core/sound/vocal-strip'

/**
 * The smallest set a genre model was ever fitted on and measured well (House, 31 songs, 75.3% leave-one-out). Below it the number would
 * rest on too few songs to trust, so the genre waits. A floor from experience, not a measurement: a genre can be tried with fewer
 * (Hip Hop, 11 songs, was tried as a test set only) but is not shipped unless the leave-one-out score beats the general model.
 */
export const MIN_SONGS_FOR_GENRE_MODEL = 30

export const NO_GENRE_LABEL = 'No genre set'

export type GenreCoverageState = 'learned' | 'rule' | 'missing' | 'unassigned'

export interface GenreCoverageRow {
  genre: string
  /** Songs in the library with this genre. */
  inLibrary: number
  /** Songs of this genre he marked and finished (counts hand marks even for songs no longer in the folder). */
  marked: number
  state: GenreCoverageState
  /** For 'learned': the songs it was fitted on. For 'missing': how many more finished songs it needs. */
  detail: number
}

export function genreCoverage(
  librarySongGenres: readonly (string | undefined)[],
  markedGenres: readonly (string | undefined)[],
  modelSongs: Readonly<Record<string, number>>,
): GenreCoverageRow[] {
  const inLib = new Map<string, number>()
  for (const g of librarySongGenres) if (g) inLib.set(g, (inLib.get(g) ?? 0) + 1)
  const marked = new Map<string, number>()
  for (const g of markedGenres) if (g) marked.set(g, (marked.get(g) ?? 0) + 1)
  const names = new Set<string>([...inLib.keys(), ...marked.keys(), ...Object.keys(modelSongs), ...NO_STRIP_GENRES])
  const rows: GenreCoverageRow[] = [...names].map((genre) => {
    const m = marked.get(genre) ?? 0
    const state: GenreCoverageState = genre in modelSongs ? 'learned' : NO_STRIP_GENRES.includes(genre) ? 'rule' : 'missing'
    const detail = state === 'learned' ? modelSongs[genre] : state === 'missing' ? Math.max(0, MIN_SONGS_FOR_GENRE_MODEL - m) : 0
    return { genre, inLibrary: inLib.get(genre) ?? 0, marked: m, state, detail }
  })
  rows.sort((a, b) => b.marked - a.marked || b.inLibrary - a.inLibrary || a.genre.localeCompare(b.genre))
  // Songs with no genre use the general model; they get a row of their own so the table's totals add up to the library.
  const noGenreLib = librarySongGenres.filter((g) => !g).length
  const noGenreMarked = markedGenres.filter((g) => !g).length
  if (noGenreLib + noGenreMarked > 0) rows.push({ genre: NO_GENRE_LABEL, inLibrary: noGenreLib, marked: noGenreMarked, state: 'unassigned', detail: 0 })
  return rows
}

/** The song count each shipped genre model was fitted on, read from the file's own provenance. */
export function modelSongCounts(file: { models?: Record<string, { provenance?: Record<string, unknown> }> }): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [g, m] of Object.entries(file.models ?? {})) out[g] = typeof m.provenance?.songs === 'number' ? m.provenance.songs : 0
  return out
}
