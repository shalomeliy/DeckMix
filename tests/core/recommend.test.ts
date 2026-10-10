import { describe, expect, it } from 'vitest'
import {
  excellentStripEntries,
  keysCompatible,
  matchReasons,
  matchTier,
  mixRecommendations,
  orderMixList,
  pinDeckTracks,
  tempoStepText,
  type DeckMixState,
  type MixMatch, excellentStripHint } from '@/core/recommend'
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

describe('mixRecommendations — excellent pairs (v0.8.14)', () => {
  const hashed = (id: string, hash: string | undefined, bpm = 128): Track => ({ ...track(id, bpm), contentHash: hash })
  const lib = [hashed('a', 'ha'), hashed('b', 'hb')]
  const pairCtx = { excellentPairs: new Map([['ha:hb', { fromName: 'A track', entrySec: 42, toHash: 'hb' }]]) }

  it('without excellentPairs the result is what it was before', () => {
    const before = mixRecommendations([deck('A', { bpm: 128, contentHash: 'ha' })], lib)
    const without = mixRecommendations([deck('A', { bpm: 128, contentHash: 'ha' })], lib, undefined, {})
    expect(without).toEqual(before)
    for (const m of before.matches.values()) expect(m.excellentPairAfter).toBeUndefined()
  })

  it('flags the candidate that followed the playing deck\'s track in an excellent pairing', () => {
    const recs = mixRecommendations([deck('A', { bpm: 128, contentHash: 'ha' })], lib, undefined, pairCtx)
    expect(recs.matches.get('b')?.excellentPairAfter).toEqual({ fromName: 'A track', entrySec: 42, toHash: 'hb' })
    expect(recs.matches.get('a')?.excellentPairAfter).toBeUndefined()
  })

  it('is directional — the reverse pairing is not inferred', () => {
    // Same pair data, but now hb is what's playing — nothing should say hb→ha.
    const recs = mixRecommendations([deck('A', { bpm: 128, contentHash: 'hb' })], lib, undefined, pairCtx)
    for (const m of recs.matches.values()) expect(m.excellentPairAfter).toBeUndefined()
  })

  it('does not change matchTier — no jump from an excellent pairing alone', () => {
    const recs = mixRecommendations([deck('A', { bpm: 128, contentHash: 'ha' })], lib, undefined, pairCtx)
    const b = recs.matches.get('b')!
    expect(b.excellentPairAfter).toBeDefined()
    expect(matchTier(b)).toBe(0) // strong, not played — same tier as without the pairing
  })

  it('a pair recorded for one hash applies to every file sharing that hash', () => {
    const twins = [hashed('a', 'ha'), hashed('b1', 'hb'), hashed('b2', 'hb')]
    const recs = mixRecommendations([deck('A', { bpm: 128, contentHash: 'ha' })], twins, undefined, pairCtx)
    expect(recs.matches.get('b1')?.excellentPairAfter).toBeDefined()
    expect(recs.matches.get('b2')?.excellentPairAfter).toBeDefined()
  })

  it('matchReasons appends the excellent-pair reason last', () => {
    const recs = mixRecommendations([deck('A', { bpm: 128, contentHash: 'ha' })], lib, undefined, pairCtx)
    const reasons = matchReasons(recs.matches.get('b')!)
    expect(reasons.at(-1)).toBe('excellent pair (after A track)')
  })
})

