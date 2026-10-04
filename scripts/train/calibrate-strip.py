"""
NOTE (04/10): this describes the strip BEFORE 04/10 (0.40/0.15 with an unsure band). The app now uses core/sound/vocal-strip.ts's
hysteresis + the owner's 2 s rule; calibrate-strip-marks.py is the script for that.
v0.9.10b: how the vocal strip's two thresholds behave, measured on songs the model never saw.
    .venv-train/Scripts/python scripts/train/calibrate-strip.py
Reads %TEMP%/synth-cells.json and %TEMP%/real-cells.json (sealed clips already dropped by export-real-cells.mjs; this script cannot open them).
Refits the FROZEN variant (synthetic + real x10 + genre offset, 28 features) leaving one SONG out at a time, takes the probability of every half-second
cell of the held-out song's clips, smooths it the way the app does (1 cell each side, within the 5 s clip), and for each pair of thresholds says what
the strip would have drawn on cells the owner labelled:
    cells he heard voice in     -> drawn vocal / unsure / none   (none = a MISS: the strip hid a voice)
    cells he heard no voice in  -> drawn vocal / unsure / none   (vocal = a FALSE ALARM)
It prints; it does not pick a pair. Picking is the owner's decision (the guard he chose is "careful": few misses, false alarms accepted).
Only RANDOM clips are scored and Trance is left out (it is a rule, not a measurement) - the same fair measure as fit-vocal-loso.py.
Not exactly the app: real clips are 5 s islands, so the smoothing at a clip's edge sees fewer neighbours than inside a whole song.
"""
import json, os
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline

TMP = os.environ["TEMP"]
syn = json.load(open(os.path.join(TMP, "synth-cells.json")))
real = json.load(open(os.path.join(TMP, "real-cells.json")))
names = syn["names"]
assert names == real["names"]
Xs, ys = [], []
for m in syn["mixes"]:
    for row, lab in zip(m["rows"], m["labels"]):
        if lab != "2":
            Xs.append(row); ys.append(int(lab))
Xs, ys = np.array(Xs), np.array(ys)
clips = [c for c in real["clips"] if c["rows"]]
songs = sorted({c["hash"] for c in clips})
GENRES = sorted({c["genre"] for c in real["clips"]})

def cells(cs):
    X = np.array([r + [1.0 if c["genre"] == g else 0.0 for g in GENRES] for c in cs for r in c["rows"]])
    y = np.array([1 if c["answer"] == "yes" else 0 for c in cs for _ in c["rows"]])
    return X, y

def smooth(p, radius=1):
    out = np.empty_like(p)
    for i in range(len(p)):
        out[i] = p[max(0, i - radius): i + radius + 1].mean()
    return out

probs, truth, genre = [], [], []
for held in songs:
    tr = [c for c in clips if c["hash"] != held]
    te = [c for c in clips if c["hash"] == held and c.get("pick", "random") == "random" and c["genre"] != "Trance"]
    if not te:
        continue
    Xr, yr = cells(tr)
    X = np.vstack([Xr, np.hstack([Xs, np.zeros((len(Xs), len(GENRES)))])])
    y = np.concatenate([yr, ys])
    w = np.concatenate([np.full(len(yr), 10.0), np.ones(len(ys))])
    m = make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=2000, class_weight="balanced"))
    m.fit(X, y, logisticregression__sample_weight=w)
    for c in te:
        Xc, _ = cells([c])
        probs.append(smooth(m.predict_proba(Xc)[:, 1]))
        truth.append(np.full(len(Xc), 1 if c["answer"] == "yes" else 0))
        genre.append(np.full(len(Xc), c["genre"], dtype=object))
P, T, G = np.concatenate(probs), np.concatenate(truth), np.concatenate(genre)
print(f"scored cells: {len(P)} ({int(T.sum())} heard-voice, {int((1 - T).sum())} heard-none) from {len(songs)} songs, random clips, no Trance")

def row(mask, v, n):
    if mask.sum() == 0:
        return "   -  "
    pv, pn = (P[mask] >= v).mean(), (P[mask] <= n).mean()
    return f"{100*pv:3.0f}/{100*(1-pv-pn):3.0f}/{100*pn:3.0f}"

print("\nEach cell: % drawn vocal / unsure / none.  The column that matters: voice-cells -> none (a MISS), no-voice-cells -> vocal (a FALSE ALARM).")
print("current app setting: vocal >= 0.40, none <= 0.15\n")
for scope, mk in [("all genres", np.ones(len(P), bool))] + [(g, G == g) for g in sorted(set(G))]:
    print(f"[{scope}]  heard-voice cells n={int((mk & (T == 1)).sum())}, heard-none cells n={int((mk & (T == 0)).sum())}")
    print("  vocal>=  none<=   voice-cells (V/U/N)   no-voice-cells (V/U/N)")
    for v in (0.30, 0.40, 0.50, 0.60, 0.70):
        for n in (0.05, 0.15, 0.25, 0.35):
            if n >= v:
                continue
            star = "  <- current" if (v, n) == (0.40, 0.15) else ""
            print(f"   {v:.2f}    {n:.2f}      {row(mk & (T == 1), v, n)}            {row(mk & (T == 0), v, n)}{star}")
    print()
