/**
 * v0.4.6 step 8 — phase-alignment measurement on the real library.
 *
 * Run against `npm run dev` on :5173, on a machine that actually has the
 * library (this cannot run in a sandboxed/remote session — see HANDOFF.md):
 *
 *   node scripts/verify-mix-assist-transition-quality.mjs "C:\Users\Shalom\Music\Tracks" 20
 *
 * (both args optional — default library dir is the Windows path above,
 * default pair count is 20)
 *
 * v0.4.10 closure (06/09): an N=8 run on this library swung from "worse than
 * before" to "much better than before" on a second N=8 run of different
 * random pairs — random pairing (see `pickPairs`) plus a handful of hard
 * (slow-onset) tracks is enough noise at N=8 to flip the verdict outright.
 * N=20 gave a stable, reproducible result across repeats. Don't trust an
 * N=8 run's summary numbers for a before/after call — rerun at 20+ first.
 *
 * **Restart the dev server right before running this** (stop it, `npm run
 * dev` again). Confirmed the hard way: against a dev server that had been
 * running for a while (many page loads' worth of Vite's own module-cache
 * history), this script's `import('/src/app/state/store.ts')` resolved to a
 * *different* store instance than the one the actual rendered page was
 * using — the DOM showed a fully scanned, working library while this
 * script's own `useStore.getState()` read an empty one stuck on
 * `boot: 'checking'` forever. A fresh dev server does not have that stale
 * cache yet, and the same script run against one worked immediately.
 *
 * What this measures, and why it can't be a unit test: `core/beatgrid.ts`
 * and `core/transition.ts` are pure and already have unit tests (synthetic
 * envelopes, boundary values) — what those *cannot* tell us is whether
 * `estimateBeatGrid`'s autocorrelation actually locks a clean grid on real,
 * messy audio, and whether the live seek-then-sync (`startAutoTransition` in
 * controls.ts) holds that lock once real playback timing (rAF scheduling,
 * audio buffer boundaries) is in the loop. Steps 6/7/9 verified *behaviour*
 * with synthetic sine-wave WAVs; this is the same live engine, driven the
 * same way, against real tracks — because that's the only thing that can
 * expose "detection is confident but wrong on this kind of file" or "the
 * live loop doesn't converge as fast on real material as the synthetic
 * check suggested".
 *
 * For each of N real track pairs: load real track A onto deck A and play it
 * (same `KeyQ` path a user takes), drag-drop real track B onto deck B
 * (paused — same drop path `Library.tsx` rows already support), wait for
 * both decks' background analysis to produce a `beatGrid` (or record the
 * pair as skipped, never silently dropped — this file's own central rule),
 * then call the *real*, already-shipped `startAutoTransition('A','B', 0)`
 * from inside the page — reached via `import('/src/controls.ts')` against
 * the Vite dev server, which resolves to the exact same live module
 * instance the running app already uses (browsers dedupe ES modules by
 * resolved URL), so this is not a reimplementation of the transition, it is
 * the transition. `core/beatgrid.ts`'s own `phaseDeltaSec` (imported the
 * same way) measures how far deck B's live position sits from deck A's beat
 * phase — once right after the seek (`atJoin`), and again 3s later after a
 * few `SYNC_LOOP_INTERVAL_SEC` corrections (`after3s`) — against
 * `core/scratch.ts`'s real `POSITION_EPSILON_SEC`, not a value copied here
 * that could drift from it.
 *
 * Same fake-`showDirectoryPicker`/fake-`indexedDB` harness as the other
 * verify-*.mjs scripts, but backed by real file bytes read from disk instead
 * of synthetic WAVs — each pair gets its own page/folder so a slow or
 * unanalyzable file can't stall the rest of the run.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const URL = 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const DEFAULT_DIR = String.raw`C:\Users\Shalom\Music\Tracks`
const LIBRARY_DIR = process.argv[2] || DEFAULT_DIR
const PAIR_COUNT = Number(process.argv[3] || 20)
/** Keeps the inlined-base64 init script fast; real WAVs are the outlier, mp3/m4a dominate the library (v0.1.7). */
const MAX_FILE_BYTES = 15 * 1024 * 1024
// Real tracks are full-length (3-6 minutes of PCM to run the onset envelope
// over), not the 20s synthetic clips this was first smoke-tested against —
// 20s was enough for those and not for a real library (first real run: 8/8
// pairs timed out). 90s per side, checked well before that on real material.
const ANALYSIS_TIMEOUT_MS = 90_000
const AFTER_DELAY_MS = 3_000

