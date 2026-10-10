import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from './repo'

// v0.9.59: the one named exception to "never write to the user's existing files" is renaming a wrong extension, from one
// file's own button. A second place calling `.move(` on a file handle would be a second, unreviewed way to change his files.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
  })
}

describe('renaming an existing file happens in exactly one place', () => {
  const files = sources(join(ROOT, 'src'))
  it('only platform/source-fsaccess/misnamed.ts calls .move( on a handle', () => {
    const hits = files.filter((f) => /\.move\??\.?\(/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(ROOT.length))
    expect(hits).toHaveLength(1)
    expect(hits[0].split(String.fromCharCode(92)).join("/")).toMatch(/src\/platform\/source-fsaccess\/misnamed\.ts$/)
  })
  it('the dialog has no "fix all" path: one rename call, inside a per-row handler', () => {
    const src = readFileSync(join(ROOT, 'src/app/components/MisnamedDialog.tsx'), 'utf8')
    expect(src.match(/renameTrackExtension\(/g)?.length).toBe(1)
    expect(src.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/Rename all|Fix all|fixAll/i)
  })
  it('a rename re-checks the file and refuses an existing name before moving', () => {
    const src = readFileSync(join(ROOT, 'src/platform/source-fsaccess/misnamed.ts'), 'utf8')
    expect(src.indexOf('sniffFormat(file)')).toBeLessThan(src.indexOf('handle.move(newName)'))
    expect(src.indexOf('toLowerCase() === wanted')).toBeLessThan(src.indexOf('handle.move(newName)'))
  })
})
