"""
v0.9.10b (04/10): a genre's vocal strip learns from the owner's hand marks in that genre ("I marked every Techno song in my library — make
the Techno analysis follow my marks").
    python scripts/train/fit-genre-marks.py <probs.json> <genre> [out.json]
<probs.json> comes from dump-strip-probs.mjs with --rows (the frozen model's probabilities, the 28 features and his labels per cell).
Needs numpy + scikit-learn.

What it fits: a logistic regression on the 28 cell features of THIS genre's marked songs only, each song weighing the same. The app then
averages its answer with the frozen model's, in log-odds (BLEND), and adds one shift so the shipped strip (vocal-strip.ts, unchanged) lands
where his marks do. Measured 04/10 on his 42 Techno songs, leave-one-song-out, against the strip read with his 2 s rule:
    frozen model alone 75.9% | shift only 75.9% | Techno model alone 77.6% (21 songs better, 12 worse) | average 78.3% (18 better, 6 worse)
The average is the one shipped: it loses on far fewer songs. Cells beside an edge of his marks are not trained on (his reaction time).

Honesty of the number: every song is scored by a model AND a shift chosen without it (the shift on an inner 7-fold of the other songs).
What it does not know: songs he has not marked. What else it does not know: BLEND, C and EDGE, and picking "average" over "genre model alone", were chosen by
comparing these same leave-one-song-out scores, so 78.3% is slightly optimistic. Writes [out.json] as the whole genres file (point it at
src/core/sound/vocal-genre-models.json to update it in place) — that is a decision: bump VOCAL_STRIP_VERSION and the hashes in
tests/core/sound/vocal-genre-models.test.ts and vocal-strip.test.ts with it.
"""
import datetime, json, sys
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

CELL, GAP = 0.5, 4  # his rule: 2 s, in half seconds
STRIP = (2, 0.5, 0.25, 4)  # vocal-strip.ts: SMOOTH_RADIUS_CELLS, VOICE_ON_AT, VOICE_OFF_AT, MIN_VOICE_SEC in cells
BLEND, C, EDGE = 0.5, 0.1, 2
SHIFTS = np.arange(-3, 3.01, 0.25)

songs = [s for s in json.load(open(sys.argv[1], encoding="utf-8")) if s["genre"] == sys.argv[2]]
assert songs and all("rows" in s and "labels" in s for s in songs), "need dump-strip-probs.mjs --rows output for this genre"
N = len(songs)


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


def strip(p, radius, on, off, min_cells):  # exactly cellsFromProbabilities (vocal-strip.ts); the parity is checked by the node step below
    k = np.ones(2 * radius + 1)
    q = np.convolve(p, k, "same") / np.convolve(np.ones_like(p), k, "same")
    x, v = np.zeros(len(q), np.int8), False
    for i in range(len(q)):
        if v and q[min(len(q) - 1, i + 1)] < off:
            v = False
        elif not v and q[i] >= on:
            v = True
        x[i] = v
    x = fill_gaps(x, GAP)
    for a, b, val in runs(x):
        if val == 1 and b - a < min_cells:
            x[a:b] = 0
    return x


n_of = [min(len(s["labels"]), len(s["rows"]), len(s["probs"])) for s in songs]
R = [np.array(s["rows"][:n]) for s, n in zip(songs, n_of)]
Y = [np.array(s["labels"][:n]) for s, n in zip(songs, n_of)]
T = [fill_gaps(y.astype(np.int8), GAP) for y in Y]  # what he means: a stop of 2 s or less inside singing is singing
lg = lambda p: np.log(np.clip(p, 1e-4, 1 - 1e-4) / (1 - np.clip(p, 1e-4, 1 - 1e-4)))
sig = lambda z: 1 / (1 + np.exp(-z))
ZB = [lg(np.array(s["probs"][:n])) for s, n in zip(songs, n_of)]


def keep(y):
    k = np.ones(len(y), bool)
    for i in range(1, len(y)):
        if y[i] != y[i - 1]:
            k[max(0, i - EDGE):i + EDGE] = False
    return k