const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'm4a', 'm4b', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'weba', 'webm', 'aiff', 'aif'])

function walk(dir) {
  const out = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    console.error(`Can't read ${dir}: ${err.message}`)
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...walk(full))
    } else {
      const ext = e.name.split('.').pop()?.toLowerCase() ?? ''
      if (!AUDIO_EXT.has(ext)) continue
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        continue
      }
      if (size > 0 && size <= MAX_FILE_BYTES) out.push({ full, base: e.name, folder: path.dirname(full) })
    }
  }
  return out
}

/**
 * Same 8%-with-half/double-time tolerance `mixRecommendations` itself uses
 * (`core/recommend.ts`: `bestErr > 0.08` is excluded) — a random pair the
 * real Mix Assist panel would never have offered is not a measurement of
 * the feature, it's a measurement of a scenario the feature actively
 * prevents. Reimplemented rather than imported: that function wants
 * `DeckMixState`/`Track` shapes for a live deck, key-match scoring, and a
 * "best of several playing decks" search this only ever needs pairwise.
 */
function bpmCompatible(bpmA, bpmB) {
  for (const mult of [0.5, 1, 2]) {
    if (Math.abs(bpmB * mult - bpmA) / bpmA <= 0.08) return true
  }
  return false
}

function pickPairs(files, count, bpmById) {
  const withBpm = files.filter((f) => bpmById.get(f.base) != null)
  const byFolder = new Map()
  for (const f of withBpm) {
    if (!byFolder.has(f.folder)) byFolder.set(f.folder, [])
    byFolder.get(f.folder).push(f)
  }
  const pairs = []
  const usedBase = new Set()
  const compatible = (a, b) => bpmCompatible(bpmById.get(a.base), bpmById.get(b.base))
  const tryPairsIn = (list) => {
    const shuffled = shuffle(list)
    for (let i = 0; i < shuffled.length && pairs.length < count; i++) {
      const a = shuffled[i]
      if (usedBase.has(a.base)) continue
      // f.base !== a.base, not just f !== a: the cross-folder fallback pool
      // spans every folder, and two different files in different folders can
      // share a filename (a track filed under two genres). harness() keys its
      // fake directory by basename alone, so a same-basename "pair" collapses
      // into one file served to both decks — a silent A-vs-itself transition
      // with a trivially perfect phase match, folded into the reported
      // numbers with no skip and no error to notice it by.
      const b = shuffled.find((f) => f.base !== a.base && !usedBase.has(f.base) && compatible(a, f))
      if (!b) continue
      usedBase.add(a.base)
      usedBase.add(b.base)
      pairs.push([a, b])
    }
  }
  // Prefer same-folder pairs (genre-consistent, closer to how Mix Assist is
  // actually used) before falling back to cross-folder ones — but a pair is
  // only ever formed when the tagged BPMs are actually compatible.
  const folders = [...byFolder.values()].filter((list) => list.length >= 2)
  for (const list of shuffle(folders)) {
    if (pairs.length >= count) break
    tryPairsIn(list)
  }
  if (pairs.length < count) {
    tryPairsIn(shuffle(withBpm.filter((f) => !usedBase.has(f.base))))
  }
  return pairs
}

