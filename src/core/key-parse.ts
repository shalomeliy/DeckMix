/**
 * Reading a key or a BPM the way a person or a tag writes it. Pure — moved out
 * of `platform/source-fsaccess/tags.ts` in v0.8.38 so the owner's typed values
 * (the Library's "check against Beatport" panel) go through the very same
 * rules a file tag does, instead of a second copy that drifts.
 */

/** BPM values outside this are noise (0, 1, 999, ms-per-beat, …) — for a tag and for a typed value alike. */
export const BPM_MIN = 40
export const BPM_MAX = 220

/** A BPM rounded to 2 decimals, or `undefined` outside `BPM_MIN`–`BPM_MAX`. */
export function parseBpm(raw: string | number | undefined): number | undefined {
  const v = typeof raw === 'number' ? raw : raw == null ? NaN : parseFloat(raw.trim().replace(',', '.'))
  if (!isFinite(v) || v < BPM_MIN || v > BPM_MAX) return undefined
  return Math.round(v * 100) / 100
}

// Camelot wheel, indexed 1..12. Used both to normalise spelling (Gb → F#) and
// to give the recommender a comparable code.
const CAMELOT_MAJOR = ['B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E']
const CAMELOT_MINOR = ['Abm', 'Ebm', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm', 'Am', 'Em', 'Bm', 'F#m', 'Dbm']
// pitch class (C=0) → Camelot number
const MAJOR_PC = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
const MINOR_PC = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]
const NOTE_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

export interface ParsedKey {
  key: string
  camelot: string
}

/**
 * Accepts musical (`Am`, `F#m`, `Bb`, `A minor`, `A Minor`, `B♭ Major`),
 * Camelot (`8A`) and Open Key (`1m`) spellings — DJ software disagrees about
 * which it writes.
 *
 * The words are matched case-insensitively, the single letters are not: a bare
 * `m` is minor and a bare `M` is major, but `Minor` is minor. Until v0.8.38 the
 * whole group was case-sensitive, so `A Minor` — exactly how Beatport prints a
 * key — matched the `M` of "major", failed on the rest, and read as no key.
 */
export function parseKey(raw: string | undefined): ParsedKey | null {
  const s = raw?.trim().replace(/\s+/g, ' ')
  if (!s) return null

  const camelot = /^(\d{1,2})\s*([ABab])$/.exec(s)
  if (camelot) {
    const n = Number(camelot[1])
    if (n < 1 || n > 12) return null
    const minor = camelot[2].toUpperCase() === 'A'
    return { key: (minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[n - 1], camelot: `${n}${minor ? 'A' : 'B'}` }
  }

  const openKey = /^(\d{1,2})\s*([mdMD])$/.exec(s)
  if (openKey) {
    const n = Number(openKey[1])
    if (n < 1 || n > 12) return null
    const minor = openKey[2].toLowerCase() === 'm'
    const c = ((n + 6) % 12) + 1
    return { key: (minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[c - 1], camelot: `${c}${minor ? 'A' : 'B'}` }
  }

  const musical = /^([A-Ga-g])\s*([#♯b♭]?)\s*([mM][iI][nN](?:[oO][rR])?|[mM][aA][jJ](?:[oO][rR])?|m|M|d)?$/.exec(s)
  if (musical) {
    let pc = NOTE_PC[musical[1].toUpperCase()]
    if (musical[2] === '#' || musical[2] === '♯') pc = (pc + 1) % 12
    else if (musical[2] === 'b' || musical[2] === '♭') pc = (pc + 11) % 12
    const q = musical[3] ?? ''
    // a bare `M` means major; a bare `m`, or the word min/minor in any case, means minor
    const minor = q === 'm' || q.toLowerCase().startsWith('min')
    const c = (minor ? MINOR_PC : MAJOR_PC)[pc]
    return { key: (minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[c - 1], camelot: `${c}${minor ? 'A' : 'B'}` }
  }

  return null
}
