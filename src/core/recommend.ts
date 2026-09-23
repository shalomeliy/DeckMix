import { TEMPO_RANGE } from '@/core/constants'
import type { DeckId, Track } from '@/core/types'

/**
 * One remembered excellent X→Y mix, as the recommender carries it. `exitSec`
 * (v0.8.16) is where X was when the mix joined; absent for a pair saved
 * before that version.
 */
export interface ExcellentPairInfo {
  fromName: string
  entrySec: number
  exitSec?: number
}

export interface MixMatch {
  /** true = tight match (bold + dot); false = loose match (dot only) */
  strong: boolean
  /** which playing deck it mixes with, for the dot colour */
  deck: DeckId
  /** the keys are harmonically compatible — only set when both are known */
  keyMatch?: boolean
  /** which multiplier won: 0.5/2 mean the candidate's own tempo is half/double the reference's */
  multiplier: 0.5 | 1 | 2
  /** the playing deck's effective (tempo-adjusted) bpm, for display only */
  refBpm: number
  /** the candidate track's own tagged bpm, for display only */
  trackBpm: number
  /**
   * v0.8.10: this track was already loaded to a deck this session. Only ever
   * `true` or absent — absent means "not known to be played", which also
   * covers a track with no `contentHash` yet (see `unverifiedAgainstHistory`).
   */
  played?: boolean
  /**
   * v0.8.14: this candidate previously followed the reference track in a
   * transition rated "excellent" — directional (see `MixContext.excellentPairs`).
   * Carries the reference track's name (for the "after X: excellent" reason)
   * and the entry second that transition used, so a click can replay it
   * without a second lookup.
   */
  excellentPairAfter?: ExcellentPairInfo
}

/** Why `mixRecommendations` found nothing — so the UI can say so instead of rendering empty. */
export type NoMatchReason = 'no-bpm-on-playing-deck' | 'none-in-range'

export interface MixRecommendations {
  matches: Map<string, MixMatch>
  /** tracks excluded from consideration for carrying no BPM tag at all */
  noBpmSkipped: number
  /** set only when `matches` is empty */
  reason?: NoMatchReason
  /** matches flagged `played` — 0 when no `context` was given */
  playedCount: number
  /**
   * matches we could not check against the set history because they carry no
   * `contentHash` yet (it is filled in lazily, at load or analysis time).
   * Counted so the UI can say so instead of quietly treating them as unplayed.
   */
  unverifiedAgainstHistory: number
}

/** What the recommender may know beyond the decks and the library. */
export interface MixContext {
  /** `contentHash` of every track loaded to a deck this session (`store.history`) */
  playedHashes?: ReadonlySet<string>
  /**
   * v0.8.14: `{fromHash}:{toHash}` → the outgoing track's name and the entry
   * second that pairing used (`mix-pairs-idb`), flattened for every
   * currently-playing deck's own track — directional, built fresh in
   * `Library.tsx`'s memo alongside `playedHashes`.
   */
  excellentPairs?: ReadonlyMap<string, ExcellentPairInfo>
}

/** Just what the recommender needs from a deck — keeps it off per-frame state. */
export interface DeckMixState {
  id: DeckId
  playing: boolean
  bpm: number | null
  tempo: number
  trackId: string | null
  /** Camelot code of the loaded track, when its tags carried a key */
  camelot?: string | null
  /** v0.8.14: for `MixContext.excellentPairs` lookups — undefined when not yet analyzed, same laziness as `Track.contentHash`. */
  contentHash?: string | null
}

/** Camelot neighbours: same code, ±1 on the wheel, or the relative major/minor. */
export function keysCompatible(a: string, b: string): boolean {
  if (a === b) return true
  const pa = /^(\d{1,2})([AB])$/.exec(a)
  const pb = /^(\d{1,2})([AB])$/.exec(b)
  if (!pa || !pb) return false
  const na = Number(pa[1])
  const nb = Number(pb[1])
  if (pa[2] === pb[2]) {
    const step = Math.abs(na - nb)
    return step === 1 || step === 11 // 12 → 1 wraps
  }
  return na === nb // relative major/minor
}

