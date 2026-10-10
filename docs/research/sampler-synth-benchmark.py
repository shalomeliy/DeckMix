"""v0.9.30 stage 1, experiment 2 (10/10): a synthetic benchmark with KNOWN answers.

We build tracks with sounds we place on purpose, so we know which 4-bar block is a good loop
and which is not, then check that a block-vs-next-block score separates them. The score never
compares a candidate's beginning beat with its ending beat (see sampler-finder.md, patent note):
it compares the band-energy contour of a WHOLE block with the contour of the WHOLE next block.

Pre-registered pass rule (written before the first run):
  AUC >= 0.95 between good and bad blocks, and every kind of bad block is caught by one
  threshold taken from the good blocks (their 5th percentile) at a rate of 90% or more.
"""
import numpy as np

SR, BPM = 11025, 124.0
BEAT = 60.0 / BPM
BAR = 4 * BEAT
rng = np.random.default_rng(7)


def tone(f, dur, amp=1.0, decay=8.0):
    t = np.arange(int(dur * SR)) / SR
    return amp * np.sin(2 * np.pi * f * t) * np.exp(-decay * t)


def noise(dur, amp=0.3, decay=40.0):
    t = np.arange(int(dur * SR)) / SR
    return amp * rng.standard_normal(t.size) * np.exp(-decay * t)


JITTER = 0.0  # 0 = machine-perfect; >0 = human-ish: each hit gets a random volume and timing error


def put(buf, sig, at):
    if JITTER:
        sig = sig * (1 + JITTER * rng.uniform(-1, 1))
        at = at + JITTER * 0.02 * rng.uniform(-1, 1)
    i = max(int(at * SR), 0)
    if i < buf.size:
        buf[i:i + sig.size] += sig[: buf.size - i]


def bar_audio(bass_notes, hat=True, kick=True, vocal=False):
    buf = np.zeros(int(BAR * SR) + SR)
    for b in range(4):
        if kick:
            put(buf, tone(55, 0.3, 1.0, 14), b * BEAT)
        if hat:
            put(buf, noise(0.08, 0.35), b * BEAT + BEAT / 2)
        put(buf, tone(bass_notes[b], BEAT * 0.9, 0.5, 3), b * BEAT)
    if vocal:
        put(buf, tone(rng.choice([440, 523, 587]), BAR * 0.8, 0.35, 0.5), 0)
    return buf[: int(BAR * SR)]


def make_track(kind):
    """Return the track (8 bars = block A + block B) and whether block A is a good loop."""
    pat = list(rng.choice([41, 49, 55, 62], 4))
    A = [bar_audio(pat) for _ in range(4)]
    if kind == "good":
        B = [bar_audio(pat) for _ in range(4)]
    elif kind == "changes_bass":       # same drums, bass line is different in the next block
        B = [bar_audio(list(rng.choice([41, 49, 55, 62], 4))) for _ in range(4)]
    elif kind == "drops_drums":        # next block loses kick and hats
        B = [bar_audio(pat, hat=False, kick=False) for _ in range(4)]
    elif kind == "vocal_enters":       # next block gets a sung line on top
        B = [bar_audio(pat, vocal=True) for _ in range(4)]
    elif kind == "fill_in_last_bar":   # a drum fill replaces the last bar of the next block
        B = [bar_audio(pat) for _ in range(3)]
        fill = np.zeros(int(BAR * SR))
        for k in range(16):
            put(fill, noise(0.05, 0.6), k * BEAT / 4)
        B.append(fill)
    elif kind == "tempo_drift":        # the next block is 2% slower: beats slide off the grid
        B = [np.interp(np.arange(int(BAR * SR)) * 0.98, np.arange(int(BAR * SR)), bar_audio(pat)) for _ in range(4)]
    else:
        raise ValueError(kind)
    return np.concatenate(A + B), kind == "good"


def contour(x, fine=True):
    """Energy contour of a whole block at 16th-note resolution: log-spaced bins (finer in the bass, where a changed note lives)."""
    hop = int(BEAT / 4 * SR)
    n = x.size // hop
    edges = np.concatenate([np.geomspace(35, 160, 9), np.geomspace(160, 1600, 5)[1:], [1600, 5000]]) if fine else np.array([30, 150, 1500, 5000])
    out = np.zeros((len(edges) - 1, n))
    f = np.fft.rfftfreq(hop, 1 / SR)
    for i in range(n):
        seg = x[i * hop:(i + 1) * hop] * np.hanning(hop)
        sp = np.abs(np.fft.rfft(seg)) ** 2
        for j in range(len(edges) - 1):
            out[j, i] = sp[(f >= edges[j]) & (f < edges[j + 1])].sum()
    return np.log1p(out)


def score(track):
    """Correlation of the whole block's contour with the whole next block's contour (all bins at once)."""
    L = int(4 * BAR * SR)
    a, b = contour(track[:L]), contour(track[L:2 * L])
    x, y = (a - a.mean(axis=1, keepdims=True)).ravel(), (b - b.mean(axis=1, keepdims=True)).ravel()
    d = np.sqrt((x * x).sum() * (y * y).sum())
    return float((x * y).sum() / d) if d > 0 else 0.0



ALL_OK = True
for JITTER in (0.0, 0.3, 0.6):
    print(f"--- jitter {JITTER} ---")
    KINDS = ["good", "changes_bass", "drops_drums", "vocal_enters", "fill_in_last_bar", "tempo_drift"]
    res = {k: [] for k in KINDS}
    for k in KINDS:
        for _ in range(40):
            t, _good = make_track(k)
            t = t + rng.standard_normal(t.size) * 0.003  # a little room noise, so nothing is mathematically perfect
            res[k].append(score(t))
    good = np.array(res["good"])
    bad = np.concatenate([res[k] for k in KINDS[1:]])
    auc = float(np.mean([g > b for g in good for b in bad]))
    thr = float(np.percentile(good, 5))
    print(f"AUC good vs all bad: {auc:.3f}   threshold (5th percentile of good): {thr:.3f}")
    ok = auc >= 0.95
    for k in KINDS[1:]:
        caught = float(np.mean(np.array(res[k]) < thr))
        print(f"  {k:18s} caught {caught*100:5.1f}%   mean score {np.mean(res[k]):.3f}")
        ok &= caught >= 0.90
    print("good blocks kept:", f"{np.mean(good >= thr)*100:.1f}%", "mean", f"{good.mean():.3f}")
    print("PASS" if ok else "FAIL")

    ALL_OK &= ok
print("ALL LEVELS PASS" if ALL_OK else "SOME LEVEL FAILS")
