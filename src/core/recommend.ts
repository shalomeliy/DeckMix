import { TEMPO_RANGE } from '@/core/constants'
import { cosineSimilarity } from '@/core/embedding-search'
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
  /** the follow-up's content hash — the identity the pair was rated with */
  toHash: string
  /** v0.8.17: its library id at rating time, for a follow-up not yet hashed this session */
  toTrackId?: string
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
  /**
   * v0.8.18: how close this track *sounds* to the deck it matched — cosine on
   * the same embeddings "more like this" uses (v0.8.5). Absent when either
   * side has no embedding yet; `matchReasons` says so rather than leaving the
   * row looking as if it had been compared and lost.
   */
  soundScore?: number
  /**
   * v0.8.18: one of the `SOUND_TOP_COUNT` closest-sounding fresh suggestions —
   * the row's ≈ mark. With both decks playing the three are picked from one
   * pool, so one deck can take all three; the mark's colour and tooltip name
   * the deck, so it never claims the wrong one.
   */
  soundTop?: boolean
  /** v0.8.18: set when the playing deck's own track has no embedding — then no row can be compared, and the reason names the deck, not the row. */
  deckSoundUnanalyzed?: boolean
}

/**
 * How many suggestions get the ≈ mark. A fixed count, not a cosine
 * threshold: averaged MFCC/chroma embeddings sit close together across a
 * whole library, so any absolute cut-off would mark nearly everything or
 * nearly nothing depending on the library. "The closest three" means the
 * same thing in every library.
 */
export const SOUND_TOP_COUNT = 3

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
  const embeddingById = new Map<string, Float32Array>()
  for (const t of tracks) if (t.embedding) embeddingById.set(t.id, t.embedding)
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
    const refEmbedding = embeddingById.get(best.trackId)
    const soundScore = soundSimilarity(refEmbedding, t.embedding)
    if (soundScore !== undefined) match.soundScore = soundScore
    else if (!refEmbedding) match.deckSoundUnanalyzed = true
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
  // Played tracks sit last whatever they sound like, so a ≈ on one would
  // spend one of the three marks on a row the owner is told not to pick.
  ;[...matches.values()]
    .filter((m) => m.soundScore !== undefined && !m.played)
    .sort((a, b) => b.soundScore! - a.soundScore!)
    .slice(0, SOUND_TOP_COUNT)
    .forEach((m) => (m.soundTop = true))
  return {
    matches,
    noBpmSkipped,
    reason: matches.size === 0 ? 'none-in-range' : undefined,
    playedCount,
    unverifiedAgainstHistory,
  }
}

/**
 * `undefined`, never 0, when it can't be measured: a missing embedding, or
 * two from different model versions (the cache upgrades them in the
 * background, so a mixed library is a normal state, not an error). A zero
 * would rank the track as "sounds nothing alike", which nobody measured.
 */
function soundSimilarity(a: Float32Array | undefined, b: Float32Array | undefined): number | undefined {
  if (!a || !b || a.length !== b.length) return undefined
  const score = cosineSimilarity(a, b)
  return Number.isNaN(score) ? undefined : score
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
  // v0.8.18: next to tempo and key — sound is the third musical reason; what
  // follows (played, excellent pair) is about this set's history, not the music.
  if (match.soundTop) out.push(`sounds closest to deck ${match.deck}`)
  else if (match.deckSoundUnanalyzed) out.push(`deck ${match.deck}'s track not analyzed for sound yet`)
  else if (match.soundScore === undefined) out.push('sound not analyzed yet')
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
 * Otherwise, within a tier, the closest-sounding come first (v0.8.18); rows
 * with no sound score keep the order `tracks` already had, after them.
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
  // v0.8.18: sound orders *within* a tier, never across one — a tempo or key
  // fit is what makes a mix possible at all; sounding alike only picks
  // between mixes that already work. Unlike tempo distance (see `matchTier`),
  // the score doesn't move with the fader, so rows don't jump while riding it.
  // Unmeasured rows keep their place after the measured ones (stable sort).
  const bySound = (a: Track, b: Track) => {
    const sa = matches.get(a.id)!.soundScore
    const sb = matches.get(b.id)!.soundScore
    if (sa === undefined || sb === undefined) return Number(sa === undefined) - Number(sb === undefined)
    return sb - sa
  }
  return [0, 1, 2].flatMap((n) => shown.filter((t) => tier(t) === n).sort(bySound))
}

/**
 * v0.8.21: the decks' own tracks, pinned above the Mix Only list. The list
 * holds suggestions only, and a deck's playing track is never a suggestion
 * for itself (`onDeck` in `mixRecommendations`) — so the moment a deck
 * started, the track the owner had just loaded vanished from the table
 * without a word. Pinned from `pool` (the searched/crated view), not the whole
 * library: a filter the owner typed still decides what the table shows. A
 * paused deck's track can also be a suggestion; it appears once, pinned.
 */