/**
 * Which library tracks mix well with whatever is currently playing.
 *
 * BPM proximity (allowing half/double-time) gates the match; when both tracks
 * carry a key — tags give us one for most of the library since v0.1.7 —
 * harmonic compatibility decides whether it's a strong match or a loose one.
 * Never excluded on key alone: a clashing key is still a mixable tempo.
 */
export function mixRecommendations(
  decks: DeckMixState[],
  tracks: Track[],
  /** Mix Assist (v0.4.6): ids to leave out regardless of tempo/key fit — a
   * track that just came off a deck, still inside its 30s cooldown. */
  excludeIds?: ReadonlySet<string>,
  /** v0.8.10: without it (or with an empty set) the result is what it was before. */
  context?: MixContext,
): MixRecommendations {
  const anyPlaying = decks.some((d) => d.playing)
  const refs = decks
    .filter((d) => d.playing && d.bpm != null && d.trackId)
    .map((d) => ({
      deck: d.id,
      bpm: d.bpm! * (1 + d.tempo * TEMPO_RANGE),
      trackId: d.trackId!,
      camelot: d.camelot ?? null,
      contentHash: d.contentHash ?? null,
    }))

  const matches = new Map<string, MixMatch>()
  if (refs.length === 0) {
    return {
      matches,
      noBpmSkipped: 0,
      reason: anyPlaying ? 'no-bpm-on-playing-deck' : undefined,
      playedCount: 0,
      unverifiedAgainstHistory: 0,
    }
  }

  const onDeck = new Set(refs.map((r) => r.trackId))
  const playedHashes = context?.playedHashes
  // An empty history says nothing about any track, so it must not start
  // counting hash-less tracks as "unverified" — that badge would show on a
  // fresh session, before anything has been loaded.
  const checkHistory = playedHashes != null && playedHashes.size > 0
  let playedCount = 0
  let unverifiedAgainstHistory = 0
  let noBpmSkipped = 0
  for (const t of tracks) {
    if (onDeck.has(t.id) || excludeIds?.has(t.id)) continue
    if (t.bpm == null) {
      noBpmSkipped++
      continue
    }
    let bestErr = Infinity
    let best = refs[0]
    let bestMult: 0.5 | 1 | 2 = 1
    // A tie on tempo error used to fall to array order regardless of which
    // deck actually mixes better — two decks at the same BPM would always
    // highlight for deck A, even when only deck B's key was compatible. An
    // exact tie now yields to the key-compatible side; anything else (a
    // strictly smaller error) still wins outright, as before.
    let bestKeyOk = false
    for (const ref of refs) {
      for (const mult of [0.5, 1, 2] as const) {
        const err = Math.abs(t.bpm * mult - ref.bpm) / ref.bpm
        const keyOk = ref.camelot != null && t.camelot != null && keysCompatible(ref.camelot, t.camelot)
        if (err < bestErr || (err === bestErr && keyOk && !bestKeyOk)) {
          bestErr = err
          best = ref
          bestMult = mult
          bestKeyOk = keyOk
        }
      }
    }
    if (bestErr > 0.08) continue

    const bothKeyed = best.camelot != null && t.camelot != null
    const keyMatch = bothKeyed ? keysCompatible(best.camelot!, t.camelot!) : undefined
    // with keys known, a clash demotes an otherwise tight tempo match to loose
    const strong = bestErr <= 0.03 && keyMatch !== false
    const match: MixMatch = {
      strong,
      deck: best.deck,
      keyMatch,
      multiplier: bestMult,
      refBpm: Math.round(best.bpm),
      trackBpm: Math.round(t.bpm),
    }
    // v0.8.14: directional — only `best → t` is looked up, never the reverse.
    // A pair recorded under a duplicate-hash file applies to every file
    // sharing that hash, same as `played` below.
    if (context?.excellentPairs && best.contentHash && t.contentHash) {
      const info = context.excellentPairs.get(`${best.contentHash}:${t.contentHash}`)
      if (info) match.excellentPairAfter = info
    }
    // Two files with identical bytes share a hash, so both read as played —
    // deliberate: a duplicate of a track you already played is that track.
    if (checkHistory) {
      if (t.contentHash == null) unverifiedAgainstHistory++
      else if (playedHashes.has(t.contentHash)) {
        match.played = true
        playedCount++
      }
    }
    matches.set(t.id, match)
  }
  return {
    matches,
    noBpmSkipped,
    reason: matches.size === 0 ? 'none-in-range' : undefined,
    playedCount,
    unverifiedAgainstHistory,
  }
}

