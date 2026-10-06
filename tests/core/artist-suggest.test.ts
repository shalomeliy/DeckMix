import { describe, expect, it } from 'vitest'
import { artistPieces, baseName, suggestArtists } from '@/core/artist-suggest'
import { applyOwnerArtist } from '@/core/tag-merge'
import type { Track } from '@/core/types'

/**
 * v0.9.41. Every file name below is a real one from the owner's library
 * (measured 06/10, 217 of 378 tracks with no artist) — the rules were written
 * against these, so these are what must keep holding.
 */
let n = 0
function t(name: string, over: Partial<Track> = {}): Track {
  n++
  return { id: `t${n}`, name, path: `X/${name}`, kind: 'mp3', handle: {} as FileSystemFileHandle, ...over }
}
/** The first suggestion for `name`, in a library that also holds `others`. */
function first(name: string, others: Track[] = []) {
  const track = t(name)
  return suggestArtists([track, ...others]).byTrack.get(track.id)?.[0]
}

describe('baseName', () => {
  it('drops extension (twice over), track number, pack labels, BPM and underscores', () => {
    expect(baseName('Charly-Black-Party-Animal-BrainDeaD-Remix-DJ-Kobi-M-Private-Edit.mp3.mp3')).toBe(
      'Charly-Black-Party-Animal-BrainDeaD-Remix-DJ-Kobi-M-Private-Edit',
    )
    expect(baseName('05 - J Balvin Ft. Willy William - Mi Gente (Omer Aviram Edit).mp3')).toBe(
      'J Balvin Ft. Willy William - Mi Gente (Omer Aviram Edit)',
    )
    expect(baseName('אודיה - בן אדם (Dj Camelion Extended Mix) - 128 BPM.mp3')).toBe('אודיה - בן אדם (Dj Camelion Extended Mix)')
    expect(baseName('Argy - Tataki (DorB Remix)[VIP Djs].mp3')).toBe('Argy - Tataki (DorB Remix)')
  })
})

describe('suggestArtists — the left side of the dash', () => {
  it('takes the whole left side as written, featured artists included (Shalom 06/10)', () => {
    expect(first('05 - J Balvin Ft. Willy William - Mi Gente (Omer Aviram Edit).mp3')).toMatchObject({
      artist: 'J Balvin Ft. Willy William',
      source: 'name',
    })
    expect(first('Avacada x 4 Strings x OBS, Firebeatz x Makj x Martin Garrix - Xplode (San Atias Mashup).mp3')?.artist).toBe(
      'Avacada x 4 Strings x OBS, Firebeatz x Makj x Martin Garrix',
    )
  })

  it('reads Hebrew names the same way, and a dash with no space before it', () => {
    expect(first('אושר כהן - פלסטרים (Dj Camelion Extended Mix) - 130 BPM.mp3')?.artist).toBe('אושר כהן')
    expect(first('Noa Kirel- Pantera (ERA REDRUM).mp3')?.artist).toBe('Noa Kirel')
    expect(first('אביעד סהר- מחרוזת ללב נכנסת ביתר ירושלים (Dj Camelion Extended Darbuka Mix) - 138 BPM.mp3')?.artist).toBe('אביעד סהר')
  })

  it('splits a bare hyphen only between two Hebrew words, never in a Latin name', () => {
    expect(first('עידו שהם-זאנזיבר רמיקס 2.mp3')?.artist).toBe('עידו שהם')
    expect(first('Charly-Black-Party-Animal-BrainDeaD-Remix-DJ-Kobi-M-Private-Edit.mp3.mp3')).toBeUndefined()
  })

  it('drops invisible direction marks and Windows\' "copy of" prefix', () => {
    expect(first('\u200eאושר כהן ונועה קירל - אין אותי (Shimon Elbaz Extended Remix).wav')?.artist).toBe('אושר כהן ונועה קירל')
    expect(first('\u202bעדן בן זקן - מסיבת הרווקות (Shimon Elbaz Extended Remix)\u202c.wav')?.artist).toBe('עדן בן זקן')
    expect(first('\ufffd\ufffdפאר טסי - מלודי (Shimon Elbaz Extended Remix)\ufffd.wav')?.artist).toBe('פאר טסי')
    expect(first('\u200e\u2068עומר אדם - לילות וקללות.mp3')?.artist).toBe('עומר אדם')
    expect(first('עותק של ליאור נרקיס - מי ששיכור ירים ידיים למעלה פנדה אדיט.mp3')?.artist).toBe('ליאור נרקיס')
  })

  it('takes a long credit too — the owner\'s longest is 84 characters', () => {
    expect(
      first('Clean Bandit Ft. Sean Paul & Anne Marie vs. Henry Fong Vs. Caroline D_Amore - Rockabye 2022 (Hunter Bootleg) 98.mp3')?.artist,
    ).toBe('Clean Bandit Ft. Sean Paul & Anne Marie vs. Henry Fong Vs. Caroline D Amore')
  })

  it('reads underscores as spaces', () => {
    expect(first('סטפן_ומרגי_-_דיבור_נגוע_אמיר_אודאי_רמיקס.mp3')?.artist).toBe('סטפן ומרגי')
  })

  it('splits at the first dash outside brackets, not one inside them', () => {
    expect(first("ABBA - Gimme! Gimme! Gimme! (Matan Richter Edit - Sgt Slick's Melbourne) 2022 .mp3")?.artist).toBe('ABBA')
    expect(first('Argy & Omnya - Aria - Buskilaz Remix -Gidi Assayag Edit[VIP Djs].mp3')?.artist).toBe('Argy & Omnya')
  })

  it('offers nothing when the left side is a title: the right is only a version tag, or the left has one', () => {
    expect(first('Baroleta - (Dor Orpeli Edit).mp3')).toBeUndefined()
    expect(first('A Milli Humble (Or Pilo BlackFix) - 1A - 150.mp3')).toBeUndefined()
    expect(first('I Adore You (Argy & Mor Avrahami) MST - ITAY FIX[VIP Djs].mp3')).toBeUndefined()
  })

  it('never offers a name that is only inside brackets — that is the remixer', () => {
    const buskilaz = t('Somebody - Song.mp3', { artist: 'Buskilaz' })
    expect(first('Freed From Desire (Buskilaz Remix).wav', [buskilaz])).toBeUndefined()
    expect(first('Boom x Move Your Body (Zeevi Edit).mp3')).toBeUndefined()
  })

  it('marks the left side as known when the library already has that artist, and says on how many songs', () => {
    const others = [t('a.mp3', { artist: 'אושר כהן' }), t('b.mp3', { artist: 'אושר כהן' })]
    expect(first('אושר כהן - אהבה (Hasod Remix).mp3', others)).toMatchObject({
      artist: 'אושר כהן',
      source: 'name-known',
      detail: 'אושר כהן is on 2 other songs',
    })
    // one featured artist known is enough to call the credit known
    expect(first('Rihanna ft. Drake - Work (Shay Sium Remix DJ Swid edit).mp3', [t('c.mp3', { artist: 'Drake' })])?.source).toBe('name-known')
  })
})

