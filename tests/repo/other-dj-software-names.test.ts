import { describe, expect, it } from 'vitest'
import { git, read, requireGit } from './repo.ts'

/**
 * v0.12.2: the owner asked (24/09) that the names of other DJ software leave
 * the repository — the product is proprietary and meant for sale. The first
 * pass searched Latin spellings only, and the independent review found one
 * name still in ROADMAP.md written in Hebrew letters. So both scripts are
 * searched here.
 *
 * Named exemptions, not omissions — each one has a reason in
 * docs/handoff/v0.12.2.md:
 * - `docs/research/` — comparison tables and source links, waiting for the
 *   owner's decision on whether to strip the research's own sources.
 * - `tags.ts` — still reads another program's BPM tag; it goes only once our
 *   own BPM detection replaces it (the owner's condition).
 * - `library.ts` — `COMPANION_EXT` names a file extension; without it those
 *   side files would be counted as "skipped".
 * - this file, which has to spell the names to look for them.
 */
const NAMES = /serato|rekordbox|traktor(?! kontrol)|mixxx|algoriddim|virtual ?dj|engine dj|djay\b|סראטו|סרטו|רקורדבוקס|ריקורדבוקס|טראקטור|מיקסקס/i

const EXEMPT = [
  /^docs\/research\//,
  /^src\/platform\/source-fsaccess\/tags\.ts$/,
  /^src\/platform\/source-fsaccess\/library\.ts$/,
  /^tests\/repo\/other-dj-software-names\.test\.ts$/,
]

const TEXT = /\.(md|ts|tsx|mjs|cjs|js|json|html|css|txt)$/

describe('no other DJ software is named outside the named exemptions', () => {
  it('holds for every tracked text file', () => {
    requireGit()
    const hits: string[] = []
    for (const file of git('ls-files').split('\n')) {
      if (!TEXT.test(file) || EXEMPT.some((r) => r.test(file)) || file === 'package-lock.json') continue
      read(file)
        .split('\n')
        .forEach((line, i) => {
          if (NAMES.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`)
        })
    }
    expect(hits).toEqual([])
  })
})
