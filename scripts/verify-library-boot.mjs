/**
 * v0.2.6 browser verification. Run against `npm run dev` on :5173:
 *
 *   npm i -D playwright && node scripts/verify-library-boot.mjs
 *
 * Same reason as `verify-settings.mjs`: the decision logic has unit tests
 * (`tests/core/library-boot.test.ts`), but the three things this version
 * actually promises are not expressible there —
 *
 *   1. a return visit with a live permission scans with **no click at all**,
 *   2. a reverted permission costs **exactly one** click,
 *   3. the first-visit dialog opens **inside the OS music folder**,
 *
 * and each of those is about what the page does, not about what a function
 * returns. A directory handle cannot be constructed outside a picker, and
 * idb-keyval stores it by structured clone, so the two browser objects the
 * app depends on are replaced here: `showDirectoryPicker`, and an in-page
 * IndexedDB that keeps references instead of cloning them. Everything above
 * those two seams is the real application.
 *
 * Result on 2026-09-02, Chromium 1194: 30/30.
 */
import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/**
 * Replaces `indexedDB` with an in-memory store that keeps object references,
 * and `showDirectoryPicker` with a fake folder of three tracks plus one file
 * the scanner must refuse. `permission` decides what a saved handle reports on
 * load; `seed` decides whether one is there at all.
 */
function harness({ permission = 'granted', seed = true, entries, tags, mode = 'normal', unreadable = [] } = {}) {
  return `(() => {
  const FILES = ${JSON.stringify(entries ?? [
    'Artist A - One.mp3',
    'Artist B - Two.wav',
    'Artist C - Three.flac',
    'cover.jpg',
  ])};
  window.__picker = [];
  window.__requests = 0;
  window.__unhandled = [];
  addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason)));
  const MODE = ${JSON.stringify(mode)};

  /**
   * A real ID3v2.3 header in front of a stub payload. The library table reads
   * tags by byte range and never decodes, so this is enough to fill the
   * Artist / BPM / Key / Time columns for real — which is the only way to see
   * the seven-column layout with content in it.
   */
  const id3 = (tags) => {
    const frames = [];
    for (const [id, text] of Object.entries(tags)) {
      const body = new TextEncoder().encode('\u0000' + text);
      const head = new Uint8Array(10);
      head.set(new TextEncoder().encode(id), 0);
      new DataView(head.buffer).setUint32(4, body.length);
      frames.push(head, body);
    }
    const size = frames.reduce((n, f) => n + f.length, 0);
    const header = new Uint8Array(10);
    header.set(new TextEncoder().encode('ID3'), 0);
    header[3] = 3;
    // synchsafe: seven bits per byte
    header[6] = (size >> 21) & 0x7f; header[7] = (size >> 14) & 0x7f;
    header[8] = (size >> 7) & 0x7f; header[9] = size & 0x7f;
    return new Blob([header, ...frames, new Uint8Array(2048)]);
  };
  const TAGS = ${JSON.stringify(tags ?? {})};
  const UNREADABLE = new Set(${JSON.stringify(unreadable)});
  const makeFile = (name) => ({
    kind: 'file',
    name,
    getFile: async () => {
      if (UNREADABLE.has(name))
        throw new DOMException('file is gone', 'NotFoundError');
      return new File([TAGS[name] ? id3(TAGS[name]) : new Uint8Array(64)], name);
    },
  });
  const makeDir = (name, perm) => {
    let state = perm;
    return {
      kind: 'directory',
      name,
      queryPermission: async () => {
        if (MODE === 'queryThrows') throw new DOMException('gone', 'NotFoundError');
        return state;
      },
      requestPermission: async () => {
        window.__requests++;
        if (MODE === 'requestThrows')
          throw new DOMException('User activation is required', 'SecurityError');
        state = 'granted';
        return state;
      },
      entries: async function* () {
        if (MODE === 'notFound') throw new DOMException('folder gone', 'NotFoundError');
        for (const f of FILES) yield [f, makeFile(f)];
      },
    };
  };

  // both of these are read-only accessors on Window, so a plain assignment
  // silently does nothing — the shim has to be defined, not assigned
  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value: async (opts) => { window.__picker.push(opts); return makeDir('Tracks', 'granted'); },
  });

  // --- IndexedDB shim: idb-keyval only needs open/transaction/get/put ---
  const mem = new Map();
  ${
    seed === 'unusable'
      ? `mem.set('deckmix:libraryDir', { name: 'Tracks' });`
      : seed
        ? `mem.set('deckmix:libraryDir', makeDir('Tracks', ${JSON.stringify(permission)}));`
        : ''
  }
  const fire = (obj, prop, value) => setTimeout(() => { obj.result = value; obj[prop] && obj[prop](); }, 0);
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: {
    open() {
      const req = {};
      if (MODE === 'idbThrows') {
        setTimeout(() => {
          req.error = new DOMException('db dead', 'InvalidStateError');
          req.onerror && req.onerror();
        }, 0);
        return req;
      }
      setTimeout(() => {
        const db = {
          transaction: () => {
            const tx = {};
            tx.objectStore = () => ({
              transaction: tx,
              get: (k) => { const r = {}; fire(r, 'onsuccess', mem.get(k)); return r; },
              put: (v, k) => { mem.set(k, v); const r = {}; fire(r, 'onsuccess', undefined); return r; },
            });
            setTimeout(() => tx.oncomplete && tx.oncomplete(), 1);
            return tx;
          },
        };
        req.result = db;
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    },
  } });
})()`
}

