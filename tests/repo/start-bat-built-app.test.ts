import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * v0.9.58: the owner's one double-click starts the built app, not the development server. Measured 07/10 with 16 of his songs analysing
 * while a deck played: 17 waveform frames over 50 ms in a minute on the development server, 1 on the built app. The port stays 5173 and
 * strict, because the library, tags and settings live per address.
 */
describe('scripts/start.bat runs the built app', () => {
  const bat = readFileSync('scripts/start.bat', 'utf8')
  // Commands only: a `rem` or `echo` line that mentions "vite build" must not decide the order checks below.
  const commands = bat.split(/\r?\n/).filter((l) => !/^\s*rem\b/i.test(l) && !/^\s*echo\b/i.test(l))
  const at = (re: RegExp) => commands.findIndex((l) => re.test(l))

  it('builds, then serves the build on 5173 with --strictPort', () => {
    expect(at(/vite build/)).toBeGreaterThanOrEqual(0)
    expect(at(/vite preview --port 5173 --strictPort/)).toBeGreaterThan(at(/vite build/))
  })

  it('does not start the development server', () => {
    expect(commands.some((l) => /npm run dev|npx vite(\s|$)(?!build|preview)/.test(l))).toBe(false)
  })

  it('a failed build stops with a message instead of serving an old build', () => {
    const build = at(/vite build/)
    const check = commands.findIndex((l, i) => i > build && /if errorlevel 1/i.test(l))
    const exit = commands.findIndex((l, i) => i > check && /exit \/b 1/i.test(l))
    expect(check).toBe(build + 1)
    expect(exit).toBeGreaterThan(check)
    expect(exit).toBeLessThan(at(/vite preview/))
  })
})
