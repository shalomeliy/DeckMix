import { describe, expect, it } from 'vitest'
import { genreFolderFor, matchGenre, parentFolderName } from '@/core/genres'

/**
 * v0.3.2. The owner's real library is `Tracks/HipHop|House|Techno|Trance|Mizrahi|Final`
 * — the five genre folders below are not a hypothetical, they're what has to work with
 * zero manual intervention on the first real scan.
 */
describe('matchGenre', () => {
  it("resolves every one of the owner's real genre folder names", () => {
    expect(matchGenre('HipHop')).toBe('Hip Hop')
    expect(matchGenre('House')).toBe('House')
    expect(matchGenre('Techno')).toBe('Techno')
    expect(matchGenre('Trance')).toBe('Trance')
    expect(matchGenre('Mizrahi')).toBe('Mizrahi')
  })

  it('is case-insensitive', () => {
    expect(matchGenre('techno')).toBe('Techno')
    expect(matchGenre('TECHNO')).toBe('Techno')
  })

  it('resolves a known alias not reachable by normalization alone', () => {
    expect(matchGenre('DnB')).toBe('Drum & Bass')
    expect(matchGenre('RnB')).toBe('R&B')
  })

  it('normalizes separators without needing an explicit alias', () => {
    expect(matchGenre('Hip-Hop')).toBe('Hip Hop')
    expect(matchGenre('Hip_Hop')).toBe('Hip Hop')
  })

  /**
   * `Final` is not a genre — it is the owner's catch-all folder for finished
   * tracks. It gets no special-case exemption: it simply has no entry in the
   * taxonomy, so it lands in the same "unrecognized" bucket as any other
   * non-matching folder name, on purpose (see core/genres.ts).
   */
  it('does not treat "Final" as a genre', () => {
    expect(matchGenre('Final')).toBeUndefined()
  })

  it('returns undefined for an unrecognized or empty folder name', () => {
    expect(matchGenre('Some Random Folder')).toBeUndefined()
    expect(matchGenre('')).toBeUndefined()
    expect(matchGenre(undefined)).toBeUndefined()
  })
})

describe('parentFolderName', () => {
  it('is undefined at the scan root — no folder to derive genre from', () => {
    expect(parentFolderName('')).toBeUndefined()
  })

  it('reads the folder name one level down', () => {
    expect(parentFolderName('Techno/')).toBe('Techno')
  })

  it('reads only the immediate parent, not an outer genre folder', () => {
    expect(parentFolderName('Techno/2020/')).toBe('2020')
  })
})

describe('genreFolderFor (25/09)', () => {
  it('a file directly in a picked genre folder takes that folder as its genre', () => {
    expect(matchGenre(genreFolderFor('', 'Techno'))).toBe('Techno')
  })
  it('a subfolder still wins over the picked folder', () => {
    expect(genreFolderFor('House/', 'Tracks')).toBe('House')
  })
  it('a picked folder that is not a genre gives no genre, as before', () => {
    expect(matchGenre(genreFolderFor('', 'Tracks'))).toBeUndefined()
  })
})
