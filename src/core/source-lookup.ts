/**
 * Where the owner goes to check a track's BPM and key by hand (v0.8.38).
 *
 * Only ever a link the owner clicks. The app never fetches the page itself:
 * Beatport blocks it (403 / a bot check), its terms forbid automated reading,
 * and the owner's own rule is that no data from a commercial product flows
 * into the app — what comes back is what he types. That also keeps `src/`
 * free of network calls, which the access-control note in CLAUDE.md relies on.
 *
 * Only the artist and the title go into the URL — never a path, a hash or a
 * note. A track with neither falls back to its file name, and the caller says
 * which of the three it searched by, so a poor search is never a mystery.
 */
export interface SourceQuery {
  url: string
  /** What the search was built from — shown beside the link. */
  basis: 'artist and title' | 'title only' | 'file name'
}

/** `01 - Some Track (Extended Mix).mp3` → `Some Track (Extended Mix)`. */
export function searchableFileName(name: string): string {
  return name
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/^\s*\d{1,3}\s*[-._)\s]\s*/, '')
    .replace(/[_]+/g, ' ')
    .trim()
}

export function beatportSearch(track: { artist?: string; title?: string; name: string }): SourceQuery {
  const artist = track.artist?.trim()
  const title = track.title?.trim()
  const [q, basis]: [string, SourceQuery['basis']] = title
    ? artist
      ? [`${artist} ${title}`, 'artist and title']
      : [title, 'title only']
    : [searchableFileName(track.name), 'file name']
  return { url: `https://www.beatport.com/search?q=${encodeURIComponent(q)}`, basis }
}
