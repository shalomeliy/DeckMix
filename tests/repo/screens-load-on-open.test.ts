import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * v0.9.61: Settings, Set history, Keys and Tagging are full-screen panels most sessions never open. They used to be static imports of
 * `App.tsx`, so every start downloaded and parsed them (built `App` chunk 541 KB → 463 KB when they moved out; library shown ~314 ms → ~216 ms
 * on the synthetic measurement of `scripts/measure-speed.mjs`). A static import slipping back in puts them in the first download again,
 * and nothing on screen would say so.
 */
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : /\.tsx?$/.test(n) ? [join(d, n)] : []))

describe('full-screen panels load only when opened', () => {
  const app = readFileSync('src/app/App.tsx', 'utf8')
  const panels = ['Settings', 'SetHistory', 'KeysScreen', 'TaggingScreen']

  it.each(panels)('%s is not a static import of App.tsx', (file) => {
    expect(app).not.toMatch(new RegExp(`^import[^\\n]*from '@/app/components/${file}'`, 'm'))
  })

  it.each(panels)('%s is imported with import()', (file) => {
    expect(app).toContain(`import('@/app/components/${file}')`)
  })

  it('the lazy panels sit inside a Suspense boundary', () => {
    expect(app).toMatch(/<Suspense[^>]*>[\s\S]*<SettingsScreen[\s\S]*<TaggingScreen[\s\S]*<\/Suspense>/)
  })

  it.each(panels)('no file in src/ statically imports %s (a second importer would pull it back into the first download)', (file) => {
    const re = new RegExp(`^import[^\\n]*from '@/app/components/${file}'`, 'm')
    expect(walk('src').filter((f) => re.test(readFileSync(f, 'utf8')))).toEqual([])
  })

  it('a failed panel download is caught and shown, not left to unmount the app', () => {
    expect(app).toMatch(/<PanelLoadBoundary[\s\S]*<Suspense/)
    expect(readFileSync('src/app/components/PanelLoadBoundary.tsx', 'utf8')).toContain('getDerivedStateFromError')
  })
})