def fit(idx):
    K = [keep(Y[j]) for j in idx]
    X = np.vstack([R[j][k] for j, k in zip(idx, K)])
    y = np.concatenate([Y[j][k] for j, k in zip(idx, K)])
    w = np.concatenate([np.full(k.sum(), 1.0 / max(1, k.sum())) for k in K])
    m = make_pipeline(StandardScaler(), LogisticRegression(C=C, max_iter=5000))
    m.fit(X, y, logisticregression__sample_weight=w * len(w))
    return m


z_of = lambda m, j: BLEND * ZB[j] + (1 - BLEND) * lg(m.predict_proba(R[j])[:, 1])
agree = lambda idx, Z, b: sum((strip(sig(Z[j] + b), *STRIP) == T[j]).sum() for j in idx) / sum(len(T[j]) for j in idx)


def choose_shift(idx):
    folds = [idx[k::7] for k in range(7)]
    Z = {}
    for f in folds:
        m = fit([j for j in idx if j not in f])
        for g in f:
            Z[g] = z_of(m, g)
    return float(max(SHIFTS, key=lambda b: agree(idx, Z, b)))


ok_b = ok_n = n = better = worse = 0
for h in range(N):
    tr = [j for j in range(N) if j != h]
    b = choose_shift(tr)
    x = strip(sig(z_of(fit(tr), h) + b), *STRIP)
    xb = strip(sig(ZB[h]), *STRIP)
    a, ab = (x == T[h]).mean(), (xb == T[h]).mean()
    better += a > ab + 0.02; worse += a < ab - 0.02
    ok_n += (x == T[h]).sum(); ok_b += (xb == T[h]).sum(); n += len(x)
    print(f"{songs[h]['name'][:44]:44s} frozen {ab:4.0%}  with his {sys.argv[2]} marks {a:4.0%}  (shift {b:+.2f})", flush=True)
print(f"\nleave-one-song-out, {N} songs: frozen model {ok_b / n:.1%} -> with the genre model {ok_n / n:.1%}; {better} songs better, {worse} worse (by >2 points)")

m = fit(list(range(N)))
shift = choose_shift(list(range(N)))
sc, lr = m.named_steps["standardscaler"], m.named_steps["logisticregression"]
out = {
    "mean": [float(v) for v in sc.mean_], "scale": [float(v) for v in sc.scale_],
    "coef": [float(v) for v in lr.coef_[0]], "intercept": float(lr.intercept_[0]),
    "blend": BLEND, "shift": shift,
    "provenance": {"trainedOn": datetime.date.today().isoformat(), "songs": N, "cells": int(sum(len(y) for y in Y)),
                   "looAgreement": round(ok_n / n, 4), "frozenAgreement": round(ok_b / n, 4), "source": "the owner's hand marks (vocal-marks export)"},
}
# The app does this arithmetic from the exported numbers alone: it must match scikit-learn's.
for j in range(N):
    zg = out["intercept"] + ((R[j] - np.array(out["mean"])) / np.where(np.array(out["scale"]) == 0, 1, out["scale"])) @ np.array(out["coef"])
    assert np.allclose(sig(zg), m.predict_proba(R[j])[:, 1], atol=1e-6), "exported numbers do not reproduce the fitted model"
# The same check end to end, on the strip: node runs the shipped arithmetic on this file and measure-strip-marks.mjs scores it; on these
# (training) songs it must print this number, give or take the 4-decimal rounding of the frozen probabilities in <probs.json>.
ins = sum((strip(sig(z_of(m, j) + shift), *STRIP) == T[j]).sum() for j in range(N)) / sum(len(t) for t in T)
print(f"on the {N} training songs themselves (not a measurement, a parity reference for the app): {ins:.1%}")
if len(sys.argv) > 3:
    # Written as the whole file the app reads (src/core/sound/vocal-genre-models.json), this genre's entry next to any others already there.
    path = sys.argv[3]
    try:
        doc = json.load(open(path, encoding="utf-8"))
    except FileNotFoundError:
        doc = {"schema": 1, "featureNames": None, "models": {}}
    names = json.load(open("src/core/sound/vocal-model.json", encoding="utf-8"))["featureNames"]
    doc["schema"], doc["featureNames"] = 1, names
    doc["models"][sys.argv[2]] = out
    open(path, "w").write(json.dumps(doc) + "\n")
    print(f"wrote {path}: {sys.argv[2]} shift {shift:+.2f}, fitted on all {N} songs")