function shuffle(arr) {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function harness(fileA, fileB) {
  const files = {
    [fileA.base]: fs.readFileSync(fileA.full).toString('base64'),
    [fileB.base]: fs.readFileSync(fileB.full).toString('base64'),
  }
  return `(() => {
  window.__unhandled = [];
  window.__initScriptError = null;
  addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason)));
  // Object.defineProperty throws outright on a property the real browser
  // already defines as non-configurable (a real Chromium — unlike whatever
  // this was first written and smoke-tested against — may genuinely define
  // showDirectoryPicker that way). An uncaught throw here aborts the rest of
  // this whole init script, silently skipping the indexedDB mock below it —
  // library.boot stuck on 'checking' forever looks exactly like that, with
  // no error anywhere a normal run would think to look. Plain assignment
  // only needs the property to be writable, not configurable, so it's the
  // fallback; the error is recorded either way instead of swallowed.
  const define = (name, value) => {
    try {
      Object.defineProperty(window, name, { configurable: true, value });
    } catch (err) {
      try { window[name] = value } catch (err2) {
        window.__initScriptError = name + ': defineProperty failed (' + err.message + '), assignment failed (' + err2.message + ')';
      }
    }
  };
  try {
  const files = ${JSON.stringify(files)};
  const makeFile = (name) => ({
    kind: 'file', name,
    getFile: async () => {
      // A plain for-loop, not Uint8Array.from(atob(...), cb) — the latter's
      // per-element callback made real multi-MB files visibly slower to
      // stage than this cost justifies.
      const binary = atob(files[name]);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new File([bytes], name);
    },
  });
  const makeDir = (name) => ({
    kind: 'directory', name,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () { for (const n of Object.keys(files)) yield [n, makeFile(n)]; },
  });
  const mem = new Map();
  mem.set('deckmix:libraryDir', makeDir('Tracks'));
  const fire = (obj, prop, value) => setTimeout(() => { obj.result = value; obj[prop] && obj[prop](); }, 0);
  // indexedDB first: it's the one restoreLibraryFolder actually depends on,
  // so if only one override can land, it should be this one.
  define('indexedDB', {
    open() {
      const req = {};
      setTimeout(() => {
        const db = { transaction: () => {
          const tx = {};
          tx.objectStore = () => ({
            transaction: tx,
            get: (k) => { const r = {}; fire(r, 'onsuccess', mem.get(k)); return r; },
            put: (v, k) => { mem.set(k, v); const r = {}; fire(r, 'onsuccess', undefined); return r; },
          });
          setTimeout(() => tx.oncomplete && tx.oncomplete(), 1);
          return tx;
        } };
        req.result = db;
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    },
  });
  define('showDirectoryPicker', async () => makeDir('Tracks'));
  } catch (err) {
    window.__initScriptError = 'harness setup threw: ' + err.message;
  }
})()`
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined })

