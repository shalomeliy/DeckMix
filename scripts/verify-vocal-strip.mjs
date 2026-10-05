/**
 * v0.9.10b: the vocal strip under each deck's overview, at the owner's real viewport (1536 x 710).
 *   node scripts/verify-vocal-strip.mjs   (against npm run dev; DECKMIX_URL overrides :5173; PW_CHROME = a Chromium binary)
 *
 * What it proves, with numbers: the page still fits 710 px with the strip + timers (+ the marking row when the setting is on), with a track on
 * BOTH decks; the lane sits exactly under the overview and as wide as it; clicking the overview still seeks while clicking the lane does not;
 * the countdown line appears and changes with the position; marking by hand round-trips (start/end -> a mark drawn, undo -> back); nothing
 * throws. It builds a small stereo House library in the browser's own file store (OPFS), so no real music is touched. The strip's CONTENT
 * (is the voice where the voice is) is not judged here — synthetic audio cannot say that; the owner's marked songs do.
 */
import { chromium } from 'playwright'

const URL = process.env.DECKMIX_URL || 'http://localhost:5173/'
const VIEWPORT = { width: 1536, height: Number(process.env.VIEWPORT_H) || 710 }
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined, args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: VIEWPORT })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.addInitScript(() => {
  window.mod = (p) => {
    const hit = performance.getEntriesByType('resource').map((e) => new URL(e.name)).find((u) => u.pathname === p)
    return import(hit ? hit.pathname + hit.search : p)
  }
})
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)

// A stereo House library of three 45 s songs: a kick every beat, and from 12 s a voice-like tone, so the strip has something to draw.
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory()
  const lib = await root.getDirectoryHandle('Tracks', { create: true })
  const house = await lib.getDirectoryHandle('House', { create: true })
  const sr = 22050, dur = 45, n = sr * dur
  for (let s = 0; s < 3; s++) {
    const pcm = new Int16Array(n * 2), bpm = 124 + s
    for (let i = 0; i < n; i++) {
      const t = i / sr, beat = ((t * bpm) / 60) % 1
      const kick = Math.exp(-beat * 18) * Math.sin(2 * Math.PI * 55 * t) * 0.8
      const voice = t > 12 ? 0.2 * Math.sin(2 * Math.PI * (220 + 40 * s) * t) * (0.5 + 0.5 * Math.sin(t * 3)) : 0
      pcm[2 * i] = Math.max(-1, Math.min(1, kick + voice)) * 32767
      pcm[2 * i + 1] = Math.max(-1, Math.min(1, kick + voice * 0.6 * Math.sin(t * 0.7 + 1))) * 32767
    }
    const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf)
    const w = (o, str) => [...str].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)))
    w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true)
    dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true)
    dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, pcm.length * 2, true)
    new Int16Array(buf, 44).set(pcm)
    const ws = await (await house.getFileHandle(`Verify House ${s + 1}.wav`, { create: true })).createWritable()
    await ws.write(buf); await ws.close()
  }
  window.showDirectoryPicker = async () => lib
})
await page.getByRole('button', { name: /LOAD MY MUSIC FOLDER/i }).first().click()
await page.waitForTimeout(9000)

const fits = () => page.evaluate(() => ({ scroll: document.documentElement.scrollHeight, inner: window.innerHeight }))
const read = (id) => page.evaluate(async (deck) => (await window.mod('/src/app/state/store.ts')).useStore.getState().decks[deck].positionSec, id)
const rect = (sel) => page.locator(sel).first().boundingBox()


// `scrollHeight == innerHeight` alone proves little (the page may clip its own overflow), so the parts that give way first are measured directly:
// the scrolling waveform keeps its 96 px floor and ends inside the viewport, and a library row is on screen.
const clipChecks = async (label) => {
  const wf = await rect('canvas.cursor-crosshair')
  ok(`${label}: the scrolling waveform keeps its 96 px floor and ends inside the viewport`, !!wf && wf.height >= 95 && wf.y + wf.height <= VIEWPORT.height, wf ? `h ${wf.height.toFixed(0)}, bottom ${(wf.y + wf.height).toFixed(0)}` : 'not found')
  const rowBox = await rect('text=Verify House 1')
  ok(`${label}: a library row is visible on screen`, !!rowBox && rowBox.y + rowBox.height <= VIEWPORT.height, rowBox ? `row bottom ${(rowBox.y + rowBox.height).toFixed(0)}` : 'not found')
}
let f = await fits()
ok('page fits 710 px with the library loaded, before any deck', f.scroll <= f.inner, `scrollHeight ${f.scroll} / ${f.inner}`)

