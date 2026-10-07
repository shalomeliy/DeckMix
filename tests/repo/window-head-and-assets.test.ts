import { existsSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { git, read, ROOT } from './repo.ts'

/**
 * v0.9.60. `src/assets/hero.png` and `src/assets/vite.svg` sat in the tree since the Vite starter, imported by
 * nothing, and the only reason anyone noticed was Shalom's 07/10 checklist asking to compress images: there was
 * nothing to compress, only leftovers. A file under `src/assets` that no file names is dead weight a reader has to
 * open to rule out, so it fails the gate instead of waiting for the next checklist.
 *
 * "Named" means its path from `assets/` on, closed by a quote or `)` — the way an import or a CSS `url()` writes
 * it. The bare file name is not enough: the review of this version showed a plain name search lets an unused
 * `logo.svg` live on through `app-logo.svg`, through a comment, or through a same-named file in another subfolder.
 * A path built at run time would still slip past; no code here does that today.
 */
export function unusedAssets(assets: string[], sources: string[]): string[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return assets.filter((rel) => {
    const named = new RegExp(`(?<![A-Za-z0-9_.-])assets/${esc(rel)}['"\`)]`)
    return !sources.some((text) => named.test(text))
  })
}

describe('src/assets holds only files something uses', () => {
  it('the matcher flags unused files and does not count look-alikes', () => {
    const sources = [
      "import logo from '@/assets/app-logo.svg'",
      '// play.svg is drawn by hand',
      "import icon from '@/assets/a/icon.svg'",
      ".x { background: url(./assets/bg.png) }",
    ]
    expect(unusedAssets(['logo.svg', 'icons/play.svg', 'a/icon.svg', 'b/icon.svg', 'bg.png', 'app-logo.svg'], sources))
      .toEqual(['logo.svg', 'icons/play.svg', 'b/icon.svg'])
  })

  it('every file under src/assets is named by a source file or index.html', () => {
    const dir = join(ROOT, 'src/assets')
    // The folder is empty after v0.9.60 and git does not keep empty folders: nothing there is nothing unused.
    if (!existsSync(dir)) return
    const assets = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    const sources = [...git('ls-files', 'src').split('\n'), 'index.html']
      .filter((rel) => rel && !rel.startsWith('src/assets/') && /\.(tsx?|css|html)$/.test(rel))
      .map((rel) => read(rel))
    const unused = unusedAssets(assets, sources)
    expect(unused, `${unused.join(', ')} under src/assets is imported by nothing — delete it or use it`).toEqual([])
  })
})

/**
 * Same version, the page head. The Search Console tag proved ownership of a public site to Google; DeckMix runs on
 * localhost, which Google never visits, and Shalom said on 07/10 there is no plan to publish it. If it ever is, the
 * v1.0 landing page gets a fresh tag. The dark colour is the app floor (`--color-surface-0` in `src/index.css`):
 * set in the head, before the stylesheet arrives, so the window does not open white for a moment.
 */
describe('index.html head', () => {
  const html = read('index.html')

  it('carries no Google site-verification tag', () => {
    expect(html).not.toMatch(/google-site-verification/i)
  })

  it('has a description and the dark theme colour', () => {
    expect(html).toMatch(/<meta name="description" content="[^"]{20,}"/)
    expect(html).toMatch(/<meta name="theme-color" content="#08090d"/)
  })

  it('paints the page dark before the stylesheet loads, in the same colour as the app floor', () => {
    expect(read('src/index.css')).toMatch(/--color-surface-0: #08090d;/)
    expect(html).toMatch(/<meta name="color-scheme" content="dark"/)
    expect(html).toMatch(/html\s*\{[^}]*background:\s*#08090d/)
  })
})
