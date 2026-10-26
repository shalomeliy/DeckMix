import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT, read } from './repo.ts'

/**
 * v0.3.1. The client had no version display at all — `package.json`'s number
 * was known to the docs (`version-in-step.test.ts`) and to nobody looking at
 * the running app. Reading the number off `import.meta.env` or a fetch would
 * have worked too, but a `define` is the one path that cannot silently drift
 * from `package.json`: it is substituted at build time from the same file this
 * test reads.
 */
const pkg = JSON.parse(read('package.json')) as { version: string }

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** Every source file under `src/`, walked rather than listed for the same
 * reason `settings-layer3.test.ts` walks its surface: a file added later and
 * never registered here would be exactly the unchecked hiding place this
 * exists to catch. */
function sourceFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : [],
    )
  return walk('src')
}

describe('the client shows the version package.json declares', () => {
  it('vite.config.ts defines __APP_VERSION__ from package.json, not a literal', () => {
    const src = read('vite.config.ts')
    expect(
      src.includes('__APP_VERSION__'),
      'vite.config.ts no longer defines __APP_VERSION__ — the client has nothing to read its version from.',
    ).toBe(true)
    const literal = new RegExp(
      `__APP_VERSION__[\\s\\S]{0,80}['"\`]${pkg.version.replace(/\./g, '\\.')}['"\`]`,
    )
    expect(
      literal.test(src),
      `vite.config.ts hard-codes "${pkg.version}" next to __APP_VERSION__ instead of reading it from ` +
        'package.json — that is the second copy of the number this check exists to catch.',
    ).toBe(false)
  })

  it('Settings.tsx renders __APP_VERSION__, not a version literal', () => {
    const settings = read('src/app/components/Settings.tsx')
    expect(
      settings.includes('__APP_VERSION__'),
      'src/app/components/Settings.tsx no longer displays __APP_VERSION__ — the version disappeared from the UI.',
    ).toBe(true)
  })

  it('the top bar shows the version and the commit it was built from (26/10: he could not tell if his copy was updated)', () => {
    const top = read('src/app/components/TopBar.tsx')
    expect(top.includes('__APP_VERSION__') && top.includes('__APP_BUILD__')).toBe(true)
    expect(read('vite.config.ts')).toContain('__APP_BUILD__')
  })

  it('no source file under src/ hard-codes the current version as a string literal', () => {
    const semver = new RegExp(`['"\`]v?${pkg.version.replace(/\./g, '\\.')}['"\`]`)
    const offenders = sourceFiles().filter((rel) => semver.test(stripComments(read(rel))))
    expect(
      offenders,
      `${offenders.join(', ')} spells out "${pkg.version}" as a string literal. The client must read ` +
        'this number only through __APP_VERSION__ (vite.config.ts → package.json) — a second hard-coded ' +
        'copy is exactly what drifts the next time the version bumps.',
    ).toEqual([])
  })
})
