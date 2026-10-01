/**
 * v0.9.5 research (01/10): can a song's "1 is a beat BEFORE the kick returns" case be told apart from
 * the usual "1 is where the kick returns"? Offline, on `dump-halfbeat-rises.mjs`'s output.
 * Replays detectBarOne's entry search, then looks at what the OTHER bands do in the beat before each entry.
 */
import fs from 'node:fs'
const rows = JSON.parse(fs.readFileSync(`${process.env.TEMP}/halfbeat-rises.json`, 'utf8'))
const W = 16, TOP = 8, GAP = 32, PRIOR = 0.3

function norm(a) {
  const s = Float64Array.from(a).sort()
  const p = s[Math.floor(0.9 * (s.length - 1))]
  return p > 0 ? a.map((v) => v / p) : null
}
const mean = (x, a, b) => { let s = 0; for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) s += x[i]; return s / Math.max(1, Math.min(x.length, b) - Math.max(0, a)) }

function entriesOf(x) {
  const sc = []
  for (let k = W; k + W <= x.length; k++) {
    const r = mean(x, k, k + W) - mean(x, k - W, k)
    const jump = x[k] - Math.max(x[k - 1], x[k - 2])
    if (r > 0 && jump > 0) sc.push([r * jump, k])
  }
  sc.sort((a, b) => b[0] - a[0])
  const taken = []
  for (const [s, k] of sc) {
    if (taken.length >= TOP) break
    if (taken.some(([, j]) => Math.abs(j - k) < GAP)) continue
    taken.push([s, k])
  }
  return taken
}

const out = []
for (const r of rows) {
  const [k0, k1, k2] = r.bands.map(norm)
  if (!k0) continue
  const ent = entriesOf(k0)
  const votes = [0, 0, 0, 0]
  for (const [s, k] of ent) votes[Math.floor(k / 2) % 4] += s
  const tot = votes.reduce((a, b) => a + b, 0) || 1
  const sc = votes.map((v, p) => v / tot + (p === 0 ? PRIOR : 0))
  const got = [0, 1, 2, 3].sort((a, b) => sc[b] - sc[a])[0]
  // pickup feature: other bands in the beat before each entry vs the 2 bars before that
  let pick = 0, w = 0
  for (const [s, k] of ent) {
    for (const b of [k1, k2]) {
      const pre = mean(b, k - 2, k)
      const base = mean(b, k - 18, k - 2)
      pick += s * (pre - base)
    }
    w += s
  }
  out.push({ id: r.id, set: r.set, truth: r.truth, got, rel: (r.truth - got + 4) % 4, pick: pick / (w || 1), n: ent.length })
}
console.log('baseline right:', out.filter((o) => o.rel === 0).length, '/', out.length)
console.log('wrong, by (truth-got) mod 4:', [1, 2, 3].map((d) => `${d}:${out.filter((o) => o.rel === d).length}`).join(' '))
const f = (o) => o.pick.toFixed(2)
console.log('pickup feature, rel=0 right: median', med(out.filter((o) => o.rel === 0).map((o) => o.pick)))
console.log('rel=3 (the 1 is a beat before):', out.filter((o) => o.rel === 3).map(f).join(' '))
for (const o of out.filter((o) => o.rel !== 0)) console.log(o.rel, f(o), o.set, o.id.slice(0, 60))
function med(a) { a = [...a].sort((x, y) => x - y); return a[Math.floor(a.length / 2)].toFixed(2) }
