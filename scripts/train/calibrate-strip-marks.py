"""
How the vocal strip's settings were chosen (03/10): core/sound/vocal-strip.ts's smoothing, hysteresis and the owner's 2 s rule, fitted to his
hand-marked songs. Leave-one-song-out: each song is scored with the settings that did best on the OTHER songs, so the number it prints is what
a song he has not marked can expect, not how well the settings memorised these.
    python scripts/train/calibrate-strip-marks.py <probs.json from dump-strip-probs.mjs>
Needs numpy only. The gap rule (2 s) is his, not a fitted number: it is fixed here on purpose.
It prints; it does not change the app. Copying a result into vocal-strip.ts is a decision: bump VOCAL_STRIP_VERSION with it.
"""
import itertools, json, sys
import numpy as np

CELL = 0.5
GAP = 4  # his rule: 2 s, in half seconds
songs = json.load(open(sys.argv[1], encoding="utf-8"))


def runs(x):
    out, s = [], 0
    for i in range(1, len(x) + 1):
        if i == len(x) or x[i] != x[s]:
            out.append((s, i, int(x[s])))
            s = i
    return out


def fill_gaps(x, n):
    x = x.copy()
    rs = runs(x)
    for k, (a, b, v) in enumerate(rs):
        if v == 0 and 0 < k < len(rs) - 1 and b - a <= n:
            x[a:b] = 1
    return x


def truth(s):
    t = np.zeros(len(s["probs"]), np.int8)
    for r in s["regions"]:  # later marks paint over earlier ones, like the app
        a, b = int(np.floor(r["fromSec"] / CELL + 1e-9)), int(np.ceil(r["toSec"] / CELL - 1e-9))
        t[a:b] = 0 if r.get("kind") == "none" else 1
    return fill_gaps(t, GAP)


def strip(p, radius, on, off, min_cells):
    k = np.ones(2 * radius + 1)
    q = np.convolve(p, k, "same") / np.convolve(np.ones_like(p), k, "same")
    x, v = np.zeros(len(q), np.int8), False
    for i in range(len(q)):
        if v and q[min(len(q) - 1, i + 1)] < off:  # the end judged one cell ahead, exactly as vocal-strip.ts does (see the note there)
            v = False
        elif not v and q[i] >= on:
            v = True
        x[i] = v
    x = fill_gaps(x, GAP)
    for a, b, val in runs(x):
        if val == 1 and b - a < min_cells:
            x[a:b] = 0
    return x


P = [np.array(s["probs"]) for s in songs]
T = [truth(s) for s in songs]
grid = [(r, on, off, m) for r in (0, 1, 2, 4, 6) for on in (0.35, 0.4, 0.45, 0.5, 0.55) for off in (0.2, 0.25, 0.3, 0.35, 0.4) if off <= on for m in (2, 4, 8, 12)]


def agree(idx, g):
    return sum((strip(P[j], *g) == T[j]).sum() for j in idx) / sum(len(T[j]) for j in idx)


ok = n = sections = 0
for i, s in enumerate(songs):
    g = max(grid, key=lambda g: agree([j for j in range(len(songs)) if j != i], g))
    x = strip(P[i], *g)
    ok += (x == T[i]).sum(); n += len(x); sections += sum(1 for r in runs(x) if r[2] == 1)
    print(f"{s['name'][:44]:44s} {(x == T[i]).mean():4.0%}  chosen on the others: radius {g[0]}, on {g[1]}, off {g[2]}, min {g[3] * CELL:g} s")
print(f"\nleave-one-song-out: agreement {ok / n:.1%}, {sections} voice sections drawn vs {sum(sum(1 for r in runs(t) if r[2] == 1) for t in T)} his")
best = max(grid, key=lambda g: agree(range(len(songs)), g))
print(f"best on all {len(songs)} songs (what goes into the app): radius {best[0]}, on {best[1]}, off {best[2]}, min {best[3] * CELL:g} s -> {agree(range(len(songs)), best):.1%}")
