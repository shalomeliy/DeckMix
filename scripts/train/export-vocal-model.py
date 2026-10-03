"""
v0.9.11: fit the FINAL vocal model on every training clip and write its weights as a small JSON — the file the app will load.
    .venv-train/Scripts/python scripts/train/export-vocal-model.py
Reads %TEMP%/synth-cells.json and %TEMP%/real-cells.json (export-real-cells.mjs; sealed clips are already dropped there and this
script has no way to open them). Writes %TEMP%/vocal-model.json; nothing is written into the repo by this script.

The configuration is the one measured as "synthetic + real x10 + genre offset" in fit-vocal-loso.py, unchanged: real cells weigh
REAL_W times a synthetic cell, one 0/1 column per genre (a learned per-genre threshold), StandardScaler + logistic regression with
balanced classes. Chosen BEFORE this export and not tuned here. Afterwards it re-implements the prediction in plain numpy, from the
exported numbers only, and stops if that differs from scikit-learn's — the app will do exactly that arithmetic, so a mismatch here
is a mismatch there.
"""
import json, os, datetime
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline

REAL_W = 10.0
TMP = os.environ["TEMP"]
syn = json.load(open(os.path.join(TMP, "synth-cells.json")))
real = json.load(open(os.path.join(TMP, "real-cells.json")))
names = syn["names"]
assert names == real["names"]

Xs, ys = [], []
for m in syn["mixes"]:
    for row, lab in zip(m["rows"], m["labels"]):
        if lab != "2":  # "ignore" cells are neither voice nor not-voice
            Xs.append(row); ys.append(int(lab))
Xs, ys = np.array(Xs), np.array(ys)

clips = [c for c in real["clips"] if c["rows"]]
GENRES = sorted({c["genre"] for c in real["clips"]})
Xr = np.array([r + [1.0 if c["genre"] == g else 0.0 for g in GENRES] for c in clips for r in c["rows"]])
yr = np.array([1 if c["answer"] == "yes" else 0 for c in clips for _ in c["rows"]])

X = np.vstack([Xr, np.hstack([Xs, np.zeros((len(Xs), len(GENRES)))])])
y = np.concatenate([yr, ys])
w = np.concatenate([np.full(len(yr), REAL_W), np.ones(len(ys))])
pipe = make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=2000, class_weight="balanced"))
pipe.fit(X, y, logisticregression__sample_weight=w)

sc, lr = pipe.named_steps["standardscaler"], pipe.named_steps["logisticregression"]
model = {
    "schema": 1,
    "featureNames": names,
    "genres": GENRES,
    "mean": sc.mean_.tolist(),
    "scale": sc.scale_.tolist(),
    "coef": lr.coef_[0].tolist(),
    "intercept": float(lr.intercept_[0]),
    "provenance": {
        "variant": "synthetic + real x10 + genre offset",
        "trainedOn": datetime.date.today().isoformat(),
        "realClips": len(clips),
        "realSongs": len({c["hash"] for c in clips}),
        "realCells": int(len(yr)),
        "syntheticCells": int(len(ys)),
        "realWeight": REAL_W,
        "labels": "owner's tags; his blind re-check answers replace the first-pass ones; sealed clips never read",
    },
}

# What the app will compute, from the exported numbers alone.
def predict(rows):
    sc_scale = np.where(np.array(model["scale"]) == 0, 1.0, np.array(model["scale"]))
    z = ((rows - np.array(model["mean"])) / sc_scale) @ np.array(model["coef"]) + model["intercept"]
    return 1 / (1 + np.exp(-z))
diff = float(np.max(np.abs(predict(X) - pipe.predict_proba(X)[:, 1])))
print(f"real clips {len(clips)} from {model['provenance']['realSongs']} songs; synthetic cells {len(ys)}; genres {GENRES}")
print(f"largest difference between scikit-learn and the exported arithmetic: {diff:.2e}")
assert diff < 1e-9, "the exported numbers do not reproduce the model"
out = os.path.join(TMP, "vocal-model.json")
json.dump(model, open(out, "w"), ensure_ascii=False, indent=1)
print(f"written {out} ({os.path.getsize(out)} bytes)")