// A track on each deck (the row buttons labelled A and B; the last one of each is a library row's).
for (const d of ['A', 'B']) {
  await page.locator(`button:text-is("${d}")`).last().click({ force: true })
  await page.waitForTimeout(3500)
}
f = await fits()
ok('page fits 710 px with a track on BOTH decks (strip + timers shown)', f.scroll <= f.inner, `scrollHeight ${f.scroll} / ${f.inner}`)

await clipChecks('both decks loaded')
const laneOk = {}
for (const d of ['A', 'B']) {
  const lane = await rect(`[data-vocal-strip="${d}"] [role="img"]`)
  const ov = await rect(`[data-overview="${d}"]`)
  laneOk[d] = !!(lane && ov)
  ok(`deck ${d}: the strip lane exists`, !!lane)
  if (!lane || !ov) continue
  ok(`deck ${d}: lane is as wide as the overview and starts at its left edge`, Math.abs(lane.x - ov.x) <= 1.5 && Math.abs(lane.width - ov.width) <= 1.5, `lane x ${lane.x.toFixed(1)} w ${lane.width.toFixed(1)} / overview x ${ov.x.toFixed(1)} w ${ov.width.toFixed(1)}`)
  ok(`deck ${d}: lane is below the overview and does not cover it`, lane.y >= ov.y + ov.height - 0.5, `lane top ${lane.y.toFixed(1)} / overview bottom ${(ov.y + ov.height).toFixed(1)}`)
  ok(`deck ${d}: the strip is not a blank — a drawn state or a named reason is on screen`, await page.locator(`[data-vocal-strip="${d}"]`).evaluate((el) => el.dataset.vocalState !== undefined && el.innerText.trim().length > 0))
}

// Seeking: the overview still seeks; the lane does not.
const ov = await rect('[data-overview="A"]')
const lane = await rect('[data-vocal-strip="A"] [role="img"]')
if (ov && lane) {
  const before = await read('A')
  await page.mouse.click(lane.x + lane.width * 0.8, lane.y + lane.height / 2)
  await page.waitForTimeout(400)
  const afterLane = await read('A')
  ok('clicking the lane does not move the playhead', Math.abs(afterLane - before) < 0.5, `${before.toFixed(1)} s -> ${afterLane.toFixed(1)} s`)
  await page.mouse.click(ov.x + ov.width * 0.5, ov.y + ov.height / 2)
  await page.waitForTimeout(600)
  const afterOv = await read('A')
  ok('clicking the overview still seeks (about the middle of the 45 s song)', Math.abs(afterOv - 22.5) < 3, `${afterOv.toFixed(1)} s`)
}

// The countdown line follows the position.
const cd = (d) => page.locator(`[data-vocal-countdown="${d}"]`).first().innerText().catch(() => '')
const t1 = await cd('A')
if (ov) await page.mouse.click(ov.x + ov.width * 0.1, ov.y + ov.height / 2)
await page.waitForTimeout(700)
const t2 = await cd('A')
ok('a countdown line is shown', /\d:\d\d|אין/.test(t1), JSON.stringify(t1))
ok('the countdown changes when the position changes', t1 !== t2, `${JSON.stringify(t1)} -> ${JSON.stringify(t2)}`)

// Marking by hand: switch the setting on from the Settings screen, as the owner would.
await page.getByRole('button', { name: /^settings$/i }).click()
await page.getByRole('button', { name: /^library$/i }).click()
const row = page.getByText('Mark vocals by hand').locator('xpath=ancestor::div[contains(@class,"rounded")][1]')
await row.getByRole('switch').or(row.getByRole('checkbox')).or(row.getByRole('button')).first().click()
await page.getByRole('button', { name: /^close$/i }).click()
await page.waitForTimeout(500)
f = await fits()
ok('page fits 710 px with the marking row on, both decks loaded', f.scroll <= f.inner, `scrollHeight ${f.scroll} / ${f.inner}`)
await clipChecks('marking row on')
const libTop = (await rect('text=Tracks'))?.y ?? 0
ok('the library header is still on screen with the marking row on', libTop > 0 && libTop < VIEWPORT.height - 80, `top at ${libTop.toFixed(0)} px of ${VIEWPORT.height}`)

