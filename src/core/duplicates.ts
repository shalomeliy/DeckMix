import type { Track } from '@/core/types'

/**
 * Finding the same song twice in the library (v0.8.45).
 *
 * Display only: nothing here touches a file. Two tiers, because they mean
 * different things to the owner:
 *  - `identical`: every file in the group has the same `contentHash` — the same
 *    bytes under two names. Certain.
 *  - `probable`: same artist + title (or, with no tags, the same file name) and
 *    a near-equal length, but the bytes differ — an MP3 and a WAV of one song.
 *    A guess, so the UI says "probably".
 *
 * `contentHash` and `durationSec` arrive lazily (scan → tag pass → analysis), so
 * a track can be uncomparable *yet*. Those are counted in `unchecked` rather
 * than dropped: a silent "no duplicates" while half the library is still
 * unidentified would be the same lie the "N skipped" badge exists to prevent.
 */

/** Two encodes of one song differ by encoder padding, rarely more than a second. */
export const DURATION_TOLERANCE_SEC = 1.5
/** A normalized name this short ("a", "01") would match unrelated files. */
const MIN_KEY_LENGTH = 4

export type DuplicateKind = 'identical' | 'probable'

export interface DuplicateGroup {
  id: string
  kind: DuplicateKind
  /** track ids, in library order */
  trackIds: string[]
}

export interface DuplicateReport {
  groups: DuplicateGroup[]
  /** track id → its group, for the per-row tag */
  byTrack: Map<string, DuplicateGroup>
  /** tracks that cannot be compared yet: no content hash and no usable name+length */
  unchecked: number
}

/** "01 - Artist – Title (Mix).mp3" and "artist title mix" must meet. */
export function normalizeName(s: string): string {
  return s
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/^\s*\d{1,3}\s*[-._)]\s*/, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function nameKey(t: Track): string {
  const key = t.artist && t.title ? normalizeName(`${t.artist} ${t.title}`) : normalizeName(t.name)
  return key.length >= MIN_KEY_LENGTH ? key : ''
}

export function findDuplicates(tracks: readonly Track[]): DuplicateReport {
  // union-find over track indexes, so a hash match and a name match that
  // overlap on one track end up in a single group
  const parent = tracks.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b)
  }

  const byHash = new Map<string, number>()
  tracks.forEach((t, i) => {
    if (!t.contentHash) return
    const first = byHash.get(t.contentHash)
    if (first === undefined) byHash.set(t.contentHash, i)
    else union(first, i)
  })

  const byName = new Map<string, number[]>()
  tracks.forEach((t, i) => {
    const key = nameKey(t)
    if (!key || t.durationSec === undefined) return
    const list = byName.get(key)
    if (list) list.push(i)
    else byName.set(key, [i])
  })
  for (const idxs of byName.values()) {
    // Measured from the shortest file of each run, not from the neighbour:
    // chaining neighbours would let a run of 1.4s steps join files 6s apart.
    const sorted = [...idxs].sort((a, b) => tracks[a].durationSec! - tracks[b].durationSec!)
    let anchor = sorted[0]
    for (let k = 1; k < sorted.length; k++) {
      if (tracks[sorted[k]].durationSec! - tracks[anchor].durationSec! <= DURATION_TOLERANCE_SEC) {
        union(anchor, sorted[k])
      } else {
        anchor = sorted[k]
      }
    }
  }

  const members = new Map<number, number[]>()
  tracks.forEach((_, i) => {
    const root = find(i)
    const list = members.get(root)
    if (list) list.push(i)
    else members.set(root, [i])
  })

  const groups: DuplicateGroup[] = []
  const byTrack = new Map<string, DuplicateGroup>()
  for (const idxs of members.values()) {
    if (idxs.length < 2) continue
    const hashes = idxs.map((i) => tracks[i].contentHash)
    const identical = hashes[0] !== undefined && hashes.every((h) => h === hashes[0])
    const group: DuplicateGroup = {
      id: tracks[idxs[0]].id,
      kind: identical ? 'identical' : 'probable',
      trackIds: idxs.map((i) => tracks[i].id),
    }
    groups.push(group)
    for (const id of group.trackIds) byTrack.set(id, group)
  }

  const unchecked = tracks.filter(
    (t) => !t.contentHash && (!nameKey(t) || t.durationSec === undefined),
  ).length
  return { groups, byTrack, unchecked }
}
