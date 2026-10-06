import type { ArtistLookup, OnlineHit } from '@/core/ports/artist-lookup'

/**
 * Apple's public iTunes Search API: no key, no account, read-only GET. Two stores are asked, Israel's
 * and the default one, because Hebrew songs are listed in one and everything else in the other; one of
 * them failing is not an error as long as the other answered. Both failing is said, with the reason.
 */
const STORES = ['IL', 'US'] as const
const TIMEOUT_MS = 8000

async function askStore(term: string, country: string): Promise<OnlineHit[]> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const url = `https://itunes.apple.com/search?media=music&entity=song&limit=25&country=${country}&term=${encodeURIComponent(term)}`
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) throw new Error(`the music store answered ${res.status}`)
    const body = (await res.json()) as { results?: { artistName?: string; trackName?: string }[] }
    return (body.results ?? []).flatMap((r) => (r.artistName && r.trackName ? [{ artist: r.artistName, track: r.trackName }] : []))
  } finally {
    clearTimeout(timer)
  }
}

export const itunesLookup: ArtistLookup = {
  async search(term) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('no internet connection')
    const answers = await Promise.allSettled(STORES.map((c) => askStore(term, c)))
    const ok = answers.flatMap((a) => (a.status === 'fulfilled' ? [a.value] : []))
    if (ok.length === 0) {
      const why = answers.find((a): a is PromiseRejectedResult => a.status === 'rejected')?.reason
      throw new Error(why instanceof Error ? (why.name === 'AbortError' ? 'the music store did not answer in time' : why.message) : 'the music store could not be reached')
    }
    return ok.flat()
  },
}
