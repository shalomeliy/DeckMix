import { beforeAll, describe, expect, it } from 'vitest'
import { docFiles, git, numberedLines, requireGit } from './repo.ts'

/**
 * The docs argue from history — "the gap was invisible (`59c5fe5`)" is how this
 * project records why an invariant exists, and a session is expected to be able
 * to run `git show` on it. A SHA that resolves to nothing turns that reasoning
 * into an assertion nobody can check.
 *
 * Only code spans are scanned, but any hex word inside one counts: the docs write
 * `git show 969f004` as often as a bare `969f004`, and the first version of this
 * test anchored the backticks to the whole span and so saw only the second. A
 * SHA in running prose, outside a span, is still unchecked — the docs do not
 * write them that way, and hex words in plain text are usually MIDI bytes.
 *
 * This is also the tail of a real failure: HANDOFF.md pinned a commit SHA in its
 * push-status line, the line aged into a false claim about the repo's state, and
 * `969f004` removed it. A SHA in the docs is a claim, and claims get checked.
 */
/**
 * A named exclusion, not an omission: the token must contain a hex letter, so
 * `16777215` (0xFFFFFF written out as a decimal colour constant) is not mistaken for a
 * commit. The cost is an all-digit abbreviation — ~4% of 7-character prefixes —
 * going unchecked. Worth it against a rule that cries wolf on every constant.
 */
const CODE_SPAN = /`([^`]+)`/g
const SHA = /(?<![0-9a-zA-Z])(?=[0-9a-f]*[a-f])([0-9a-f]{7,40})(?![0-9a-zA-Z])/g

describe('commit SHAs cited in the docs resolve', () => {
  beforeAll(requireGit)

  it.each(docFiles())('%s', (file) => {
    const missing: string[] = []
    for (const { n, text } of numberedLines(file)) {
      const spans = [...text.matchAll(CODE_SPAN)].map(([, s]) => s)
      for (const [, sha] of spans.join(' ').matchAll(SHA)) {
        let type = ''
        try {
          type = git('cat-file', '-t', sha)
        } catch {
          // `cat-file` exits non-zero for an unknown object; that is the finding.
        }
        if (type !== 'commit') missing.push(`${file}:${n} → ${sha} (${type || 'unknown object'})`)
      }
    }
    expect(
      missing,
      `These look like commit SHAs but do not resolve:\n${missing.join('\n')}\n` +
        'A wrong SHA is worse than none — it reads as evidence. Correct it or drop the reference.',
    ).toEqual([])
  })
})
