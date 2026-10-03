"""
v0.9.10b: does training on the owner's HAND-MADE vocal marks (whole songs) beat the model he has now?
    .venv-train/Scripts/python scripts/train/fit-vocal-manual.py
Reads %TEMP%/synth-cells.json, %TEMP%/real-cells.json (the 5 s clips, sealed ones already dropped) and %TEMP%/manual-cells.json
(scripts/train/export-manual-cells.mjs; its sealed songs are in a different file this script never opens - there is no flag for it).

Cross-validation by SONG (GroupKFold, 10 folds): every song is scored by a model that never saw ANY cell of it, neither its marks nor its 5 s clips
(a song that is in both sets is removed from the clips of the fold where it is held out). Leave-one-song-out would be the same idea, 10x slower.
Cells next to a mark's edge (label 2) are neither trained on nor scored. Scored like the app: probabilities smoothed 1 cell each side along the
whole song, then vocal >= 0.40 / none <= 0.15 / else unsure (core/sound/vocal-strip.ts). It prints; it does not pick settings. The variants differ
only in how heavily his marked cells count (fixed weights, shown side by side, not tuned to the result).

Read the answer in this order: (1) MISSES - voice cells drawn as none (the guard's worst error); (2) FALSE ALARMS - no-voice cells drawn as vocal;
(3) the share drawn unsure. 'AUC' says whether the ranking got better even if the thresholds did not move.
"""
import json, os
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score

TMP = os.environ["TEMP"]
VOCAL_AT, NONE_AT = 0.40, 0.15
syn = json.load(open(os.path.join(TMP, "synth-cells.json")))
real = json.load(open(os.path.join(TMP, "real-cells.json")))
man = json.load(open(os.path.join(TMP, "manual-cells.json")))
names = syn["names"]
assert names == real["names"] == man["names"], "feature lists differ - re-export with the current code"
songs = man["songs"]
if len(songs) < 10:
    raise SystemExit(f"only {len(songs)} finished marked songs (not Trance, not sealed): need at least 10 for a 10-fold split by song. Mark more.")

Xs, ys = [], []
for m in syn["mixes"]:
    for row, lab in zip(m["rows"], m["labels"]):
        if lab != "2":
            Xs.append(row); ys.append(int(lab))
Xs, ys = np.array(Xs), np.array(ys)
clips = [c for c in real["clips"] if c["rows"]]
GENRES = sorted({c["genre"] for c in clips} | {s["genre"] for s in songs})

def onehot(g, n):
    return np.tile([1.0 if g == x else 0.0 for x in GENRES], (n, 1))

def clip_xy(cs):
    if not cs:
        return np.zeros((0, len(names) + len(GENRES))), np.zeros(0)
    X = np.array([r + [1.0 if c["genre"] == g else 0.0 for g in GENRES] for c in cs for r in c["rows"]])
    y = np.array([1 if c["answer"] == "yes" else 0 for c in cs for _ in c["rows"]])
    return X, y

def song_xy(ss):
    Xp, yp = [], []
    for s in ss:
        keep = [i for i, l in enumerate(s["labels"]) if l != 2]
        if not keep:
            continue
        X = np.hstack([np.array(s["rows"])[keep], onehot(s["genre"], len(keep))])
        Xp.append(X); yp.append(np.array(s["labels"])[keep])
    return (np.vstack(Xp), np.concatenate(yp)) if Xp else (np.zeros((0, len(names) + len(GENRES))), np.zeros(0))

def smooth(p, radius=1):
    out = np.empty_like(p)
    for i in range(len(p)):
        out[i] = p[max(0, i - radius): i + radius + 1].mean()
    return out

def fit(manual_w, train_songs, held_hashes):
    Xr, yr = clip_xy([c for c in clips if c["hash"] not in held_hashes])
    parts = [(np.hstack([Xs, np.zeros((len(Xs), len(GENRES)))]), ys, 1.0), (Xr, yr, 10.0)]
    if manual_w > 0:
        Xm, ym = song_xy(train_songs)
        parts.append((Xm, ym, manual_w))
    X = np.vstack([p[0] for p in parts if len(p[1])]); y = np.concatenate([p[1] for p in parts if len(p[1])])
    w = np.concatenate([np.full(len(p[1]), p[2]) for p in parts if len(p[1])])
    m = make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=2000, class_weight="balanced"))
    m.fit(X, y, logisticregression__sample_weight=w)
    return m

def run(label, manual_w):
    groups = np.arange(len(songs))
    P, T, G, S = [], [], [], []
    for tr, te in GroupKFold(n_splits=min(10, len(songs))).split(groups, groups=groups):
        held = {songs[i]["hash"] for i in te}
        m = fit(manual_w, [songs[i] for i in tr], held)
        for i in te:
            s = songs[i]
            X = np.hstack([np.array(s["rows"]), onehot(s["genre"], len(s["rows"]))])
            p = smooth(m.predict_proba(X)[:, 1])
            lab = np.array(s["labels"])
            keep = lab != 2
            P.append(p[keep]); T.append(lab[keep]); G.append(np.full(keep.sum(), s["genre"], dtype=object)); S.append(np.full(keep.sum(), i))
    P, T, G = map(np.concatenate, (P, T, G))
    def line(mask, name):
        v, n = mask & (T == 1), mask & (T == 0)
        if v.sum() == 0 or n.sum() == 0:
            return
        miss = (P[v] <= NONE_AT).mean(); vu = ((P[v] > NONE_AT) & (P[v] < VOCAL_AT)).mean()
        fa = (P[n] >= VOCAL_AT).mean(); nu = ((P[n] > NONE_AT) & (P[n] < VOCAL_AT)).mean()
        acc = ((P[mask] >= 0.5) == (T[mask] == 1)).mean()
        base = max((T[mask] == 1).mean(), (T[mask] == 0).mean())
        auc = roc_auc_score(T[mask], P[mask])
        print(f"      {name:<12} voice share {100*(T[mask]==1).mean():3.0f}%  | MISS {100*miss:4.1f}%  (unsure {100*vu:4.1f}%) | FALSE ALARM {100*fa:4.1f}%  (unsure {100*nu:4.1f}%) | acc@0.5 {100*acc:3.0f}% (base {100*base:3.0f}%) AUC {auc:.2f}  n={mask.sum()}")
    print(f"  {label}")
    line(np.ones(len(P), bool), "all")
    for g in sorted(set(G)):
        line(G == g, g)

print(f"{len(songs)} finished marked songs, {sum(len(s['labels']) for s in songs)} cells; 5 s clips {len(clips)}; synthetic {len(ys)}")
print(f"scored like the app: smoothed, vocal >= {VOCAL_AT}, none <= {NONE_AT}\n")
run("A. the current recipe, WITHOUT his marks (the baseline; same as the frozen model's recipe)", 0.0)
for w in (1.0, 3.0, 10.0):
    run(f"B. + his marked songs, each cell weighs {w:g}x a synthetic cell", w)