describe('excellentStripEntries (v0.8.17)', () => {
  const withHash = (id: string, hash: string, bpm = 128) => ({ ...track(id, bpm), contentHash: hash })
  const info = { fromName: 'X', entrySec: 10, exitSec: 180, toHash: 'hy' }
  const playingA = [{ deck: 'A' as const, contentHash: 'hx', trackId: 'x' }]

  it('finds the remembered follow-up for the playing track', () => {
    const lib = [withHash('x', 'hx'), withHash('y', 'hy'), withHash('z', 'hz')]
    const out = excellentStripEntries(lib, playingA, new Map([['hx:hy', info]]))
    expect(out.map((e) => [e.track.id, e.fromDeck])).toEqual([['y', 'A']])
    expect(out[0].info.exitSec).toBe(180)
  })

  it("ignores everything that only hides a *suggestion* — Shalom's 23/09 case", () => {
    // Far outside the ±8% tempo window, and the recommender's inputs (search,
    // crate, "just left a deck") are simply not consulted here.
    const lib = [withHash('x', 'hx'), withHash('y', 'hy', 90)]
    expect(excellentStripEntries(lib, playingA, new Map([['hx:hy', info]])).map((e) => e.track.id)).toEqual(['y'])
  })

  it('skips a follow-up that is already playing on the other deck', () => {
    const lib = [withHash('x', 'hx'), withHash('y', 'hy')]
    const playingBoth = [...playingA, { deck: 'B' as const, contentHash: 'hy', trackId: 'y' }]
    expect(excellentStripEntries(lib, playingBoth, new Map([['hx:hy', info]]))).toEqual([])
  })

  it('is directional — the reverse pair does not count', () => {
    const lib = [withHash('x', 'hx'), withHash('y', 'hy')]
    expect(excellentStripEntries(lib, playingA, new Map([['hy:hx', info]]))).toEqual([])
  })

  it('shows two copies of one file once', () => {
    const lib = [withHash('x', 'hx'), withHash('y1', 'hy'), withHash('y2', 'hy')]
    expect(excellentStripEntries(lib, playingA, new Map([['hx:hy', info]])).map((e) => e.track.id)).toEqual(['y1'])
  })

  it('nothing playing, or a playing track without a hash, gives nothing', () => {
    const lib = [withHash('x', 'hx'), withHash('y', 'hy')]
    const pairs = new Map([['hx:hy', info]])
    expect(excellentStripEntries(lib, [], pairs)).toEqual([])
    expect(excellentStripEntries(lib, [{ deck: 'A', contentHash: undefined, trackId: 'x' }], pairs)).toEqual([])
  })

  it('finds a follow-up not hashed yet this session by the id it was rated with', () => {
    // Fresh folder open: the lazy queue hasn't reached y, so it has no hash.
    const lib = [withHash('x', 'hx'), track('y', 128)]
    const out = excellentStripEntries(lib, playingA, new Map([['hx:hy', { ...info, toTrackId: 'y' }]]))
    expect(out.map((e) => e.track.id)).toEqual(['y'])
  })

  it('a pair saved without an id (before v0.8.17) still needs the hash', () => {
    const lib = [withHash('x', 'hx'), track('y', 128)]
    expect(excellentStripEntries(lib, playingA, new Map([['hx:hy', info]]))).toEqual([])
  })

  it('once hashed, a track is matched by hash only — a new file at the old path does not match', () => {
    const lib = [withHash('x', 'hx'), withHash('y', 'h-other')]
    expect(excellentStripEntries(lib, playingA, new Map([['hx:hy', { ...info, toTrackId: 'y' }]]))).toEqual([])
  })

  it('caps at the limit', () => {
    const lib = [withHash('x', 'hx'), ...['a', 'b', 'c', 'd'].map((id) => withHash(id, `h${id}`))]
    const pairs = new Map(['a', 'b', 'c', 'd'].map((id) => [`hx:h${id}`, { ...info, toHash: `h${id}` }] as const))
    expect(excellentStripEntries(lib, playingA, pairs, 2).map((e) => e.track.id)).toEqual(['a', 'b'])
  })
})