async function scenario(browser, name, opts, check) {
  const page = await browser.newPage({ viewport: VIEWPORT })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(harness(opts))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await check(page, errors)
  await page.close()
}

// The container ships a pinned Chromium; PW_CHROME lets a machine with a
// different build point at its own without editing this file.
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || undefined,
})

// 1. return visit, permission still live — the real automatic load
await scenario(browser, 'granted', { permission: 'granted' }, async (page, errors) => {
  const rows = await page.locator('tbody tr').count()
  ok('granted: library loads with zero clicks', rows === 3, `${rows} rows`)
  const clicks = await page.evaluate(() => window.__requests)
  ok('granted: no permission prompt was raised', clicks === 0, `${clicks} requests`)
  const picks = await page.evaluate(() => window.__picker.length)
  ok('granted: the folder dialog never opened', picks === 0)
  const badge = await page.getByText(/skipped/).count()
  ok('granted: the unplayable file is still counted, not hidden', badge === 1)
  ok('granted: no page errors', errors.length === 0, errors[0])
})

// 2. "Allow this time" — the state that is `prompt`, not `denied`
await scenario(browser, 'prompt', { permission: 'prompt' }, async (page) => {
  await page.screenshot({ path: (process.env.SHOT_DIR || '.') + '/boot-needs-click.png' })
  const named = await page.getByText(/Tracks is ready/).count()
  ok('prompt: the panel names the folder and asks for one click', named === 1)
  const auto = await page.evaluate(() => window.__requests)
  ok('prompt: nothing asked for permission without a gesture', auto === 0)
  const rowsBefore = await page.locator('tbody tr').count()
  ok('prompt: nothing was scanned yet', rowsBefore === 0)
  const ctas = await page.getByRole('button', { name: /^Open Tracks$/ }).count()
  ok('prompt: the panel asks once, not three times', ctas === 1, `${ctas} buttons`)
  await page.getByRole('button', { name: /^Open Tracks$/ }).first().click()
  await page.waitForTimeout(900)
  const rows = await page.locator('tbody tr').count()
  ok('prompt: exactly one click loads the library', rows === 3, `${rows} rows`)
})

// 3. first visit — the dialog has to start in the OS music folder
await scenario(browser, 'new', { seed: false }, async (page) => {
  await page.screenshot({ path: (process.env.SHOT_DIR || '.') + '/boot-new.png' })
  const empty = await page.getByText(/No music loaded yet/).count()
  ok('new: a first visit says so instead of showing a blank list', empty === 1)
  await page.getByRole('button', { name: /Load my music folder/ }).first().click()
  await page.waitForTimeout(900)
  const opts = await page.evaluate(() => window.__picker[0])
  ok('new: the dialog opens inside the OS music folder', opts?.startIn === 'music', JSON.stringify(opts))
  const rows = await page.locator('tbody tr').count()
  ok('new: picking a folder loads it', rows === 3, `${rows} rows`)
})