export function pinDeckTracks(
  pool: Track[],
  list: Track[],
  deckTrackIds: ReadonlyArray<string | null>,
): { pinned: Track[]; rest: Track[] } {
  const ids = [...new Set(deckTrackIds.filter((id): id is string => id != null))]
  const byId = new Map(pool.map((t) => [t.id, t]))
  const pinned = ids.map((id) => byId.get(id)).filter((t): t is Track => t != null)
  const pinnedIds = new Set(pinned.map((t) => t.id))
  return { pinned, rest: list.filter((t) => !pinnedIds.has(t.id)) }
}

/** One button on the "Excellent matches" strip. */
export interface ExcellentStripEntry {
  track: Track
  /** the playing deck the remembered mix starts from */
  fromDeck: DeckId
  info: ExcellentPairInfo
}

/**
 * The strip's own lookup (v0.8.17), independent of `mixRecommendations`.
 *
 * It used to be a view over the recommender's matches, so everything that
 * hides a *suggestion* hid a pair Shalom had already proven: a track that
 * left a deck under 30s ago (he loaded a random track over it, then pressed
 * PLAY, and the strip stayed empty), a tempo outside the ±8% window, a search
 * or a crate. None of those says anything about a mix he rated Excellent, so
 * the only things excluded here are the ones a click could not use: a track
 * already on a playing deck, and a pair whose track isn't in this library.
 *
 * `library` is the whole scanned library, not the filtered view. `pairs` is
 * keyed `fromHash:toHash`, the same map `MixContext.excellentPairs` takes.
 * Two files with one hash (duplicates) show once, the first in library order.
 */
export function excellentStripEntries(
  library: readonly Track[],
  playing: readonly { deck: DeckId; contentHash: string | null | undefined; trackId: string | null | undefined }[],
  pairs: ReadonlyMap<string, ExcellentPairInfo>,
  limit = 3,
): ExcellentStripEntry[] {
  const onPlayingDeck = new Set(playing.map((p) => p.trackId).filter(Boolean))
  const out: ExcellentStripEntry[] = []
  const seenHashes = new Set<string>()
  for (const p of playing) {
    if (!p.contentHash) continue
    const prefix = `${p.contentHash}:`
    const fromThis = [...pairs].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v)
    if (fromThis.length === 0) continue
    // A track not hashed yet this session (the lazy queue hasn't reached it)
    // is matched by the id it had when the pair was rated; the load hashes
    // it, and `startExcellentPairTransition` refuses if it isn't that file.
    const byId = new Map(fromThis.filter((i) => i.toTrackId).map((i) => [i.toTrackId!, i]))
    for (const t of library) {
      if (out.length >= limit) return out
      if (onPlayingDeck.has(t.id)) continue
      const info = t.contentHash ? pairs.get(prefix + t.contentHash) : byId.get(t.id)
      if (!info || seenHashes.has(info.toHash)) continue
      seenHashes.add(info.toHash)
      out.push({ track: t, fromDeck: p.deck, info })
    }
  }
  return out
}

/**
 * Why the "Excellent matches" strip is empty (v0.8.17). It used to simply not
 * render, and Shalom went looking for it with deck A paused at 0:00, not
 * knowing it only appears while a track plays — and only for pairs that
 * *start* from that track. `null` when the strip has something to show.
 *
 * With the strip no longer filtered by the recommender, a remembered pair
 * that still doesn't show has three causes left: its track is already
 * playing on the other deck, it isn't in this folder, or — for a pair rated
 * before v0.8.17 saved the track's id — it hasn't been identified yet this
 * session.
 */
export function excellentStripHint(input: {
  anyPlaying: boolean
  /** a playing deck's track has no content hash yet, so its pairs can't be looked up */
  playingUnidentified: boolean
  pairsFromPlaying: number
  shown: number
}): string | null {
  if (input.shown > 0) return null
  if (!input.anyPlaying) return 'Play a track to see the mixes you rated Excellent after it.'
  if (input.pairsFromPlaying === 0) {
    // No "in a moment": a hash that failed stays missing for good, and a
    // promise the app can't keep is its own small lie.
    if (input.playingUnidentified) return "The playing track isn't identified yet, so its excellent mixes can't be looked up."
    return 'No mix rated Excellent starts from the playing track yet.'
  }
  const n = input.pairsFromPlaying
  return `${n} excellent mix${n === 1 ? '' : 'es'} after the playing track, not available: already playing on the other deck, not identified yet (the library scan is still running), or not in this folder.`
}