const btn = (n) => page.locator('[data-vocal-marking="A"]').getByRole('button', { name: n })
if (ov) {
  const at = async (fr) => { await page.mouse.click(ov.x + ov.width * fr, ov.y + ov.height / 2); await page.waitForTimeout(500) }
  await at(0.3); await btn('התחילה שירה').click(); await at(0.5); await btn('נגמרה שירה').click()
  await page.waitForTimeout(400)
  ok('marking: start + end draws a manual mark', (await page.locator('[data-vocal-strip="A"] [data-vocal-manual]').count()) >= 1)
  // the owner, 05/10: "when I press 'vocal ended' I expect the black line to start" — a black opens exactly at the voice's end and grows
  await at(0.7)
  const edges = await page.evaluate(() => [...document.querySelectorAll('[data-vocal-strip="A"] [data-vocal-manual]')].map((e) => ({ kind: e.dataset.vocalManualKind, l: parseFloat(e.style.left), w: parseFloat(e.style.width) })))
  const v = edges.find((e) => e.kind === 'voice'), b = edges.find((e) => e.kind === 'none')
  ok('"vocal ended" starts a black right at the voice end, and it grows with the play position', !!v && !!b && Math.abs(v.l + v.w - b.l) < 0.01 && b.l + b.w > 60, JSON.stringify(edges))
  ok('while that black grows, "vocal started" is offered (it closes the black where the voice begins)', (await btn('התחילה שירה').count()) === 1 && !(await btn('התחילה שירה').isDisabled()))
  await btn('התחילה שירה').click(); await page.waitForTimeout(400)
  const stored = await page.evaluate(async () => (await (await window.mod('/src/platform/vocal-manual-idb/store.ts')).getAllVocalManual()).flatMap((t) => t.regions))
  ok('"vocal started" saved the black, from the voice end to the yellow line before the press, and opened the next voice', stored.length === 2 && stored[1].kind === 'none' && stored[1].fromSec === stored[0].toSec && stored[1].toSec <= 0.7 * 45 && (await btn('נגמרה שירה').count()) === 1, JSON.stringify(stored))
  await btn('ביטול התחלה').click(); await page.waitForTimeout(300)
  await btn('ביטול סיום').click(); await page.waitForTimeout(300)
  await btn('ביטול התחלה').click(); await page.waitForTimeout(300)
  await at(0.5)
  await btn('ביטול סיום').click(); await page.waitForTimeout(300)
  ok('undo of the end puts the mark back to open ("ended" is offered again)', (await btn('נגמרה שירה').count()) === 1)
  await btn('ביטול התחלה').click(); await page.waitForTimeout(300)
  ok('cancelling the start leaves no mark', (await page.locator('[data-vocal-strip="A"] [data-vocal-manual]').count()) === 0)
}

