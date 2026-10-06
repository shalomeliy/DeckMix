import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { read, ROOT } from './repo.ts'

/**
 * Settings → Privacy & Terms (v0.8.7) states that SoundGrid has no server,
 * no telemetry, and no cookies — verified 12/09 by grepping `src/` for
 * `fetch(`/`analytics`/`cookie` and finding zero hits (write-feature-spec).
 * A claim like that goes stale the moment someone adds a server call or a
 * tracking snippet without also updating the privacy page — the exact
 * silent-drift shape `CLAUDE.md`'s Broken-Access-Control note already warns
 * about for a different claim. This is that same grep, wired to fail loudly
 * instead of rotting quietly.
 *
 * `src/app/legal-content.ts` is the one named exemption — it is the page
 * *discussing* cookies/analytics/fetch, the same way `COMPANION_EXT` in
 * `platform/source-fsaccess/library.ts` is a named exemption rather than a
 * silent omission. Every other file under `src/` must stay clean.
 */
const PATTERN = /fetch\(|analytics|cookie/i
// The lookup is the one network call (v0.9.44, a button on a single row); the page above says so in PRIVACY_NEVER.
const EXEMPT = ['src/app/legal-content.ts', 'src/platform/artist-lookup-itunes/lookup.ts']

function sourceFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : [],
    )
  return walk('src')
}

describe('the privacy page is true', () => {
  it('no source file outside the exemption uses fetch(/analytics/cookie', () => {
    const offenders = sourceFiles()
      .filter((rel) => !EXEMPT.includes(rel))
      .filter((rel) => PATTERN.test(read(rel)))
    expect(
      offenders,
      `${offenders.join(', ')} mentions fetch(/analytics/cookie, but Settings → Privacy & Terms ` +
        '(src/app/legal-content.ts) still says none of these apply. Either this is not what it looks ' +
        `like, or the privacy page needs updating in the same commit — see PRIVACY_NOT_APPLICABLE ` +
        'in src/app/legal-content.ts.',
    ).toEqual([])
  })

  it('the exempted file still exists and still names all three terms', () => {
    for (const rel of EXEMPT) {
      if (rel !== 'src/app/legal-content.ts') continue // the lookup file only needs the fetch( exemption
      const src = read(rel)
      for (const term of ['fetch', 'analytics', 'cookie']) {
        expect(
          src.toLowerCase().includes(term),
          `${rel} no longer mentions "${term}" — the exemption above assumes this file is the one ` +
            'place these words are discussed on purpose. If the privacy page changed shape, update ' +
            'this test’s expectations too.',
        ).toBe(true)
      }
    }
  })

  it('the page names the web search, and the lookup is the only file that talks to the network', () => {
    expect(read('src/app/legal-content.ts')).toContain('search the web')
    const withFetch = sourceFiles().filter((rel) => /fetch\(/.test(read(rel)) && !EXEMPT.includes(rel))
    expect(withFetch).toEqual([])
  })
})