// 4. an empty folder still has to say something
await scenario(
  browser,
  'renamed',
  { permission: 'granted', entries: [] },
  async (page) => {
    // an empty folder is the closest in-page analogue of "nothing to show":
    // the point is that it still explains itself rather than sitting blank
    const explained = await page.getByText(/No audio files found|no longer there/).count()
    ok('renamed/empty: an empty result still explains itself', explained >= 1)
  },
)

// 5. the startup sentence has to be ON SCREEN, not merely in the DOM. The owner
// reported an apparently blank panel in a smaller window: an empty state that
// centres itself inside a panel taller than the viewport puts its own text below
// the fold, which looks exactly like the silence this version removed.
for (const vp of [
  { width: 1536, height: 710 },
  { width: 1252, height: 759 },
  { width: 1280, height: 620 },
]) {
  const page = await browser.newPage({ viewport: vp })
  await page.addInitScript(harness({ permission: 'prompt' }))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const size = `${vp.width}x${vp.height}`
  const overflow = await page.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight + 1,
  )
  ok(`layout: no vertical overflow at ${size}`, !overflow)
  const seen = await page.evaluate(() => {
    const el = [...document.querySelectorAll('p')].find((p) => /one click to open/.test(p.textContent || ''))
    if (!el) return 'missing'
    const r = el.getBoundingClientRect()
    return r.top >= 0 && r.bottom <= window.innerHeight ? 'visible' : `offscreen(${Math.round(r.top)})`
  })
  ok(`layout: the startup sentence is visible at ${size}`, seen === 'visible', seen)
  await page.close()
}

// 5b. every way the browser can throw, and the sentence each one produces.
// Each of these shipped as a permanent "Looking for your library…" with an
// unhandled rejection and nothing on screen — the silent skip this version was
// written to remove, arriving through this version's own error paths.
const THROWS = [
  ['folder renamed mid-scan', { mode: 'notFound' }, /no longer there/, null],
  ['queryPermission throws on load', { mode: 'queryThrows' }, /no longer there/, null],
  ['IndexedDB will not open', { mode: 'idbThrows' }, /Could not read/, null],
  [
    'requestPermission loses its activation',
    { permission: 'prompt', mode: 'requestThrows' },
    /blocking access to Tracks/,
    /^Open Tracks$/,
  ],
]
for (const [label, opts, expected, clickFirst] of THROWS) {
  await scenario(browser, label, opts, async (page) => {
    if (clickFirst) {
      await page.getByRole('button', { name: clickFirst }).first().click()
      await page.waitForTimeout(900)
    }
    const said = await page.getByText(expected).count()
    ok(`throws: ${label} says what happened`, said >= 1)
    const unhandled = await page.evaluate(() => window.__unhandled)
    ok(`throws: ${label} leaves no unhandled rejection`, unhandled.length === 0,
      unhandled.join('; '))
    const out = await page.getByRole('button', { name: /Pick the folder again/i }).count()
    ok(`throws: ${label} offers a way out`, out >= 1)
  })
}

// 5c. imported from the parallel v0.2.6 branch: two facts that used to arrive
// looking like other facts.
await scenario(browser, 'unusable', { seed: 'unusable' }, async (page) => {
  const said = await page.getByText(/saved folder cannot be reopened/).count()
  ok('unusable: a stale saved record says so instead of claiming nothing is saved', said === 1)
  const asNew = await page.getByText(/No music loaded yet/).count()
  ok('unusable: it is not reported as a first visit', asNew === 0)
  const unhandled = await page.evaluate(() => window.__unhandled)
  ok('unusable: no unhandled rejection', unhandled.length === 0, unhandled.join('; '))
})

await scenario(
  browser,
  'unreadable',
  {
    permission: 'granted',
    entries: ['a.mp3', 'b.mp3', 'gone.mp3', 'also-gone.mp3'],
    unreadable: ['gone.mp3', 'also-gone.mp3'],
  },
  async (page) => {
    const badge = await page.getByText(/2 unreadable/).count()
    ok('unreadable: files that vanished are counted and named, not filed as untagged',
      badge === 1)
  },
)

