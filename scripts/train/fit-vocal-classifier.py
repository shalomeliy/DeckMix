"""
v0.12.15 / v0.9.10b: train a small vocal classifier on SYNTHETIC mixes only, then measure it on the owner's
TRAINING clips. Run inside the project's training environment:

    .venv-train/Scripts/python scripts/train/fit-vocal-classifier.py

Reads %TEMP%/synth-cells.json (dump-synth-features.mjs) and %TEMP%/real-cells.json
(export-real-cells.mjs, which already dropped the sealed clips). The owner's clips are NEVER trained on
here: they are the measurement. Nothing is tuned against them in this script — it prints, it does not search.
Cells labelled 2 (a voice 9-20 dB under the mix) are dropped from training: neither yes nor no.
"""
import json, os, sys
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
assert names == real["names"], "feature lists differ between synthetic and real"

X, y, g = [], [], []
for i, m in enumerate(syn["mixes"]):
    for row, lab in zip(m["rows"], m["labels"]):
        if lab == "2":
            continue
        X.append(row); y.append(int(lab)); g.append(i)
X, y, g = np.array(X), np.array(y), np.array(g)
print(f"synthetic cells: {len(y)} (vocal {y.sum()}, {100*y.mean():.0f}%) from {len(syn['mixes'])} mixes")

# Hold out whole MIXES (not cells): neighbouring cells of one mix are near-copies of each other.
val = g % 5 == 0
Xtr, ytr, Xva, yva = X[~val], y[~val], X[val], y[val]

def fit(cols, C=1.0):
    idx = [names.index(c) for c in cols]
    model = make_pipeline(StandardScaler(), LogisticRegression(C=C, max_iter=2000, class_weight="balanced"))
    model.fit(Xtr[:, idx], ytr)
    return model, idx

def real_report(model, idx, tag):
    rows = []
    for c in real["clips"]:
        p = model.predict_proba(np.array(c["rows"])[:, idx])[:, 1].mean() if c["rows"] else 0.5
        rows.append((c["answer"] == "yes", p, c["genre"] in DANCE))
    ans = np.array([r[0] for r in rows]); p = np.array([r[1] for r in rows]); dance = np.array([r[2] for r in rows])
    out = {}
    for label, mask in (("all", np.ones_like(ans, bool)), ("dance", dance)):
        acc = ((p[mask] >= 0.5) == ans[mask]).mean()
        auc = roc_auc_score(ans[mask], p[mask]) if len(set(ans[mask])) > 1 else float("nan")
        base = max(ans[mask].mean(), 1 - ans[mask].mean())
        out[label] = f"{100*acc:.0f}% (n={mask.sum()}, baseline {100*base:.0f}%, AUC {auc:.2f})"
    print(f"  {tag:<34} real clips: all {out['all']}; dance {out['dance']}")

sets = {
    "existing 4 cues only": ["harmonic_mean", "centre_mean", "bright_mean", "motion_mean", "stereo"],
    "all means (no spread, no context)": [n for n in names if n.endswith("_mean")] + ["stereo"],
    "all 16 features": names,
}
for tag, cols in sets.items():
    model, idx = fit(cols)
    pva = model.predict_proba(Xva[:, idx])[:, 1]
    print(f"{tag}: synthetic held-out mixes accuracy {100*((pva>=0.5)==yva).mean():.0f}%, AUC {roc_auc_score(yva, pva):.3f}")
    real_report(model, idx, tag)

model, idx = fit(names)
coef = model.named_steps["logisticregression"].coef_[0]
print("\nstrongest features in the 16-feature model (standardised weight):")
for i in np.argsort(-np.abs(coef))[:8]:
    print(f"  {names[idx[i]]:<18} {coef[i]:+.2f}")
