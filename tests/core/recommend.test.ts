import { describe, expect, it } from 'vitest'
import {
  keysCompatible,
  matchReasons,
  matchTier,
  mixRecommendations,
  orderMixList,
  type DeckMixState,
  type MixMatch,
} from '@/core/recommend'
import type { Track } from '@/core/types'

/** Nothing here reads `handle` — it exists only to satisfy `Track`. */
const track = (id: string, bpm?: number, camelot?: string): Track =>
  ({
    id,
    name: id,
    path: id,
    kind: 'audio/mpeg',
    handle: {} as FileSystemFileHandle,
    bpm,
    camelot,
  }) as Track

const deck = (id: 'A' | 'B', over: Partial<DeckMixState> = {}): DeckMixState => ({
  id,
  playing: true,
  bpm: 128,
  tempo: 0,
  trackId: 'onDeck',
  camelot: null,
  ...over,
})

describe('keysCompatible', () => {
  it('the same code is compatible', () => {
    expect(keysCompatible('8A', '8A')).toBe(true)
  })

  it('one step up the wheel is compatible', () => {
    expect(keysCompatible('8A', '9A')).toBe(true)
  })

  it('one step down the wheel is compatible', () => {
    expect(keysCompatible('8A', '7A')).toBe(true)
  })

  it('wraps from 12 to 1', () => {
    // step === 11, the wrap case the plain |na - nb| === 1 check would miss.
    expect(keysCompatible('12A', '1A')).toBe(true)
  })

  it('the relative major/minor (same number, other letter) is compatible', () => {
    expect(keysCompatible('8A', '8B')).toBe(true)
  })

  it('two steps away on the same letter is not compatible', () => {
    expect(keysCompatible('8A', '10A')).toBe(false)
  })

  it('a mismatched number and letter is not compatible', () => {
    expect(keysCompatible('8A', '3B')).toBe(false)
  })

  it('malformed input returns false rather than throwing', () => {
    expect(keysCompatible('8', 'garbage')).toBe(false)
    expect(keysCompatible('', '8A')).toBe(false)
  })

  it('is case-sensitive — a lowercase letter never matches, on purpose', () => {
    // Pinned so a future "helpfully" lowercased tag fails loudly instead of
    // quietly stopping (or starting) to match.
    expect(keysCompatible('8a', '8A')).toBe(false)
  })
})