describe('suggestArtists — the other sources', () => {
  it('a name with no dash that starts with a known artist', () => {
    const others = [t('x.mp3', { artist: 'Bad Bunny' })]
    expect(first('Bad_Bunny_Titi_Me_Pregunto_Intro_Outro_Dj_Rodri_Mix_111_Bpm.mp3', others)).toMatchObject({
      artist: 'Bad Bunny',
      source: 'known-prefix',
    })
  })

  it('Pixabay download names: the uploader, underscores as spaces; a number is not a name', () => {
    expect(first('buzzpsy-rudra-166320.mp3')).toMatchObject({ artist: 'buzzpsy', source: 'pixabay' })
    expect(first('lone_wolf_productions-chantra-psytrance-549570.mp3')?.artist).toBe('lone wolf productions')
    expect(first('86349-freccero-take-me-124228.mp3')).toBeUndefined()
  })

  it('the same song in another file that has an artist', () => {
    const twin = t('Everybody Needs a Man.mp3', { artist: 'Offer Nissim, Maya Simantov', title: 'Everybody Needs a Man' })
    const track = t('Everybody Needs A Man (TAKI Remix 2024).mp3')
    const opts = suggestArtists([track, twin]).byTrack.get(track.id)
    expect(opts?.[0]).toMatchObject({ artist: 'Offer Nissim, Maya Simantov', source: 'same-song', detail: 'Everybody Needs a Man.mp3' })
  })

  it('two different answers are both kept, the file name first; one answer from two sources is one option', () => {
    const twin = t('twin.mp3', { artist: 'Someone Else', title: 'J Balvin - Mi Gente (Remix)' })
    const track = t('J Balvin - Mi Gente.mp3')
    const opts = suggestArtists([track, twin]).byTrack.get(track.id)!
    expect(opts.map((o) => o.artist)).toEqual(['J Balvin', 'Someone Else'])
    const same = t('twin2.mp3', { artist: 'J Balvin', title: 'J Balvin - Mi Gente (Remix)' })
    const track2 = t('J Balvin - Mi Gente.mp3')
    expect(suggestArtists([track2, same]).byTrack.get(track2.id)!.map((o) => o.artist)).toEqual(['J Balvin'])
  })
})

describe('suggestArtists — counting', () => {
  it('counts every track with no artist, and the ones with no hint, so none vanish from view', () => {
    const r = suggestArtists([t('Baila Conmigo (Willy William Remix [Cover Audio]).mp3'), t('136.mp3'), t('Argy - Tataki.mp3'), t('x.mp3', { artist: 'Argy' })])
    expect(r.missing).toBe(3)
    expect(r.byTrack.size).toBe(1)
    expect(r.noHint).toBe(2)
  })

  it('never offers what the owner already rejected for that track', () => {
    const track = t('Argy - Tataki.mp3', { artistRejected: ['argy'] })
    const r = suggestArtists([track])
    expect(r.byTrack.has(track.id)).toBe(false)
    expect(r.noHint).toBe(1)
  })
})

describe('artistPieces', () => {
  it('splits a credit into the names a library would know', () => {
    expect(artistPieces('Rihanna ft. Drake')).toEqual(['rihanna', 'drake'])
    expect(artistPieces('Argy & Omnya')).toEqual(['argy', 'omnya'])
    expect(artistPieces('Offer Nissim, Maya Simantov')).toEqual(['offer nissim', 'maya simantov'])
  })
})

describe('applyOwnerArtist', () => {
  it('puts the accepted artist on, marked as his, over the tag', () => {
    expect(applyOwnerArtist(t('a.mp3', { artist: 'Tag' }), { artist: 'Mine' })).toMatchObject({ artist: 'Mine', artistSource: 'owner' })
  })
  it('carries the rejected ones, and returns the same track when there is nothing', () => {
    expect(applyOwnerArtist(t('a.mp3'), { artistRejected: ['X'] }).artistRejected).toEqual(['X'])
    const same = t('b.mp3')
    expect(applyOwnerArtist(same, undefined)).toBe(same)
    expect(applyOwnerArtist(same, {})).toBe(same)
  })
})
