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

v0.9.10b: MANUAL_W=<weight> also trains on the owner's hand-marked whole songs (scripts/train/export-manual-cells.mjs; its sealed songs are in a
file this script never opens). 0 or unset = the model exactly as before. Pick the weight from what fit-vocal-manual.py showed, BEFORE running this.
FREEZING a new model is a decision, not a side effect: copy the file to src/core/sound/vocal-model.json, update FROZEN_SHA256 and the clip/song counts
in tests/core/sound/vocal-model-frozen.test.ts, bump VOCAL_STRIP_VERSION (platform/vocal-strip-idb/store.ts) and the fingerprint in
tests/core/sound/vocal-strip.test.ts — otherwise the strips already stored on the owner's machine keep the old model's answers. Then measure once
on the sealed manual songs (the only held-out test that is left).
"""
import json, os, datetime
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline

REAL_W = 10.0
MANUAL_W = float(os.environ.get("MANUAL_W", "0"))
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
manual_songs = []
if MANUAL_W > 0:
    man = json.load(open(os.path.join(TMP, "manual-cells.json")))
    assert man["names"] == names, "feature lists differ - re-export with the current code"
    manual_songs = man["songs"]
GENRES = sorted({c["genre"] for c in real["clips"]} | {s["genre"] for s in manual_songs})
Xr = np.array([r + [1.0 if c["genre"] == g else 0.0 for g in GENRES] for c in clips for r in c["rows"]])
yr = np.array([1 if c["answer"] == "yes" else 0 for c in clips for _ in c["rows"]])

Xm_parts, ym_parts = [], []
for s in manual_songs:
    keep = [i for i, l in enumerate(s["labels"]) if l != 2]  # cells beside a mark's edge are not an answer
    if keep:
        Xm_parts.append(np.hstack([np.array(s["rows"])[keep], np.tile([1.0 if s["genre"] == g else 0.0 for g in GENRES], (len(keep), 1))]))
        ym_parts.append(np.array(s["labels"])[keep])
Xm = np.vstack(Xm_parts) if Xm_parts else np.zeros((0, len(names) + len(GENRES)))
ym = np.concatenate(ym_parts) if ym_parts else np.zeros(0)

X = np.vstack([Xr, np.hstack([Xs, np.zeros((len(Xs), len(GENRES)))]), Xm])
y = np.concatenate([yr, ys, ym])
w = np.concatenate([np.full(len(yr), REAL_W), np.ones(len(ys)), np.full(len(ym), MANUAL_W)])
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
        "variant": "synthetic + real x10 + genre offset" + (f" + marked songs x{MANUAL_W:g}" if MANUAL_W > 0 else ""),
        "trainedOn": datetime.date.today().isoformat(),
        "realClips": len(clips),
        "realSongs": len({c["hash"] for c in clips}),
        "realCells": int(len(yr)),
        "syntheticCells": int(len(ys)),
        "realWeight": REAL_W,
        "manualSongs": len(manual_songs),
        "manualCells": int(len(ym)),
        "manualWeight": MANUAL_W,
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
