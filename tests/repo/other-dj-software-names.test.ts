import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { git, read, requireGit } from './repo.ts'

/**
 * No other DJ software is named in the repository (v0.12.2, the owner's
 * request of 24/09; extended to the research docs in v0.12.3). The product is
 * proprietary and for sale, and the owner wants no trace of competing systems.
 *
 * The names are held only as SHA-256 fingerprints, never spelled out: the
 * first version of this check had to list them in plain text, which put them
 * right back into the repository it was keeping clean (the owner, 27/09).
 * Every word — Latin or Hebrew, and Hebrew with up to two prefix letters
 * stripped (ב/ל/מ/ה/ו/ש/כ) — and every pair of adjacent words is hashed and
 * looked up. The first pass searched Latin spellings only and missed a name
 * written in Hebrew letters; that is why both scripts are covered.
 *
 * Named exemptions, not omissions:
 * - `tags.ts` still reads another program's BPM tag; it goes only once our own
 *   BPM detection replaces it (the owner's condition, HANDOFF.md).
 * - `library.ts` — `COMPANION_EXT` must spell a file extension to recognise
 *   those side files; without it they would be counted as "skipped".
 * A spelling that is also an ordinary Hebrew word ("his film") was dropped:
 * with prefix stripping it would flag ordinary text (v0.12.3 review).
 * To add a name: `node -e "console.log(require('crypto').createHash('sha256').update('<name>').digest('hex').slice(0,16))"`
 * (lowercase; a two-word name with one space).
 */
const FINGERPRINTS = new Set([
  '3255575957663700', '48e55dd560335b6a', '3d40bc828710762c', 'abca4a0c82577446',
  '59e10c20375f5a8d', '7e04455e833f814b', 'f296b59767e5769a', '857dec9840d8e50c',
  'b029eb778e8860ad', 'f0ccc858e548f63c', '2c1c0f470ab0d7ab', '9efb4910a80288ab',
  '419e6689319e8d13', 'a88b26936c1f7e4f', '1cd41b5a77940b28',
  'b1ec44a757f9e6d8', '116df3dd517ce24b', 'e81622d3844d6686', '91b94cbad298227f',
  'b2e17fe8c605c506',
])

const EXEMPT = new Set(['src/platform/source-fsaccess/tags.ts', 'src/platform/source-fsaccess/library.ts'])
const TEXT = /\.(md|ts|tsx|mjs|cjs|js|json|html|css|txt)$/
const HEBREW_PREFIX = /^[בלמהושכ]{1,2}/

// Memoised: the repo is ~1M words but only tens of thousands of distinct ones,
// and hashing every occurrence ran past vitest's 5 s limit in the full suite.
const seen = new Map<string, boolean>()
const isName = (s: string): boolean => {
  let hit = seen.get(s)
  if (hit === undefined) {
    hit = FINGERPRINTS.has(createHash('sha256').update(s).digest('hex').slice(0, 16))
    seen.set(s, hit)
  }
  return hit
}

function namesIn(line: string): boolean {
  const words = line.toLowerCase().split(/[^a-zא-ת]+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (isName(w)) return true
    if (/[א-ת]/.test(w)) {
      const bare = w.replace(HEBREW_PREFIX, '')
      if (isName(bare) || isName(w.slice(1))) return true
    }
    if (i + 1 < words.length && isName(`${w} ${words[i + 1]}`)) return true
  }
  return false
}

describe('no other DJ software is named outside the named exemptions', () => {
  it('holds for every tracked text file', () => {
    requireGit()
    const hits: string[] = []
    for (const file of git('ls-files').split('\n')) {
      if (!TEXT.test(file) || EXEMPT.has(file) || file === 'package-lock.json') continue
      read(file)
        .split('\n')
        .forEach((line, i) => {
          if (namesIn(line)) hits.push(`${file}:${i + 1}`)
        })
    }
    expect(hits).toEqual([])
  }, 30_000)
})