// 6. the seven-column table with real tag content in it — open since v0.1.7,
// because the parser was measured against 360 files and the table never was
const NAMES = [
  'Astrix - Deep Jungle Walk.mp3',
  'Vini Vici - Great Spirit.mp3',
  'Ace Ventura - Presence.mp3',
  'Liquid Soul - Devotion.mp3',
  'Captain Hook - Wandering Man.mp3',
  'Symbolic - Sirius.mp3',
]
const TAGS = {
  [NAMES[0]]: { TPE1: 'Astrix', TIT2: 'Deep Jungle Walk', TALB: 'Artcore', TBPM: '138', TKEY: 'Am', TLEN: '447000' },
  [NAMES[1]]: { TPE1: 'Vini Vici', TIT2: 'Great Spirit', TALB: 'Free Tibet', TBPM: '140', TKEY: 'Fm', TLEN: '412000' },
  [NAMES[2]]: { TPE1: 'Ace Ventura', TIT2: 'Presence', TALB: 'Presence', TBPM: '136', TKEY: 'Gm', TLEN: '505000' },
  [NAMES[3]]: { TPE1: 'Liquid Soul', TIT2: 'Devotion', TALB: 'Revolution', TBPM: '142', TKEY: 'Dm', TLEN: '388000' },
  [NAMES[4]]: { TPE1: 'Captain Hook', TIT2: 'Wandering Man', TALB: 'Human Design', TBPM: '134', TKEY: 'Cm', TLEN: '533000' },
  [NAMES[5]]: { TPE1: 'Symbolic', TIT2: 'Sirius', TALB: 'Sirius', TBPM: '145', TKEY: 'Em', TLEN: '360000' },
}
await scenario(
  browser,
  'columns',
  { permission: 'granted', entries: [...NAMES, 'artwork.png'], tags: TAGS },
  async (page) => {
    await page.waitForTimeout(1200)
    const headers = await page.locator('thead th').allInnerTexts()
    // Grew from 7 to 10 across later versions (Genre v0.3.2, Type, Note,
    // Played/Load v0.8.x) without this check catching up.
    ok('columns: ten headers', headers.length === 10, headers.join(' | '))
    const cells = await page.locator('tbody tr').first().locator('td').allInnerTexts()
    // The old version of this check passed a string (always truthy) instead
    // of a real condition — it could never have failed. Real booleans now.
    const hasArtist = cells.includes('Ace Ventura')
    const hasBpm = cells.includes('136')
    const hasKey = cells.includes('Gm')
    const hasTime = cells.includes('8:25')
    ok(
      'columns: the first row carries artist, bpm, key and time',
      hasArtist && hasBpm && hasKey && hasTime,
      `artist=${hasArtist} bpm=${hasBpm} key=${hasKey} time=${hasTime}`,
    )
    const filled = await page.evaluate(() =>
      [...document.querySelectorAll('tbody tr')].filter((r) =>
        /1?[0-9]{2}\.?[0-9]?/.test(r.textContent || '')).length)
    ok('columns: every row got its tags', filled === 6, `${filled}/6`)
    // A percentage the layout quietly ignores is a number that lies, so
    // it's measured rather than trusted. Originally pinned to an exact 25%
    // for Title alone — stale twice over: Library.tsx's own comment on this
    // header row says Title shrank further to 20% in v0.8.0 to make room
    // for Note/Played/Load, and Artist (21%) was always meant to be right
    // alongside it, not behind it — "Title, Artist, BPM, Key and Load are
    // load-bearing and stay untouched" is that source comment's own words.
    // So this checks the relationship that's actually documented: Title and
    // Artist both beat every metadata column, not that Title beats Artist.
    const widths = await page.evaluate(() => {
      const table = document.querySelector('tbody')?.closest('table')
      const total = table?.getBoundingClientRect().width || 1
      return [...document.querySelectorAll('thead th')].map((th) =>
        Math.round((th.getBoundingClientRect().width / total) * 100),
      )
    })
    const [titleW, artistW, ...metadataW] = widths
    const widestMetadata = Math.max(...metadataW)
    ok(
      'columns: Title and Artist are the load-bearing columns, wider than every metadata column',
      titleW > widestMetadata && artistW > widestMetadata,
      `Title ${titleW}%, Artist ${artistW}%, widest metadata column ${widestMetadata}% — ${widths.join('% / ')}%`,
    )
    ok('columns: no column swallows the slack', Math.max(...widths.slice(2)) <= 12,
      `widest non-name column ${Math.max(...widths.slice(2))}%`)
    await page.screenshot({ path: (process.env.SHOT_DIR || '.') + '/library-columns.png' })
  },
)

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
