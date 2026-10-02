"""
v0.12.15: train on the owner's TRAINING clips plus synthetic mixes, measured leave-one-SONG-out.
    .venv-train/Scripts/python scripts/train/fit-vocal-loso.py
Reads %TEMP%/synth-cells.json and %TEMP%/real-cells.json (sealed clips already dropped by export-real-cells.mjs;
this script has no way to open them). Each real song is predicted by a model that never saw ANY of its clips
(clips of one song are near-copies, so leaving out a single clip would measure memory, not learning).
It prints; it does not search for settings. Real cells are weighted REAL_W times a synthetic cell, three
fixed weights shown side by side, not tuned to the result.
"""
import json, os
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.metrics import roc_auc_score

TMP = os.environ["TEMP"]
DANCE = {"House", "Techno", "Trance"}
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
print(f"synthetic cells {len(ys)}; real clips {len(clips)} from {len(songs)} songs "
      f"(yes {sum(c['answer']=='yes' for c in clips)}, no {sum(c['answer']=='no' for c in clips)})")

GENRES = sorted({c["genre"] for c in real["clips"]})

def cells(cs, onehot=False):
    # `onehot` appends one 0/1 column per genre: the model learns a per-genre offset, which IS a per-genre threshold,
    # fitted only on training songs (a threshold picked on the songs being scored would flatter the score).
    X = np.array([r + ([1.0 if c["genre"] == g else 0.0 for g in GENRES] if onehot else []) for c in cs for r in c["rows"]])
    y = np.array([1 if c["answer"] == "yes" else 0 for c in cs for _ in c["rows"]])
    return X, y

def run(tag, use_syn, real_w, cols, onehot=False):
    idx = [names.index(n) for n in cols]
    gidx = list(range(len(names), len(names) + len(GENRES))) if onehot else []
    p_clip, a_clip, dance, genre, fair = [], [], [], [], []
    for held in songs:
        tr = [c for c in clips if c["hash"] != held]
        te = [c for c in clips if c["hash"] == held]
        Xr, yr = cells(tr, onehot)
        X, y, w = [Xr], [yr], [np.full(len(yr), real_w)]
        if use_syn:
            X.append(np.hstack([Xs, np.zeros((len(Xs), len(GENRES)))]) if onehot else Xs); y.append(ys); w.append(np.ones(len(ys)))
        X, y, w = np.vstack(X)[:, idx + gidx], np.concatenate(y), np.concatenate(w)
        if len(set(y)) < 2:
            continue
        m = make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=2000, class_weight="balanced"))
        m.fit(X, y, logisticregression__sample_weight=w)
        for c in te:
            p_clip.append(m.predict_proba(cells([c], onehot)[0][:, idx + gidx])[:, 1].mean())
            a_clip.append(c["answer"] == "yes"); dance.append(c["genre"] in DANCE); genre.append(c["genre"]); fair.append(c.get("pick", "random") == "random")
    p, a, d = map(np.array, (p_clip, a_clip, dance))
    gn = np.array(genre)
    fr = np.array(fair)
    out = []
    # Per genre as well as the 3-genre group: the owner's whole library is dance music (Mizrahi, HipHop too, 01/10),
    # so "dance vs not" is not the split that matters; the genres' vocal rates are.
    # Trance is left out of the score: the owner says no Trance track in this library has vocals (02/10), so it is a rule
    # ("Trance = none"), not something to measure. Its clips still train.
    # The fair measure is the RANDOM clips only: 'suspect' clips were picked where the detector hears singing, so
    # scoring on them flatters (or punishes) it. They still train; they are never the score.
    for label, mk in [("all random, no Trance", fr & (gn != "Trance"))] + [(g, (gn == g) & fr) for g in sorted(set(gn)) if g != "Trance"]:
        if mk.sum() == 0:
            continue
        base = max(a[mk].mean(), 1 - a[mk].mean())
        auc = roc_auc_score(a[mk], p[mk]) if len(set(a[mk])) > 1 else float("nan")
        out.append(f"{label} {100*((p[mk]>=0.5)==a[mk]).mean():.0f}% (n={mk.sum()}, base {100*base:.0f}%, yes {100*a[mk].mean():.0f}%, AUC {auc:.2f})")
    print(f"  {tag}")
    for line in out:
        print("      " + line)

for set_name, cols in (("28 features", names), ("28 minus level", [n for n in names if not n.startswith("rel_level")])):
    print(f"\n{set_name}:")
    run("real only", False, 1.0, cols)
    run("real only + genre offset", False, 1.0, cols, True)
    run("synthetic + real x10 + genre offset", True, 10.0, cols, True)
    for w in (1, 10, 50):
        run(f"synthetic + real (real x{w})", True, float(w), cols)