describe('orderMixList (v0.8.10)', () => {
  const tracks = ['a', 'b', 'c', 'd', 'e'].map((id) => track(id, 128))
  const match = (played?: boolean) => ({
    strong: true, deck: 'A' as const, multiplier: 1 as const, refBpm: 128, trackBpm: 128, tempoStep: 0, ...(played ? { played } : {}),
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

describe('pinDeckTracks (v0.8.21)', () => {
  const pool = ['onA', 'onB', 'x', 'y'].map((id) => track(id, 128))
  const ids = (l: Track[]) => l.map((t) => t.id)

  it('pins the deck tracks, A before B, above the suggestions', () => {
    const { pinned, rest } = pinDeckTracks(pool, [pool[2], pool[3]], ['onA', 'onB'])
    expect(ids(pinned)).toEqual(['onA', 'onB'])
    expect(ids(rest)).toEqual(['x', 'y'])
  })

  it('shows a paused deck track that is also a suggestion once, pinned', () => {
    const { pinned, rest } = pinDeckTracks(pool, [pool[1], pool[2]], ['onA', 'onB'])
    expect(ids(pinned)).toEqual(['onA', 'onB'])
    expect(ids(rest)).toEqual(['x'])
  })

  it('respects the search/crate: a deck track outside the pool is not pinned', () => {
    const { pinned } = pinDeckTracks(pool.slice(1), [], ['onA', 'onB'])
    expect(ids(pinned)).toEqual(['onB'])
  })

  it('pins the same track once when both decks hold it, and nothing for empty decks', () => {
    expect(ids(pinDeckTracks(pool, [], ['onA', 'onA']).pinned)).toEqual(['onA'])
    expect(pinDeckTracks(pool, [pool[2]], [null, null]).pinned).toEqual([])
  })
})

describe('matchReasons / matchTier (v0.8.11)', () => {
  // soundScore: measured but not in the top three, so it adds no reason of its
  // own (v0.8.18) and the cases below keep testing only what they name.
  const m = (over: Partial<MixMatch> = {}): MixMatch => ({
    strong: true, deck: 'A', multiplier: 1, refBpm: 128, trackBpm: 128, tempoStep: 0, keyMatch: true, soundScore: 0.5, ...over,
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
    strong, deck: 'A', multiplier: 1, refBpm: 128, trackBpm: 128, tempoStep: 0, ...(played ? { played } : {}),
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

describe('excellentStripHint (v0.8.17)', () => {
  const base = { anyPlaying: true, playingUnidentified: false, pairsFromPlaying: 0, shown: 0 }

  it('says nothing when the strip has suggestions', () => {
    expect(excellentStripHint({ ...base, pairsFromPlaying: 2, shown: 1 })).toBeNull()
  })

  it('tells the owner to play a track when nothing plays — the 23/09 confusion', () => {
    expect(excellentStripHint({ ...base, anyPlaying: false })).toMatch(/Play a track/)
  })

  it('names a playing track with no pairs from it', () => {
    expect(excellentStripHint(base)).toMatch(/No mix rated Excellent starts from the playing track/)
  })

  it('says the track is still being identified rather than "no pairs"', () => {
    expect(excellentStripHint({ ...base, playingUnidentified: true })).toMatch(/isn't identified yet/)
  })

  it('counts pairs that exist but are not shown', () => {
    expect(excellentStripHint({ ...base, pairsFromPlaying: 1 })).toMatch(/^1 excellent mix after/)
    expect(excellentStripHint({ ...base, pairsFromPlaying: 3 })).toMatch(/^3 excellent mixes after/)
  })
})


describe('sound similarity in suggestions (v0.8.18)', () => {
  const vec = (...v: number[]) => new Float32Array(v)
  const withEmb = (id: string, bpm: number, emb?: Float32Array, over: Partial<Track> = {}): Track =>
    ({ ...track(id, bpm), embedding: emb, ...over }) as Track
  const onDeck = withEmb('onDeck', 128, vec(1, 0))

  it('scores each match against the deck it matched, by sound', () => {
    const r = mixRecommendations([deck('A')], [onDeck, withEmb('near', 128, vec(1, 0.1)), withEmb('far', 128, vec(0, 1))])
    expect(r.matches.get('near')!.soundScore!).toBeGreaterThan(r.matches.get('far')!.soundScore!)
  })

  it('leaves the score absent — not 0 — when either side has no embedding', () => {
    const noSeed = mixRecommendations([deck('A')], [withEmb('onDeck', 128), withEmb('x', 128, vec(1, 0))])
    expect(noSeed.matches.get('x')!.soundScore).toBeUndefined()
    // the deck is what's missing, so the reason says so — not every row's fault
    expect(matchReasons(noSeed.matches.get('x')!)).toContain("deck A's track not analyzed for sound yet")
    expect(matchReasons(noSeed.matches.get('x')!)).not.toContain('sound not analyzed yet')
    const noCand = mixRecommendations([deck('A')], [onDeck, withEmb('x', 128)])
    expect(noCand.matches.get('x')!.soundScore).toBeUndefined()
    expect(matchReasons(noCand.matches.get('x')!)).toContain('sound not analyzed yet')
  })

  it('leaves the score absent when the embeddings come from different model versions', () => {
    const r = mixRecommendations([deck('A')], [onDeck, withEmb('x', 128, vec(1, 0, 0))])
    expect(r.matches.get('x')!.soundScore).toBeUndefined()
  })

  it('marks exactly the three closest-sounding fresh suggestions', () => {
    const tracks = [onDeck, ...[0.1, 0.2, 0.3, 0.9, 2].map((y, i) => withEmb(`t${i}`, 128, vec(1, y)))]
    const r = mixRecommendations([deck('A')], tracks)
    const top = [...r.matches].filter(([, m]) => m.soundTop).map(([id]) => id)
    expect(top).toEqual(['t0', 't1', 't2'])
    expect(matchReasons(r.matches.get('t0')!)).toContain('sounds closest to deck A')
  })

  it('never spends a mark on an already-played track', () => {
    const tracks = [onDeck, withEmb('played', 128, vec(1, 0), { contentHash: 'p' }), withEmb('fresh', 128, vec(0, 1), { contentHash: 'f' })]
    const r = mixRecommendations([deck('A')], tracks, undefined, { playedHashes: new Set(['p']) })
    expect(r.matches.get('played')!.soundTop).toBeUndefined()
    expect(r.matches.get('fresh')!.soundTop).toBe(true)
  })

  it('orders by sound within a tier, never across one', () => {
    // 'loose-near' sounds closest but is 5% off tempo; 'strong-far' is a tight fit.
    const tracks = [
      onDeck,
      withEmb('strong-far', 128, vec(0, 1)),
      withEmb('unmeasured', 128),
      withEmb('strong-near', 128, vec(1, 0.2)),
      withEmb('loose-near', 134.4, vec(1, 0)),
    ]
    const r = mixRecommendations([deck('A')], tracks)
    expect(orderMixList(tracks, r.matches, { hidePlayed: false, keepOrder: false }).map((t) => t.id)).toEqual([
      'strong-near', 'strong-far', 'unmeasured', 'loose-near',
    ])
  })

  it('an owner-chosen column sort still wins over sound', () => {
    const tracks = [onDeck, withEmb('far', 128, vec(0, 1)), withEmb('near', 128, vec(1, 0))]
    const r = mixRecommendations([deck('A')], tracks)
    expect(orderMixList(tracks, r.matches, { hidePlayed: false, keepOrder: true }).map((t) => t.id)).toEqual(['far', 'near'])
  })
})

// v0.8.37: the tempo buttons. `tempoStep` is against the deck's *track* BPM,
// not its fader, so riding the fader never reshuffles the rows.
describe('tempo direction (v0.8.37)', () => {
  const deckA = (tempo = 0): DeckMixState => ({ id: 'A', playing: true, bpm: 128, tempo, trackId: 'playing' })
  const lib = [track('playing', 128), track('up1', 129.5), track('up3', 131.5), track('same', 128), track('down2', 125.5)]
  const recs = (tempo = 0) => mixRecommendations([deckA(tempo), { id: 'B', playing: false, bpm: null, tempo: 0, trackId: null }], lib).matches
  const ids = (l: Track[]) => l.map((t) => t.id)
  const order = (direction: 'faster' | 'same' | 'slower' | null) =>
    ids(orderMixList(lib, recs(), { hidePlayed: false, keepOrder: false, direction }))

  it('tempoStep is the track against the deck track, at the winning multiplier', () => {
    expect(recs().get('up3')!.tempoStep).toBeCloseTo(131.5 / 128 - 1, 9)
    const half = mixRecommendations([deckA()], [track('h', 64.5)]).matches.get('h')!
    expect(half.multiplier).toBe(2)
    expect(half.tempoStep).toBeCloseTo(129 / 128 - 1, 9)
  })

  it('does not move with the fader', () => {
    expect(recs(0.2).get('up3')!.tempoStep).toBeCloseTo(recs(0).get('up3')!.tempoStep, 12)
  })

  it('faster: faster rows lead, smallest step first; the rest are kept, not hidden', () => {
    const o = order('faster')
    expect(o.slice(0, 2)).toEqual(['up1', 'up3'])
    expect(o).toHaveLength(4)
  })

  it('slower: slower rows lead', () => {
    expect(order('slower')[0]).toBe('down2')
  })

  it('same: closest tempo first', () => {
    expect(order('same')[0]).toBe('same')
  })

  it('no button: the order is what it was before this version', () => {
    expect(order(null)).toEqual(ids(orderMixList(lib, recs(), { hidePlayed: false, keepOrder: false })))
  })

  it('says it in words', () => {
    const m = recs()
    expect(tempoStepText(m.get('up3')!)).toBe("3% faster than deck A's track")
    expect(tempoStepText(m.get('down2')!)).toBe("2% slower than deck A's track")
    expect(tempoStepText(m.get('same')!)).toBe("same tempo as deck A's track")
  })

  // v0.8.37 review: the tier still beats the direction, and a column sort still beats both.
  const mk = (step: number, over: Partial<MixMatch> = {}): MixMatch => ({
    strong: true, deck: 'A', multiplier: 1, refBpm: 128, trackBpm: 128, tempoStep: step, ...over,
  })
  const five = ['fresh', 'playedFast', 'looseFast', 's1', 's2'].map((id) => track(id, 128))
  const tiered = new Map<string, MixMatch>([
    ['fresh', mk(-0.01)],
    ['playedFast', mk(0.01, { played: true })],
    ['looseFast', mk(0.02, { strong: false })],
  ])
  it('a faster played or loose row never jumps above a fresh tight one', () => {
    expect(ids(orderMixList(five, tiered, { hidePlayed: false, keepOrder: false, direction: 'faster' }))).toEqual([
      'fresh', 'looseFast', 'playedFast',
    ])
  })
  it('a column sort (keepOrder) ignores the direction', () => {
    expect(ids(orderMixList(five, tiered, { hidePlayed: false, keepOrder: true, direction: 'faster' }))).toEqual([
      'fresh', 'playedFast', 'looseFast',
    ])
  })
  it('hidePlayed still hides with a direction on', () => {
    expect(ids(orderMixList(five, tiered, { hidePlayed: true, keepOrder: false, direction: 'faster' }))).not.toContain('playedFast')
  })
  it('same: equal steps fall back to sound, closest first', () => {
    const tie = new Map<string, MixMatch>([['s1', mk(0, { soundScore: 0.2 })], ['s2', mk(0, { soundScore: 0.9 })]])
    expect(ids(orderMixList(five, tie, { hidePlayed: false, keepOrder: false, direction: 'same' }))).toEqual(['s2', 's1'])
  })
  it('with a button on, the row names one tempo reason, not two that disagree', () => {
    const r = matchReasons(mk(0.03, { refBpm: 132, trackBpm: 132 }), { trackTempo: true })
    expect(r[0]).toBe("3% faster than deck A's track")
    expect(r.join(' ')).not.toMatch(/same tempo as deck A/)
  })
})


describe('Mix Only order, whole pipeline (10/10 regression report)', () => {
  // Shalom: "the songs with the filled dot always sat at the top while a song played". The pieces had unit tests; this pins the
  // chain the table actually runs — recommendations, then order — on messy data (missing BPM/key/sound, played tracks, a
  // pinned-style playing deck), so a filled dot can never sit below a ring, nor a played song above an unplayed one.
  it('never puts a looser or already-played suggestion above a stronger, unplayed one', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let round = 0; round < 200; round++) {
      const tracks: Track[] = Array.from({ length: 50 }, (_, i) => ({
        ...track(`t${i}`, rnd() < 0.1 ? undefined : 118 + Math.round(rnd() * 16), rnd() < 0.2 ? undefined : `${1 + Math.floor(rnd() * 12)}${rnd() < 0.5 ? 'A' : 'B'}`),
        contentHash: `h${i}`,
        embedding: rnd() < 0.7 ? Float32Array.from({ length: 8 }, () => rnd() - 0.5) : undefined,
      }))
      const played = new Set(tracks.filter(() => rnd() < 0.3).map((t) => t.contentHash!))
      const recs = mixRecommendations([deck('B', { bpm: 126, trackId: 't0', camelot: '8A', contentHash: 'h0' })], tracks, undefined, { playedHashes: played })
      const tiers = orderMixList(tracks, recs.matches, { hidePlayed: false, keepOrder: false }).map((t) => matchTier(recs.matches.get(t.id)!))
      expect(tiers).toEqual([...tiers].sort((a, b) => a - b))
    }
  })
})
