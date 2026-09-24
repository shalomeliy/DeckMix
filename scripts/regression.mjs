/**
 * Full browser regression: every `scripts/verify-*.mjs`, one after another,
 * against the dev server on :5173, in one named browser.
 *
 *   npm run regression                 # Comet, if installed; else Playwright's Chromium
 *   PW_CHROME=<path to exe> npm run regression
 *   npm run regression -- deck-pin cues   # only scripts whose name contains one of these
 *
 * Why it exists (2026-09-24): 44 verify scripts had piled up, each run once by
 * the session that wrote it and never again. Eight of them could not run on
 * Windows at all — they hard-coded the Linux container's Chromium path, and
 * nothing noticed because nothing ran them. A check nobody runs is a check
 * that has quietly stopped existing.
 *
 * Sequential on purpose: the scripts share one dev server and each opens its
 * own pages; running them side by side made timings (waitForTimeout after a
 * load) the thing under test instead of the app.
 *
 * Not run here, by name — the project's rule is that a skip is named, never
 * silent. Each one is listed in the report with its reason.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const EXCLUDED = new Map([
  [
    'verify-mix-assist-transition-quality.mjs',
    'a measurement on the real library (needs C:\\Users\\Shalom\\Music\\Tracks and a freshly restarted dev server), not a pass/fail check',
  ],
])

const PER_SCRIPT_TIMEOUT_MS = 6 * 60 * 1000
const COMET = join(process.env.LOCALAPPDATA ?? '', 'Perplexity', 'Comet', 'Application', 'comet.exe')
const browserPath = process.env.PW_CHROME || (existsSync(COMET) ? COMET : '')
const browserName = browserPath ? browserPath.split(/[\\/]/).pop() : "Playwright's bundled Chromium"

try {
  const res = await fetch('http://localhost:5173/')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
} catch (err) {
  console.error(`Dev server on :5173 is not answering (${err.message}). Start it first (preview_start "deckmix-dev").`)
  process.exit(2)
}

const filters = process.argv.slice(2)
const all = readdirSync('scripts').filter((f) => /^verify-.*\.mjs$/.test(f)).sort()
const chosen = all.filter((f) => filters.length === 0 || filters.some((q) => f.includes(q)))

function run(file) {
  return new Promise((resolve) => {
    const started = Date.now()
    // Comet needs its first page absorbed per browser — see regression-warmup.mjs.
    const warmup = /comet/i.test(browserName) ? ['--import', './scripts/regression-warmup.mjs'] : []
    const child = spawn(process.execPath, [...warmup, join('scripts', file)], {
      env: { ...process.env, ...(browserPath ? { PW_CHROME: browserPath } : {}) },
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => {
      out += `\n[regression] killed after ${PER_SCRIPT_TIMEOUT_MS / 1000}s\n`
      child.kill()
    }, PER_SCRIPT_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      const lines = out.split(/\r?\n/)
      resolve({
        file,
        code,
        sec: Math.round((Date.now() - started) / 1000),
        pass: lines.filter((l) => l.startsWith('PASS')).length,
        fails: lines.filter((l) => l.startsWith('FAIL')),
        tail: lines.filter(Boolean).slice(-8),
      })
    })
  })
}

console.log(`Browser: ${browserName}\nScripts: ${chosen.length} (of ${all.length})\n`)
const results = []
for (const file of chosen) {
  if (EXCLUDED.has(file)) {
    console.log(`SKIP  ${file} — ${EXCLUDED.get(file)}`)
    results.push({ file, skipped: EXCLUDED.get(file) })
    continue
  }
  const r = await run(file)
  // A script that exits non-zero with zero FAIL lines crashed or timed out —
  // counted as a failure, never as "nothing failed".
  // Zero passing checks with exit 0 is not green either: a script that
  // printed nothing proved nothing (change-reviewer, 2026-09-24).
  const ok = r.code === 0 && r.fails.length === 0 && r.pass > 0
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${file}  (${r.pass} checks passed, ${r.fails.length} failed, exit ${r.code}, ${r.sec}s)`)
  if (!ok) for (const l of r.fails.length ? r.fails : r.tail) console.log(`        ${l}`)
  results.push({ ...r, ok })
}

const ran = results.filter((r) => !r.skipped)
const bad = ran.filter((r) => !r.ok)
const skipped = results.filter((r) => r.skipped)
console.log(
  `\n${ran.length - bad.length}/${ran.length} scripts green · ${ran.reduce((n, r) => n + r.pass, 0)} checks passed · ${skipped.length} skipped by name`,
)

mkdirSync('regression-out', { recursive: true })
writeFileSync(
  // A filtered run must not overwrite the last full-suite report.
  join('regression-out', filters.length ? 'report-filtered.json' : 'report.json'),
  JSON.stringify({ at: new Date().toISOString(), browser: browserName, results }, null, 2),
)
process.exit(bad.length ? 1 : 0)