describe('mixRecommendations', () => {
  it('matches a track already at the deck tempo (1x)', () => {
    const recs = mixRecommendations([deck('A', { bpm: 128 })], [track('t', 128)]).matches
    expect(recs.get('t')?.strong).toBe(true)
  })

  it('matches a track at half the deck tempo (0.5x, half-time)', () => {
    const recs = mixRecommendations([deck('A', { bpm: 128 })], [track('t', 64)]).matches
    expect(recs.has('t')).toBe(true)
  })

  it('matches a track at double the deck tempo (2x, double-time)', () => {
    const recs = mixRecommendations([deck('A', { bpm: 128 })], [track('t', 256)]).matches
    expect(recs.has('t')).toBe(true)
  })

  it('exactly 3% error is still a strong match (inclusive boundary)', () => {
    const recs = mixRecommendations([deck('A', { bpm: 100 })], [track('t', 103)]).matches
    expect(recs.get('t')?.strong).toBe(true)
  })

  it('exactly 8% error is included but not strong', () => {
    const recs = mixRecommendations([deck('A', { bpm: 100 })], [track('t', 108)]).matches
    const m = recs.get('t')
    expect(m).toBeDefined()
    expect(m?.strong).toBe(false)
  })

  it('just over 8% error is excluded entirely', () => {
    const recs = mixRecommendations([deck('A', { bpm: 100 })], [track('t', 108.1)]).matches
    expect(recs.has('t')).toBe(false)
  })

  it('both keys unknown is still a strong match — key alone never excludes', () => {
    const recs = mixRecommendations(
      [deck('A', { bpm: 128, camelot: null })],
      [track('t', 128)],
    ).matches
    const m = recs.get('t')
    expect(m?.strong).toBe(true)
    expect(m?.keyMatch).toBeUndefined()
  })

  it('a clashing key demotes an otherwise-tight tempo match to loose', () => {
    const recs = mixRecommendations(
      [deck('A', { bpm: 128, camelot: '8A' })],
      [track('t', 128, '3B')],
    ).matches
    const m = recs.get('t')
    expect(m?.strong).toBe(false)
    expect(m?.keyMatch).toBe(false)
  })

  it('a track already loaded on a deck is excluded from its own recommendations', () => {
    const recs = mixRecommendations(
      [deck('A', { bpm: 128, trackId: 'onDeck' })],
      [track('onDeck', 128)],
    ).matches
    expect(recs.has('onDeck')).toBe(false)
  })

  it('a track with no BPM is excluded, and counted as skipped', () => {
    const recs = mixRecommendations([deck('A', { bpm: 128 })], [track('t', undefined)])
    expect(recs.matches.has('t')).toBe(false)
    expect(recs.noBpmSkipped).toBe(1)
  })

  it('a deck that is not playing is never used as a reference', () => {
    const recs = mixRecommendations(
      [deck('A', { bpm: 128, playing: false })],
      [track('t', 128)],
    ).matches
    expect(recs.has('t')).toBe(false)
  })

  it('a playing deck with no BPM is never used as a reference', () => {
    const recs = mixRecommendations([deck('A', { bpm: null })], [track('t', 128)])
    expect(recs.matches.has('t')).toBe(false)
  })

  it('an empty deck list returns an empty map and no reason (nothing is playing)', () => {
    const recs = mixRecommendations([], [track('t', 128)])
    expect(recs.matches.size).toBe(0)
    expect(recs.reason).toBeUndefined()
  })

  it('an empty track list returns an empty map', () => {
    expect(mixRecommendations([deck('A')], []).matches.size).toBe(0)
  })

  it('the tempo fader shifts the reference BPM before matching', () => {
    // TEMPO_RANGE = 0.08, so tempo=0.5 lifts a 120 BPM deck to 124.8 effective.
    const decks = [deck('A', { bpm: 120, tempo: 0.5, trackId: 'onDeck' })]
    const atShiftedBpm = mixRecommendations(decks, [track('shifted', 124.8)]).matches
    expect(atShiftedBpm.get('shifted')?.strong).toBe(true)
    const atUnshiftedBpm = mixRecommendations(decks, [track('unshifted', 120)]).matches
    // 120 vs effective 124.8 is a ~3.85% error — matches, but not strong.
    expect(atUnshiftedBpm.get('unshifted')?.strong).toBe(false)
  })

  it('two decks tie exactly on tempo error — the key-compatible one wins', () => {
    // The regression this version fixes: both decks at 128 BPM, track at 128.
    // Deck A's key clashes, deck B's is compatible — B must win, not "A" by
    // array order.
    const recs = mixRecommendations(
      [
        deck('A', { bpm: 128, camelot: '2A', trackId: 'onA' }),
        deck('B', { bpm: 128, camelot: '9A', trackId: 'onB' }),
      ],
      [track('t', 128, '8A')],
    ).matches
    expect(recs.get('t')?.deck).toBe('B')
  })

  it('a tie between equally-compatible decks falls back to array order', () => {
    // Proves the fix doesn't overcorrect into always preferring deck B.
    const recs = mixRecommendations(
      [
        deck('A', { bpm: 128, camelot: '8A', trackId: 'onA' }),
        deck('B', { bpm: 128, camelot: '9A', trackId: 'onB' }),
      ],
      [track('t', 128, '8A')],
    ).matches
    expect(recs.get('t')?.deck).toBe('A')
  })

  it('reports the winning multiplier and both raw BPMs for the chip', () => {
    const recs = mixRecommendations([deck('A', { bpm: 130 })], [track('t', 65)]).matches
    const m = recs.get('t')
    expect(m?.multiplier).toBe(2)
    expect(m?.refBpm).toBe(130)
    expect(m?.trackBpm).toBe(65)
  })

  it('a 1:1 match reports multiplier 1', () => {
    const recs = mixRecommendations([deck('A', { bpm: 128 })], [track('t', 128)]).matches
    expect(recs.get('t')?.multiplier).toBe(1)
  })

  it('no playing deck has a BPM yet — reason names it, not just an empty map', () => {
    const recs = mixRecommendations([deck('A', { bpm: null })], [track('t', 128)])
    expect(recs.matches.size).toBe(0)
    expect(recs.reason).toBe('no-bpm-on-playing-deck')
  })

  it('a playing deck has a BPM but nothing in range — reason says so', () => {
    // 150 vs 100 is out of range at every multiplier: 0.5x->75 (25%), 1x->150
    // (50%), 2x->300 (200%) — unlike 200, which is an exact 0.5x half-time match.
    const recs = mixRecommendations([deck('A', { bpm: 100 })], [track('t', 150)])
    expect(recs.matches.size).toBe(0)
    expect(recs.reason).toBe('none-in-range')
  })

  it('no reason is set when there are matches', () => {
    const recs = mixRecommendations([deck('A', { bpm: 128 })], [track('t', 128)])
    expect(recs.reason).toBeUndefined()
  })
})

