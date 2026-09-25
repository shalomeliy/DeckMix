/**
 * The genre taxonomy and the two pure functions genre derivation is built from.
 *
 * Matching is normalized-exact plus a small alias table, not fuzzy/edit-distance
 * matching. A fuzzy matcher trades a rarer, visible failure (folder not recognised,
 * surfaced in the scan notice) for a more common, invisible one (folder matched to
 * the *wrong* genre with full confidence — "Tech House" silently becoming "Techno").
 * The visible failure is the one this project's "never skip silently" rule can
 * actually catch; the invisible one it cannot, so it is designed out instead.
 */

export const GENRES: readonly string[] = [
  'Acid',
  'Afrobeat',
  'Ambient',
  'Blues',
  'Breakbeat',
  'Chillout',
  'Classical',
  'Country',
  'Dancehall',
  'Deep House',
  'Disco',
  'Downtempo',
  'Drum & Bass',
  'Dubstep',
  'Electro',
  'Folk',
  'Funk',
  'Garage',
  'Gospel',
  'Grime',
  'Hardstyle',
  'Hip Hop',
  'House',
  'Indie',
  'Jazz',
  'K-Pop',
  'Latin',
  'Metal',
  'Minimal',
  'Mizrahi',
  'Pop',
  'Progressive House',
  'R&B',
  'Reggae',
  'Reggaeton',
  'Rock',
  'Soul',
  'Tech House',
  'Techno',
  'Trance',
  'Trap',
  'UK Garage',
  'World',
]

/**
 * Folder-name spellings that don't share a normalized form with their canonical
 * entry above, so normalization alone can't resolve them. Extend this table as
 * real folder names turn up unmatched in the scan notice — that notice is the
 * feedback loop this list is meant to grow from.
 */
export const GENRE_ALIASES: Readonly<Record<string, string>> = {
  DnB: 'Drum & Bass',
  'D&B': 'Drum & Bass',
  'Drum and Bass': 'Drum & Bass',
  'Drum n Bass': 'Drum & Bass',
  RnB: 'R&B',
  'R and B': 'R&B',
  Rap: 'Hip Hop',
  'Deep-House': 'Deep House',
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

const NORMALIZED_INDEX: Map<string, string> = new Map()
for (const genre of GENRES) NORMALIZED_INDEX.set(normalize(genre), genre)
for (const [alias, target] of Object.entries(GENRE_ALIASES)) {
  const key = normalize(alias)
  if (!NORMALIZED_INDEX.has(key)) NORMALIZED_INDEX.set(key, target)
}

/**
 * The one folder name a scan must never treat as a genre — see the `Final`
 * catch-all in the owner's real library. Not a silent exemption (unlike
 * `COMPANION_EXT`, which hides files from a count): it simply has no entry
 * above, so it falls into the same "unrecognized" bucket and notice as any
 * other non-matching folder name, on purpose.
 */
export function matchGenre(folderName: string | undefined): string | undefined {
  if (!folderName) return undefined
  const key = normalize(folderName)
  if (!key) return undefined
  return NORMALIZED_INDEX.get(key)
}

/**
 * The immediate parent folder of a scanned file, from `scanLibrary`'s
 * accumulated `prefix` (e.g. `"Techno/"`, `"Techno/2020/"`, or `""` at the
 * scan root). Only the *nearest* folder counts as genre — a file two levels
 * deep under a genre folder does not inherit it, by the same "immediate
 * parent only" rule the spec sets, so this stays a one-segment lookup rather
 * than a walk up the tree.
 */
export function parentFolderName(prefix: string): string | undefined {
  const trimmed = prefix.replace(/\/+$/, '')
  if (!trimmed) return undefined
  const segments = trimmed.split('/')
  return segments[segments.length - 1] || undefined
}

/**
 * The folder a file's genre comes from: its immediate parent, or — for a file
 * sitting directly in the folder the owner picked — that folder's own name
 * (25/09). Shalom picked `Techno` itself rather than `Tracks`, and 42 of its 43
 * rows showed no genre: the root had "no folder to blame", so a folder named
 * exactly like a genre was ignored for the very files inside it.
 */
export function genreFolderFor(prefix: string, rootName: string | undefined): string | undefined {
  return parentFolderName(prefix) ?? (rootName || undefined)
}
