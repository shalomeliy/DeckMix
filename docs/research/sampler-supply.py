# v0.9.30 stage 1, experiment 1: how many bar-aligned windows does each song offer,
# by vocal state, using only the owner's hand marks + beat grid (no audio decode).
# Pre-registered pass rule (written before running): >=80% of songs have >=2
# non-overlapping 4-bar windows with NO singing, and >=80% have >=1 4-bar window of ONLY singing.
import json, sys, math
songs = json.load(open(sys.argv[1] if len(sys.argv) > 1 else '/mnt/project-files/research/mix-after-vocal-v0.9.63/songs.json'))
CELL = 0.25
def cells(s):
    n = int(s['durationSec'] / CELL) + 1
    c = [0] * n  # 0 = unmarked/none, 1 = voice
    for r in s['regions']:
        v = 0 if r.get('kind') == 'none' else 1
        a, b = int(r['fromSec'] / CELL), int(math.ceil(r['toSec'] / CELL))
        for i in range(max(a, 0), min(b, n)): c[i] = v
    return c
def windows(s, bars):
    beat = 60.0 / s['bpm']; L = bars * 4 * beat
    c = cells(s); out = []
    t = s['offsetSec'] % (4 * beat)
    while t + L <= s['durationSec'] - 10:     # keep 10 s off the end, like structure.ts
        if t >= 10:                            # and off the start
            a, b = int(t / CELL), int((t + L) / CELL)
            seg = c[a:b]
            out.append((t, sum(seg) / max(len(seg), 1)))
        t += 4 * beat                          # slide one bar
    return out
def nonoverlap(ws, L):
    n, end = 0, -1e9
    for t, _ in ws:
        if t >= end: n += 1; end = t + L
    return n
rows = []
for s in songs:
    if not s.get('bpm') or not s['regions']: continue
    beat = 60.0 / s['bpm']; L4 = 16 * beat
    w = windows(s, 4)
    quiet = [x for x in w if x[1] == 0.0]
    sung = [x for x in w if x[1] >= 0.98]
    rows.append(dict(name=s['name'], genre=s['genre'], q=nonoverlap(quiet, L4), v=nonoverlap(sung, L4)))
n = len(rows)
q2 = sum(r['q'] >= 2 for r in rows); v1 = sum(r['v'] >= 1 for r in rows)
print('songs with bpm+marks', n)
print('>=2 quiet 4-bar windows', q2, round(100 * q2 / n, 1), '%')
print('>=1 fully-sung 4-bar window', v1, round(100 * v1 / n, 1), '%')
by = {}
for r in rows: by.setdefault(r['genre'], []).append(r)
for g, rs in by.items():
    print(g, len(rs), 'quiet>=2:', sum(r['q'] >= 2 for r in rs), 'sung>=1:', sum(r['v'] >= 1 for r in rs))
print('PASS' if q2 / n >= .8 and v1 / n >= .8 else 'FAIL')
print('zero-candidate songs:', [r['name'] for r in rows if r['q'] == 0 and r['v'] == 0][:10])