describe('mixRecommendations — set history (v0.8.10)', () => {
  const hashed = (id: string, hash: string | undefined, bpm = 128): Track => ({ ...track(id, bpm), contentHash: hash })
  const decks = [deck('A', { bpm: 128 })]
  const lib = [hashed('a', 'ha'), hashed('b', 'hb'), hashed('c', undefined), hashed('d', 'hd', 128.4)]

  it('without a context the result is what it was before', () => {
    const before = mixRecommendations(decks, lib)
    expect(before.playedCount).toBe(0)
    expect(before.unverifiedAgainstHistory).toBe(0)
    for (const m of before.matches.values()) expect(m.played).toBeUndefined()
  })

  it('an empty history is the same as no context — and does not count hash-less tracks', () => {
    const none = mixRecommendations(decks, lib)
    const empty = mixRecommendations(decks, lib, undefined, { playedHashes: new Set() })
    expect(empty).toEqual(none)
  })

  it('flags a track whose hash is in the history, and keeps it in the matches', () => {
    const recs = mixRecommendations(decks, lib, undefined, { playedHashes: new Set(['hb']) })
    expect(recs.matches.get('b')?.played).toBe(true)
    expect(recs.matches.get('a')?.played).toBeUndefined()
    expect(recs.playedCount).toBe(1)
  })

  it('does not change how tight the match is', () => {
    const plain = mixRecommendations(decks, lib).matches.get('b')!
    const played = mixRecommendations(decks, lib, undefined, { playedHashes: new Set(['hb']) }).matches.get('b')!
    expect(played.strong).toBe(plain.strong)
    expect(played.keyMatch).toBe(plain.keyMatch)
    expect(played.deck).toBe(plain.deck)
  })

  it('a track with no hash yet is counted as unverified, not as played', () => {
    const recs = mixRecommendations(decks, lib, undefined, { playedHashes: new Set(['hb']) })
    expect(recs.matches.get('c')?.played).toBeUndefined()
    expect(recs.unverifiedAgainstHistory).toBe(1)
  })

  it('two files with the same hash both read as played', () => {
    const twins = [hashed('x', 'same'), hashed('y', 'same')]
    const recs = mixRecommendations(decks, twins, undefined, { playedHashes: new Set(['same']) })
    expect(recs.playedCount).toBe(2)
  })

  it('a very close match that was played earlier is still suggested', () => {
    const rare = [{ ...hashed('rare', 'hr', 128), camelot: '8A' }]
    const recs = mixRecommendations([deck('A', { bpm: 128, camelot: '8A' })], rare, undefined, {
      playedHashes: new Set(['hr']),
    })
    expect(recs.matches.get('rare')).toMatchObject({ strong: true, played: true })
  })

  it('the same input gives the same order every time', () => {
    const ctx = { playedHashes: new Set(['hb']) }
    const one = [...mixRecommendations(decks, lib, undefined, ctx).matches.keys()]
    const two = [...mixRecommendations(decks, lib, undefined, ctx).matches.keys()]
    expect(one).toEqual(two)
  })
})