async function measurePair(fileA, fileB) {
  const page = await browser.newPage({ viewport: VIEWPORT })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.addInitScript(harness(fileA, fileB))
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)

    // Not driven through the DOM (dblclick a row / drag a row onto a deck)
    // any more: `Library.tsx` shows `track.title ?? track.name` (line ~828),
    // and a real tagged file's ID3 title is almost never the filename — the
    // very first real-library run above timed out on every single pair
    // because it went looking for filename text that was never on screen.
    // `loadTrackToDeck`/`togglePlay` (`controls.ts`) are the same functions
    // that DOM path ultimately calls anyway, reached the same way
    // `startAutoTransition` already is below — a direct dynamic import
    // against the Vite dev server resolves to the exact same live module
    // instance the running app uses. Matching tracks by `id` (the scan's
    // `prefix+filename`, per `library.ts`) instead of by displayed text
    // sidesteps the whole "what does this row actually say" problem.
    const result = await page.evaluate(
      async ({ idA, idB, scanTimeoutMs, timeoutMs, afterDelayMs }) => {
        const { useStore } = await import('/src/app/state/store.ts')
        const ctl = await import('/src/controls.ts')

        const scanDeadline = Date.now() + scanTimeoutMs
        let trackA, trackB
        while (Date.now() < scanDeadline) {
          const { tracks } = useStore.getState().library
          trackA = tracks.find((t) => t.id === idA)
          trackB = tracks.find((t) => t.id === idB)
          if (trackA && trackB) break
          await new Promise((r) => setTimeout(r, 200))
        }
        if (!trackA || !trackB) {
          // Don't just say "not found" — say what *was* found. `library.boot`/
          // `bootDetail` (Library.tsx's reportFailure) carry the real error
          // when restoreLibraryFolder()/scanLibrary() throws — an empty
          // library with `boot` still 'checking' or 'restoring' means it
          // never got that far at all (hung, not failed).
          const lib = useStore.getState().library
          const sample = lib.tracks.slice(0, 5).map((t) => t.id)
          // Does the rendered page actually show the stuck state too, or is
          // this useStore read landing on a disconnected copy of the module
          // (Vite serving a different instance than the one main.tsx booted)
          // while the real page moved on? "Looking for your library…" is the
          // exact copy Library.tsx shows for boot === 'checking'
          // (core/library-boot.ts's bootCopy).
          const domText = document.body.innerText || ''
          const domMatchesBoot = domText.includes('Looking for your library') || domText.includes('No music loaded yet') || domText.includes("didn't load")
          // App.tsx renders Deck A, Mixer, Deck B, Library as siblings in
          // that order — Library is last, so a short slice from the start
          // (Deck A/Mixer alone run well past 200 chars) never reaches it.
          // Find it by content instead of by a fixed offset that assumes a
          // page layout this script doesn't otherwise know.
          const libIdx = domText.toLowerCase().indexOf('librar')
          const domSnippet = libIdx >= 0 ? domText.slice(Math.max(0, libIdx - 50), libIdx + 400) : domText.slice(-600)
          return {
            skipped: true,
            reason:
              `library scan never listed ${!trackA ? idA : ''} ${!trackB ? idB : ''}`.trim() +
              ` (${lib.tracks.length} track(s) found; boot=${lib.boot}${lib.bootDetail ? ` (${lib.bootDetail})` : ''}; first ids: ${JSON.stringify(sample)}; initScriptError: ${window.__initScriptError ?? 'none'}; unhandled: ${JSON.stringify(window.__unhandled ?? [])}; domMatchesBoot=${domMatchesBoot}; domTextLength=${domText.length}; domSnippet(near ${libIdx >= 0 ? "'librar'" : 'end, none found'}): ${JSON.stringify(domSnippet)})`,
          }
        }

        await ctl.loadTrackToDeck('A', trackA)
        await ctl.loadTrackToDeck('B', trackB)

        // A decode failure (controls.ts's loadTrackToDeck) is caught, logged,
        // and surfaced as a visible notice — it never gets to set `track` at
        // all. Report that real notice text rather than a generic failure.
        const afterLoad = useStore.getState().decks
        if (!afterLoad.A.track || !afterLoad.B.track) {
          const which = !afterLoad.A.track && !afterLoad.B.track ? 'A and B' : !afterLoad.A.track ? 'A' : 'B'
          return { skipped: true, reason: `deck ${which} never got a track loaded — notice: ${useStore.getState().notice?.text ?? '(none)'}` }
        }

        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const { decks } = useStore.getState()
          if (decks.A.beatGrid && decks.B.beatGrid) break
          await new Promise((r) => setTimeout(r, 300))
        }
        const before = useStore.getState().decks
        if (!before.A.beatGrid || !before.B.beatGrid) {
          // Never a bare "no beat grid" — that could mean "still analyzing,
          // just needs more time", "analysis errored" (with a real message),
          // or "analysed fine but found no periodicity at all", and those
          // call for three different fixes.
          const describe = (id) => {
            const d = before[id]
            if (d.beatGrid) return `${id}: ok`
            const state = d.track?.analysisState ?? '(unknown)'
            const err = d.track?.analysisError ? ` — ${d.track.analysisError}` : ''
            return `${id}: analysisState=${state}${err}`
          }
          return { skipped: true, reason: `${describe('A')} | ${describe('B')}` }
        }
        const gridAConfirmed = before.A.beatGridConfirmed
        const gridBConfirmed = before.B.beatGridConfirmed

        const { engine } = await import('/src/platform/audio-webaudio/engine.ts')
        const { phaseDeltaSec } = await import('/src/core/beatgrid.ts')
        const { POSITION_EPSILON_SEC } = await import('/src/core/scratch.ts')

        ctl.togglePlay('A')
        // Give the engine a moment to actually start before reading its
        // position or handing it to startAutoTransition (which refuses
        // outright if `from.playing` hasn't flipped yet).
        await new Promise((r) => setTimeout(r, 300))
        if (!useStore.getState().decks.A.playing) {
          return { skipped: true, reason: 'deck A did not start playing after togglePlay' }
        }

        ctl.startAutoTransition('A', 'B', 0)
        // startAutoTransition itself is synchronous — read positions on the
        // very next turn, before the rAF-driven crossfade loop has run at all.
        await new Promise((r) => setTimeout(r, 0))
        const gridA = useStore.getState().decks.A.beatGrid
        const gridB = useStore.getState().decks.B.beatGrid
        const atJoinSec = phaseDeltaSec(engine.decks.B.position, gridB, engine.decks.A.position, gridA)

        await new Promise((r) => setTimeout(r, afterDelayMs))
        const after3sSec = phaseDeltaSec(engine.decks.B.position, gridB, engine.decks.A.position, gridA)

        ctl.cancelTransition()

        return {
          skipped: false,
          atJoinMs: atJoinSec * 1000,
          after3sMs: after3sSec * 1000,
          epsilonMs: POSITION_EPSILON_SEC * 1000,
          gridAConfirmed,
          gridBConfirmed,
        }
      },
      { idA: fileA.base, idB: fileB.base, scanTimeoutMs: 30_000, timeoutMs: ANALYSIS_TIMEOUT_MS, afterDelayMs: AFTER_DELAY_MS },
    )

    return { fileA: fileA.base, fileB: fileB.base, consoleErrors: errors, ...result }
  } catch (err) {
    return { fileA: fileA.base, fileB: fileB.base, skipped: true, reason: `script error: ${err.message}`, consoleErrors: errors }
  } finally {
    await page.close()
  }
}

