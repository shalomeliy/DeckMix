/**
 * v0.9.5 listening round (28/09): where Shalom's "1" and the kick-entry
 * detector disagree, hear both — no waveform. The waveform rounds may pull the
 * eye a beat early (the energy rises on the waveform a beat before the kick
 * comes in), and 4 of the 6 dance songs the detector "misses" in training are
 * exactly one beat before the kick. Only his ears can say which one is right.
 *
 *   node scripts/listen-downbeat.mjs      then open http://127.0.0.1:5188 in Chrome
 *   (needs npm run dev on :5173 for the WAV repair module)
 *
 * Training songs only — the sealed 30 are not touched. Songs: every training
 * song where `kickPrior` disagrees with the answer, plus as many controls
 * where they agree (the second click there is one beat off on purpose — if he
 * picks it, the round itself is unreliable). Shuffled; which click is "his" is
 * random per song and never shown. Both clicks play over the same stretch of
 * music, so only the click differs.
 *
 * Read-only for the music. Answers go to Downloads/deckmix-listen-2026-09-28.json
 * after every answer, so closing the tab loses nothing.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { M, songs } from './experiment-downbeat.mjs'

const ROOT = String.raw`C:\Users\Shalom\Music\Tracks`
const OUT = path.join(os.homedir(), 'Downloads', 'deckmix-listen-2026-09-28.json')
const TAGS = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Downloads', 'deckmix-tags-2026-09-28 - 26 songs.json'), 'utf8'))
const decide = new Map(TAGS.decide.map((d) => [d.contentHash, d.markSec]))
const markBy = new Map(TAGS.mark.map((m) => [m.contentHash, m.markSec]))

// deterministic shuffle, so a restart shows the same order
let seed = 20260928
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const disagree = []
const agree = []
for (const f of songs) {
  const s = M.kickPrior(f)
  const best = s.indexOf(Math.max(...s))
  ;(best === f.truth ? agree : disagree).push({ f, best })
}
const controls = agree.map((x) => [rnd(), x]).sort((a, b) => a[0] - b[0]).slice(0, disagree.length).map((x) => x[1])
const items = [...disagree.map((x) => ({ ...x, control: false })), ...controls.map((x) => ({ ...x, control: true }))]
  .map((x) => [rnd(), x])
  .sort((a, b) => a[0] - b[0])
  .map(([, x], i) => {
    const beat = 60 / x.f.grid.bpm
    const mine = decide.get(x.f.contentHash) ?? markBy.get(x.f.contentHash)
    // detector: nearest beat of its phase to his mark (−1..+2 beats); control: one beat off, either side
    const d = x.control ? (rnd() < 0.5 ? -1 : 1) : ((x.best - x.f.truth + 4) % 4 === 3 ? -1 : (x.best - x.f.truth + 4) % 4)
    const other = mine + d * beat
    const mineIsA = rnd() < 0.5
    return {
      i,
      contentHash: x.f.contentHash,
      trackId: x.f.trackId,
      control: x.control,
      bpm: x.f.grid.bpm,
      a: mineIsA ? mine : other,
      b: mineIsA ? other : mine,
      mineIsA,
      offsetBeats: d,
    }
  })
console.log(`${disagree.length} disagreements + ${controls.length} controls = ${items.length} songs`)

const saved = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { answers: {} }
const publicItems = items.map(({ i, trackId, bpm, a, b }) => ({ i, name: trackId.split('/').pop().replace(/\.[^.]+$/, ''), bpm, a, b }))

const PAGE = `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>סבב האזנה</title>
<style>
body{font-family:Arial,sans-serif;background:#15151c;color:#eee;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.6}
button{font-size:17px;padding:12px 18px;margin:6px 4px;border-radius:8px;border:1px solid #555;background:#262633;color:#eee;cursor:pointer}
button:hover{border-color:#aaa} button.play{background:#2d3b5c} button.ans{background:#2f4a36} button:disabled{opacity:.4;cursor:default}
.muted{color:#999;font-size:14px} h1{font-size:22px} .name{font-size:18px;margin:12px 0}
</style>
<h1>איפה ה-1? סבב האזנה</h1>
<p class="muted">כל שיר מתנגן פעמיים על אותו קטע, עם תקתוק חזק על ה-"1" ותקתוק חלש על שאר הפעימות. ההבדל היחיד בין א' ל-ב' הוא איפה התקתוק החזק. בחר את זה שנשמע נכון.</p>
<div id="app">טוען…</div>
<script type="module">
const items = ${JSON.stringify(publicItems)}
let answers = ${JSON.stringify(saved.answers)}
const ctx = new AudioContext()
let buf = null, bufFor = -1, src = [], plays = {}
let cur = items.findIndex((it) => !answers[it.i]); if (cur < 0) cur = items.length
async function load(it) {
  if (bufFor === it.i) return
  document.getElementById('status').textContent = 'טוען את השיר…'
  const bytes = await (await fetch('/audio/' + it.i)).arrayBuffer()
  let data = bytes
  try { const { repairWav } = await import('http://localhost:5173/src/core/wav-repair.ts'); const w = repairWav(new Uint8Array(bytes)); if (w) data = w.buffer } catch {}
  buf = await ctx.decodeAudioData(data); bufFor = it.i
  document.getElementById('status').textContent = ''
}
function stop() { for (const s of src) try { s.stop() } catch {} ; src = [] }
function click(t, strong) {
  const o = ctx.createOscillator(), g = ctx.createGain()
  o.frequency.value = strong ? 1800 : 1000
  g.gain.setValueAtTime(strong ? 0.5 : 0.15, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05)
  o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.06); src.push(o)
}
async function play(it, which) {
  await ctx.resume(); await load(it); stop()
  plays[it.i] = (plays[it.i] ?? 0) + 1
  const beat = 60 / it.bpm, bar = 4 * beat
  const one = which === 'a' ? it.a : it.b
  const from = Math.max(0, Math.min(it.a, it.b) - 2 * bar)
  const len = 7 * bar
  const t0 = ctx.currentTime + 0.1
  const s = ctx.createBufferSource(); s.buffer = buf
  const g = ctx.createGain(); g.gain.value = 0.8
  s.connect(g).connect(ctx.destination); s.start(t0, from, len); src.push(s)
  // clicks on every beat of the grid through "one", strong on every 4th counted from it
  const first = one - Math.ceil((one - from) / beat) * beat
  for (let k = 0; first + k * beat < from + len; k++) {
    const at = first + k * beat
    if (at < from) continue
    const n = Math.round((at - one) / beat)
    click(t0 + (at - from), ((n % 4) + 4) % 4 === 0)
  }
}
async function answer(it, value) {
  stop()
  answers[it.i] = { value, plays: plays[it.i] ?? 0, at: Date.now() }
  await fetch('/answer', { method: 'POST', body: JSON.stringify({ i: it.i, ...answers[it.i] }) })
  cur = items.findIndex((x) => !answers[x.i]); if (cur < 0) cur = items.length
  render()
}
function render() {
  const app = document.getElementById('app')
  const done = Object.keys(answers).length
  if (cur >= items.length) { app.innerHTML = '<h2>סיימת! ' + done + ' מתוך ' + items.length + '. תודה.</h2><p class="muted">התשובות נשמרו בהורדות. אפשר לסגור את הדף.</p>'; return }
  const it = items[cur]
  app.innerHTML = '<p class="muted">שיר ' + (cur + 1) + ' מתוך ' + items.length + ' · נענו ' + done + '</p>' +
    '<div class="name" dir="auto">' + it.name.replace(/</g, '&lt;') + '</div>' +
    '<div><button class="play" id="pa">▶ נגן עם תקתוק א\\'</button><button class="play" id="pb">▶ נגן עם תקתוק ב\\'</button><button id="st">■ עצור</button></div>' +
    '<p id="status" class="muted"></p>' +
    '<div><button class="ans" id="aa">א\\' נכון</button><button class="ans" id="ab">ב\\' נכון</button></div>' +
    '<div><button id="an">התקתוק לא נופל על הקיק (באמצע)</button><button id="au">לא בטוח / נשמע אותו דבר</button></div>'
  document.getElementById('pa').onclick = () => play(it, 'a')
  document.getElementById('pb').onclick = () => play(it, 'b')
  document.getElementById('st').onclick = stop
  document.getElementById('aa').onclick = () => answer(it, 'a')
  document.getElementById('ab').onclick = () => answer(it, 'b')
  document.getElementById('an').onclick = () => answer(it, 'offKick')
  document.getElementById('au').onclick = () => answer(it, 'unsure')
}
render()
</script></html>`

function persist() {
  const rows = items.map((it) => ({ ...it, answer: saved.answers[it.i] ?? null }))
  fs.writeFileSync(OUT, JSON.stringify({ kind: 'deckmix-listen', round: '2026-09-28', answers: saved.answers, items: rows }, null, 1))
}
http
  .createServer((req, res) => {
    if (req.url === '/') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE)
    if (req.url.startsWith('/audio/')) {
      const it = items[Number(req.url.split('/').pop())]
      if (!it) return res.writeHead(404).end()
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      return fs.createReadStream(path.join(ROOT, it.trackId)).pipe(res)
    }
    if (req.url === '/answer' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const a = JSON.parse(body)
        saved.answers[a.i] = { value: a.value, plays: a.plays, at: a.at }
        persist()
        console.log(`  answered ${Object.keys(saved.answers).length}/${items.length}`)
        res.writeHead(200).end('ok')
      })
      return
    }
    res.writeHead(404).end()
  })
  .listen(5188, '127.0.0.1', () => console.log('open http://127.0.0.1:5188'))