// Resizing a purple bar with the mouse: two handles per mark; a drag moves just that edge, Shift is ten times finer, the wheel nudges, and the
// result is saved (read back from the IndexedDB record, not only from memory).
if (ov) {
  const at = async (fr) => { await page.mouse.click(ov.x + ov.width * fr, ov.y + ov.height / 2); await page.waitForTimeout(500) }
  await at(0.3); await btn('התחילה שירה').click(); await at(0.5); await btn('נגמרה שירה').click(); await page.waitForTimeout(400)
  const regions = () => page.evaluate(async () => {
    const db = await new Promise((r) => { const q = indexedDB.open('keyval-store'); q.onsuccess = () => r(q.result) })
    const st = db.transaction('keyval').objectStore('keyval')
    const ks = await new Promise((r) => { const q = st.getAllKeys(); q.onsuccess = () => r(q.result) })
    const out = []
    for (const k of ks.filter((k) => String(k).startsWith('deckmix:vocalManual:'))) out.push(await new Promise((r) => { const q = st.get(k); q.onsuccess = () => r(q.result) }))
    return out.flatMap((t) => t.regions)
  })
  ok('a mark has a handle at each edge', (await page.locator('[data-vocal-strip="A"] [data-vocal-handle]').count()) === 2)
  const before = (await regions())[0]
  const hEnd = await rect('[data-vocal-strip="A"] [data-vocal-handle="0:to"]')
  if (hEnd) {
    const x = hEnd.x + hEnd.width / 2, y = hEnd.y + hEnd.height / 2
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 40, y, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(400)
    const after = (await regions())[0]
    const expectSec = 40 * (45 / ov.width)
    ok('dragging the end handle 40 px moves only the end, by about 40 px worth of seconds, and saves it', Math.abs(after.toSec - before.toSec - expectSec) < 0.6 && after.fromSec === before.fromSec, `end ${before.toSec.toFixed(2)} -> ${after.toSec.toFixed(2)} (expected +${expectSec.toFixed(2)}), start ${before.fromSec} -> ${after.fromSec}`)
    const h2 = await rect('[data-vocal-strip="A"] [data-vocal-handle="0:to"]')
    await page.keyboard.down('Shift'); await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2); await page.mouse.down(); await page.mouse.move(h2.x + h2.width / 2 + 40, h2.y + h2.height / 2, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Shift'); await page.waitForTimeout(400)
    const fine = (await regions())[0]
    ok('Shift makes the same 40 px drag about ten times smaller', Math.abs(fine.toSec - after.toSec - expectSec / 10) < 0.2, `end ${after.toSec.toFixed(2)} -> ${fine.toSec.toFixed(2)} (expected +${(expectSec / 10).toFixed(2)})`)
    const h3 = await rect('[data-vocal-strip="A"] [data-vocal-handle="0:from"]')
    await page.mouse.move(h3.x + h3.width / 2, h3.y + h3.height / 2); await page.mouse.wheel(0, 100); await page.waitForTimeout(500)
    const nudged = (await regions())[0]
    ok('the mouse wheel on a handle nudges that edge by 0.1 s and saves it', Math.abs(nudged.fromSec - fine.fromSec - 0.1) < 0.011, `start ${fine.fromSec} -> ${nudged.fromSec}`)
  }
  await btn('ביטול סיום').click(); await btn('ביטול התחלה').click(); await page.waitForTimeout(300)
}

// Black marks: the computer's purple guess can be painted over with "no voice" while teaching (the owner could only add purple before).
if (ov) {
  const at = async (fr) => { await page.mouse.click(ov.x + ov.width * fr, ov.y + ov.height / 2); await page.waitForTimeout(500) }
  await at(0.7); await btn('התחיל שקט (אין שירה)').click()
  ok('while a black mark is open the purple button stays on (pressing it would close the black where the voice begins)', !(await btn('התחילה שירה').isDisabled()))
  await at(0.9); await btn('נגמר השקט').click(); await page.waitForTimeout(400)
  ok('a black mark is drawn as a black bar', (await page.locator('[data-vocal-strip="A"] [data-vocal-manual-kind="none"]').count()) === 1)
  {
    // the owner, 05/10: his black and the strip's empty "no voice" must be ONE black — same colour, no edge line on his
    const looks = await page.evaluate(() => {
      const mark = document.querySelector('[data-vocal-strip="A"] [data-vocal-manual-kind="none"]')
      const lane = mark?.parentElement
      const cs = (el) => { const c = getComputedStyle(el); return { bg: c.backgroundColor, top: c.borderTopWidth } }
      return mark && lane ? { mark: cs(mark), lane: cs(lane) } : null
    })
    ok('his black mark looks exactly like the empty "no voice" lane (same black, no top line)', !!looks && looks.mark.bg === looks.lane.bg && looks.mark.top === '0px', JSON.stringify(looks))
  }
  await btn('ביטול סיום').click(); await page.waitForTimeout(300)
  ok('undoing the end of a black mark reopens it as black', await btn('נגמר השקט').count() === 1)
  await btn('ביטול התחלה').click(); await page.waitForTimeout(300)
}