/**
 * Real BPM tags for candidate selection — `readTags` (source-fsaccess/tags.ts)
 * is the exact reader the app's own library scan uses, reached via a dynamic
 * import against the dev server (same technique as `measurePair`'s
 * `controls.ts`/`store.ts`). Bytes are served lazily through `exposeFunction`
 * rather than inlined into one giant init script — `harness()`'s two-files-
 * at-a-time inlining is fine for a single pair, not for however many
 * candidates end up needing a BPM check here.
 */
async function readBpmTags(files) {
  const page = await browser.newPage({ viewport: VIEWPORT })
  try {
    const byName = new Map(files.map((f) => [f.base, f.full]))
    await page.exposeFunction('__readFileBase64', (name) => fs.readFileSync(byName.get(name)).toString('base64'))
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(300)
    return await page.evaluate(async (names) => {
      const { readTags } = await import('/src/platform/source-fsaccess/tags.ts')
      const out = {}
      for (const name of names) {
        try {
          const b64 = await window.__readFileBase64(name)
          const binary = atob(b64)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
          const tags = await readTags(new File([bytes], name))
          out[name] = { bpm: tags.bpm ?? null, camelot: tags.camelot ?? null }
        } catch (err) {
          out[name] = { bpm: null, camelot: null, error: String(err?.message ?? err) }
        }
      }
      return out
    }, files.map((f) => f.base))
  } finally {
    await page.close()
  }
}