describe('orderMixList (v0.8.10)', () => {
  const tracks = ['a', 'b', 'c', 'd', 'e'].map((id) => track(id, 128))
  const match = (played?: boolean) => ({
    strong: true, deck: 'A' as const, multiplier: 1 as const, refBpm: 128, trackBpm: 128, ...(played ? { played } : {}),
  })
  const matches = new Map([['a', match()], ['b', match(true)], ['c', match()], ['d', match(true)]])
  const ids = (l: Track[]) => l.map((t) => t.id)

  it('keeps only suggested tracks (e is not in the matches)', () => {
    expect(ids(orderMixList(tracks, matches, { hidePlayed: false, keepOrder: false }))).not.toContain('e')
  })

  it('pushes played tracks below fresh ones, keeping order within each group', () => {
    expect(ids(orderMixList(tracks, matches, { hidePlayed: false, keepOrder: false }))).toEqual(['a', 'c', 'b', 'd'])
  })

  it('leaves the order alone when the owner picked a sort', () => {
    expect(ids(orderMixList(tracks, matches, { hidePlayed: false, keepOrder: true }))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('drops played tracks when asked to hide them', () => {
    expect(ids(orderMixList(tracks, matches, { hidePlayed: true, keepOrder: false }))).toEqual(['a', 'c'])
    expect(ids(orderMixList(tracks, matches, { hidePlayed: true, keepOrder: true }))).toEqual(['a', 'c'])
  })
})

describe('matchReasons / matchTier (v0.8.11)', () => {
  const m = (over: Partial<MixMatch> = {}): MixMatch => ({
    strong: true, deck: 'A', multiplier: 1, refBpm: 128, trackBpm: 128, keyMatch: true, ...over,
  })

  it('says the track is faster/slower than the deck, with an explicit sign', () => {
    expect(matchReasons(m({ trackBpm: 130 }))[0]).toBe('+2 BPM vs deck A')
    expect(matchReasons(m({ trackBpm: 126 }))[0]).toBe('−2 BPM vs deck A')
    expect(matchReasons(m())[0]).toBe('same tempo as deck A')
  })

  it('names half-time and double-time instead of a BPM delta', () => {
    expect(matchReasons(m({ multiplier: 2, trackBpm: 64 }))[0]).toBe('half-time (64→128)')
    expect(matchReasons(m({ multiplier: 0.5, trackBpm: 256 }))[0]).toBe('double-time (256→128)')
  })

  it('a track with no key is "key unknown", never "key clashes"', () => {
    const r = matchReasons(m({ keyMatch: undefined }))
    expect(r).toContain('key unknown')
    expect(r).not.toContain('key clashes')
  })

  it('says a key clashes only when both keys were compared', () => {
    expect(matchReasons(m({ keyMatch: false }))).toContain('key clashes')
    expect(matchReasons(m({ keyMatch: true }))).toContain('key compatible')
  })

  it('adds the played reason last, and keeps the order fixed', () => {
    expect(matchReasons(m({ played: true }))).toEqual([
      'same tempo as deck A', 'key compatible', 'already loaded this set',
    ])
  })

  it('tiers: tight, loose, then played (which beats strong)', () => {
    expect(matchTier(m())).toBe(0)
    expect(matchTier(m({ strong: false }))).toBe(1)
    expect(matchTier(m({ played: true }))).toBe(2)
    expect(matchTier(m({ strong: false, played: true }))).toBe(2)
  })

  it('does not change which tracks are suggested or how tight they are', () => {
    const lib = [track('a', 128, '8A'), track('b', 130, '3B'), track('c', 300)]
    const recs = mixRecommendations([deck('A', { bpm: 128, camelot: '8A' })], lib)
    expect([...recs.matches.keys()]).toEqual(['a', 'b'])
    expect(recs.matches.get('a')?.strong).toBe(true)
    expect(recs.matches.get('b')?.strong).toBe(false)
  })
})

describe('orderMixList tiers (v0.8.11)', () => {
  const t = ['a', 'b', 'c', 'd'].map((id) => track(id, 128))
  const mm = (strong: boolean, played?: boolean): MixMatch => ({
    strong, deck: 'A', multiplier: 1, refBpm: 128, trackBpm: 128, ...(played ? { played } : {}),
  })
  const matches = new Map([['a', mm(false)], ['b', mm(true, true)], ['c', mm(true)], ['d', mm(false)]])
  const ids = (l: Track[]) => l.map((x) => x.id)

  it('puts tight first, loose next, played last — stable inside a tier', () => {
    expect(ids(orderMixList(t, matches, { hidePlayed: false, keepOrder: false }))).toEqual(['c', 'a', 'd', 'b'])
  })

  it('leaves the owner’s own sort alone', () => {
    expect(ids(orderMixList(t, matches, { hidePlayed: false, keepOrder: true }))).toEqual(['a', 'b', 'c', 'd'])
  })
})