/**
 * Why a track was suggested, as short phrases in a fixed order — the one
 * source for the row's tooltip, its screen-reader text and the selected-row
 * line, so the three cannot drift apart.
 *
 * A track with no key gets "key unknown", never "key clashes": nothing was
 * compared, so nothing can be said to clash.
 */
export function matchReasons(match: MixMatch): string[] {
  const out: string[] = []
  if (match.multiplier === 2) out.push(`half-time (${match.trackBpm}→${match.refBpm})`)
  else if (match.multiplier === 0.5) out.push(`double-time (${match.trackBpm}→${match.refBpm})`)
  else {
    // The track's tempo relative to the deck, so "+2" reads as "2 BPM faster
    // than what's playing" — the reverse subtraction read as "needs +2".
    const delta = match.trackBpm - match.refBpm
    out.push(
      delta === 0
        ? `same tempo as deck ${match.deck}`
        : `${delta > 0 ? '+' : '−'}${Math.abs(delta)} BPM vs deck ${match.deck}`,
    )
  }
  out.push(match.keyMatch === undefined ? 'key unknown' : match.keyMatch ? 'key compatible' : 'key clashes')
  if (match.played) out.push('already loaded this set')
  if (match.excellentPairAfter) out.push(`excellent pair (after ${match.excellentPairAfter.fromName})`)
  return out
}

/**
 * Where a suggestion sits in the Mix Only list: tight and fresh first, loose
 * and fresh next, anything already loaded last. Played beats strong — a track
 * you already used is not the best next pick however well it fits.
 *
 * Deliberately no finer ordering by tempo distance: `refBpm` follows the
 * deck's live tempo fader, so sorting on it would make rows jump while the
 * owner rides the fader. A tier only flips at the 3% line, which the dot
 * already does.
 */
export function matchTier(match: MixMatch): 0 | 1 | 2 {
  if (match.played) return 2
  return match.strong ? 0 : 1
}

/**
 * The Mix Only list: suggested tracks only, in `matchTier` order (or with
 * played tracks dropped when `hidePlayed`). Never hides silently — the caller
 * shows `playedCount` either way.
 *
 * `keepOrder` is set when the owner picked a column sort themselves; that
 * choice wins, so nothing is re-ranked and played tracks are only marked.
 * Otherwise the sort is stable: within a tier the order is whatever `tracks`
 * already had.
 */
export function orderMixList(
  tracks: Track[],
  matches: ReadonlyMap<string, MixMatch>,
  opts: { hidePlayed: boolean; keepOrder: boolean },
): Track[] {
  const suggested = tracks.filter((t) => matches.has(t.id))
  const shown = opts.hidePlayed ? suggested.filter((t) => matches.get(t.id)?.played !== true) : suggested
  if (opts.keepOrder) return shown
  const tier = (t: Track) => matchTier(matches.get(t.id)!)
  return [0, 1, 2].flatMap((n) => shown.filter((t) => tier(t) === n))
}

/**
 * The fixed "Excellent matches" strip (v0.8.14): candidates with a recorded
 * excellent pairing to whatever's playing now, in `tracks` order (stable,
 * same as `orderMixList`'s own within-tier order), capped at `limit`. A
 * separate display channel from the sorted table — never removes a track
 * from `orderMixList`'s own output, and never reorders it.
 */
export function excellentPairSuggestions(
  tracks: Track[],
  matches: ReadonlyMap<string, MixMatch>,
  limit = 3,
): Track[] {
  const out: Track[] = []
  for (const t of tracks) {
    if (matches.get(t.id)?.excellentPairAfter) {
      out.push(t)
      if (out.length >= limit) break
    }
  }
  return out
}