console.log(`Library: ${LIBRARY_DIR}`)
const files = walk(LIBRARY_DIR)
console.log(`${files.length} playable files found (<= ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)}MB each)`)
if (files.length < 2) {
  console.error('Not enough files to form a pair — check the library path.')
  await browser.close()
  process.exit(2)
}

// Reading tags for the whole library up front (fast — no decode, byte-range
// reads only, same as the app's own scan) is what lets pairing check real
// BPM compatibility instead of guessing from folder alone.
const TAG_READ_CAP = 300
const tagCandidates = files.length > TAG_READ_CAP ? shuffle(files).slice(0, TAG_READ_CAP) : files
console.log(`Reading BPM tags for ${tagCandidates.length} candidate(s)...`)
const tagResults = await readBpmTags(tagCandidates)
const bpmById = new Map()
let noBpm = 0
for (const f of tagCandidates) {
  const t = tagResults[f.base]
  if (t?.bpm != null) bpmById.set(f.base, t.bpm)
  else noBpm++
}
console.log(`${bpmById.size} tagged with a BPM, ${noBpm} without (excluded from pairing, not silently — this is that count)`)

const pairs = pickPairs(files, PAIR_COUNT, bpmById)
if (pairs.length < PAIR_COUNT) {
  console.log(`Only found ${pairs.length}/${PAIR_COUNT} BPM-compatible pairs (real Mix Assist tolerance: ±8%, half/double-time included) — not padding with incompatible ones.`)
}
console.log(`Measuring ${pairs.length} pair(s)...\n`)

const results = []
for (const [a, b] of pairs) {
  console.log(`  ${a.base}  <->  ${b.base}`)
  const r = await measurePair(a, b)
  results.push(r)
  if (r.skipped) {
    console.log(`    SKIPPED — ${r.reason}`)
  } else {
    console.log(
      `    at join: ${r.atJoinMs.toFixed(2)}ms   after 3s: ${r.after3sMs.toFixed(2)}ms   epsilon: ${r.epsilonMs}ms` +
        (r.gridAConfirmed && r.gridBConfirmed ? '' : `   (grid unconfirmed: ${!r.gridAConfirmed ? a.base : ''} ${!r.gridBConfirmed ? b.base : ''})`.trimEnd()),
    )
  }
  if (r.consoleErrors?.length) console.log(`    console errors: ${r.consoleErrors.join(' | ')}`)
}

await browser.close()

const measured = results.filter((r) => !r.skipped)
const skipped = results.filter((r) => r.skipped)

console.log('\n=== summary ===')
console.log(`${measured.length}/${results.length} pairs measured, ${skipped.length} skipped`)
if (skipped.length) {
  console.log('skipped:')
  for (const r of skipped) console.log(`  - ${r.fileA} / ${r.fileB}: ${r.reason}`)
}
if (measured.length) {
  const epsilonMs = measured[0].epsilonMs
  const avg = (key) => measured.reduce((sum, r) => sum + Math.abs(r[key]), 0) / measured.length
  const maxAbs = (key) => Math.max(...measured.map((r) => Math.abs(r[key])))
  const withinPct = (key) => (100 * measured.filter((r) => Math.abs(r[key]) <= epsilonMs).length) / measured.length
  console.log(`\nat join   — mean |error| ${avg('atJoinMs').toFixed(2)}ms, max ${maxAbs('atJoinMs').toFixed(2)}ms, within ${epsilonMs}ms epsilon: ${withinPct('atJoinMs').toFixed(0)}%`)
  console.log(`after 3s  — mean |error| ${avg('after3sMs').toFixed(2)}ms, max ${maxAbs('after3sMs').toFixed(2)}ms, within ${epsilonMs}ms epsilon: ${withinPct('after3sMs').toFixed(0)}%`)
  const unconfirmed = measured.filter((r) => !r.gridAConfirmed || !r.gridBConfirmed).length
  if (unconfirmed) console.log(`${unconfirmed}/${measured.length} pair(s) had an unconfirmed beat grid on at least one side — their numbers are included above, not hidden.`)
}

process.exit(0)