// A song with no voice at all (the owner, 04/10: "if the song is quiet I have no way to say I finished"): ticking "no voice in this song" turns
// "finished" on with no marks (his choice of how),
// finishing makes the whole song "no voice" and says so, and a black mark still open when he presses it is closed and kept, not dropped.
if (ov) {
  const at = async (fr) => { await page.mouse.click(ov.x + ov.width * fr, ov.y + ov.height / 2); await page.waitForTimeout(500) }
  const row = () => page.locator('[data-vocal-marking="A"]').innerText()
  const clear = async () => { await btn('מחק סימונים וחזור לניחוש').click(); await btn('בטוח? לחץ שוב').click(); await page.waitForTimeout(400) }
  const noVoiceBox = page.locator('[data-vocal-marking="A"]').getByRole('checkbox', { name: 'אין שירה בשיר' })
  ok('with no marks, "finished" is off until "no voice in this song" is ticked', await btn('סיימתי לסמן את השיר').isDisabled())
  await noVoiceBox.check()
  ok('ticking "no voice in this song" turns "finished" on', !(await btn('סיימתי לסמן את השיר').isDisabled()))
  await btn('סיימתי לסמן את השיר').click(); await page.waitForTimeout(400)
  const stored = await page.evaluate(async () => (await (await window.mod('/src/platform/vocal-manual-idb/store.ts')).getAllVocalManual()).filter((t) => t.finished).map((t) => ({ name: t.name, n: t.regions.length })))
  ok('a quiet song finished with no marks is saved as finished with 0 marks (the export takes it as all "no voice")', stored.length === 1 && stored[0].n === 0, JSON.stringify(stored))
  ok('the row says finished, 0 marks, and the notice says the whole song is "no voice"', (await row()).includes('סימונים: 0 · גמור') && (await page.locator('text=/בלי שירה בכלל/').count()) >= 1)
  // the notice bar pushes the decks down; dismissed so the overview is back where `ov` measured it
  await page.getByRole('button', { name: 'Dismiss' }).click(); await page.waitForTimeout(200)
  await clear()
  await at(0.7); await btn('התחיל שקט (אין שירה)').click(); await at(0.9)
  ok('"finished" can be pressed while a black mark is open', !(await btn('סיימתי לסמן את השיר').isDisabled()))
  await btn('סיימתי לסמן את השיר').click(); await page.waitForTimeout(400)
  ok('finishing closes the open black mark and keeps it', (await row()).includes('סימונים: 1 · גמור') && (await page.locator('[data-vocal-strip="A"] [data-vocal-manual-kind="none"]').count()) === 1)
  await clear()
  await btn('התחיל שקט (אין שירה)').click(); await btn('סיימתי לסמן את השיר').click(); await page.waitForTimeout(400)
  ok('a mark too short to keep stops the finish and its notice stays on screen', !(await row()).includes('גמור') && (await page.locator('text=/קצר מחצי שנייה/').count()) >= 1)
  await page.getByRole('button', { name: 'Dismiss' }).click(); await page.waitForTimeout(200)
}

// Teaching: after "finished", the button offers to teach the computer from this song; it then reads as taught and the library counts it.
if (ov) {
  const at = async (fr) => { await page.mouse.click(ov.x + ov.width * fr, ov.y + ov.height / 2); await page.waitForTimeout(500) }
  await at(0.3); await btn('התחילה שירה').click(); await at(0.5)
  await btn('סיימתי לסמן את השיר').click(); await page.waitForTimeout(400)
  ok('finishing with a voice still open closes it and leaves no black open on the finished song', (await btn('התחיל שקט (אין שירה)').count()) === 1 && (await btn('נגמר השקט').count()) === 0)
  ok('a finished song offers "teach the computer from this song"', (await btn('למד את המחשב מהשיר הזה').count()) === 1)
  await btn('למד את המחשב מהשיר הזה').click(); await page.waitForTimeout(800)
  ok('after teaching, the song reads as taught and offers to take it back out', (await page.locator('[data-vocal-marking="A"]').innerText()).includes('המחשב למד מהשיר הזה') && (await btn('הסר מהלימוד').count()) === 1)
  ok('the library counts the taught song', (await page.locator('text=/נלמדו מסימון ידני: 1/').count()) >= 1)
  await btn('הסר מהלימוד').click(); await page.waitForTimeout(400)
  ok('taking it out of the lessons brings the teach button back', (await btn('למד את המחשב מהשיר הזה').count()) === 1)
}

ok('no page errors or console errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
