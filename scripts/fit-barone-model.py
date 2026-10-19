"""
v0.9.72/v0.9.74 experiment, step 2: can a model learned from Shalom's own "1" marks pick the bar line better than the shipped detectBarOne?

    python scripts/fit-barone-model.py [path/to/barone-all.json]      (default: %TEMP%/barone-all.json)

Input: what scripts/dump-barone-all.mjs wrote on the owner's PC (per-beat features + today's answer + his answer, per song).
Method: for each song, four candidates (the "1" on beat 0, 1, 2 or 3 of the detector's grid). Each candidate gets a feature vector
(how much stronger each band's energy, onset and half-beat onset are on that beat than on the others; how often a section
gets louder starting there; the chord change into it; today's detector vote). A conditional logit (softmax over the four) is fitted
with L2, scored by 10-fold cross-validation, so every song is predicted by a model that never saw it.

Pass rule (docs/handoff/v0.9.72.md): Hip Hop + Mizrahi accuracy >= 80% (today ~70%), and dance songs no worse than today minus one song.
numpy only.
"""
import json, os, sys
import numpy as np

PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get('TEMP', '.'), 'barone-all.json')
DANCE = {'House', 'Techno', 'Trance'}
WEAK = {'Hip Hop', 'HipHop', 'Mizrahi'}
WIN = 8  # beats either side for the "section gets louder here" feature (2 bars)


def phase_features(s):
    e = np.array(s['e'], float)    # [band][beat]
    on = np.array(s['on'], float)
    oh = np.array(s['oh'], float)
    flux = np.array(s['flux'], float)
    ch = np.array(s['chroma'], float)
    n = e.shape[1]
    if n < 4 * WIN:
        return None
    eps = 1e-9

    def ratio(x):  # x: [beat] -> per phase mean / overall mean
        tot = x.mean() + eps
        return [x[p::4].mean() / tot for p in range(4)]

    rows = [[] for _ in range(4)]
    for arr in (e, on, oh):
        for b in range(arr.shape[0]):
            r = ratio(arr[b])
            for p in range(4):
                rows[p].append(r[p])
    r = ratio(flux)
    for p in range(4):
        rows[p].append(r[p])
    # chord change into beat k
    nrm = ch / (np.linalg.norm(ch, axis=1, keepdims=True) + eps)
    cc = np.zeros(n)
    cc[1:] = 1 - (nrm[1:] * nrm[:-1]).sum(1)
    r = ratio(cc)
    for p in range(4):
        rows[p].append(r[p])
    # a section gets louder starting at beat k (energy of the next 2 bars over the previous 2), per band
    for b in range(e.shape[0]):
        c = np.concatenate([[0], np.cumsum(e[b])])
        rise = np.zeros(n)
        for k in range(WIN, n - WIN):
            after = (c[k + WIN] - c[k]) / WIN
            before = (c[k] - c[k - WIN]) / WIN
            rise[k] = max(0.0, after - before)
        top = rise >= np.quantile(rise, 0.9)  # only the strongest entries vote
        votes = np.array([top[p::4].sum() for p in range(4)], float)
        votes /= votes.sum() + eps
        for p in range(4):
            rows[p].append(votes[p])
    if VOCAL and 'v' in s:
        add_vocal(rows, s, ratio, n, eps)
    cur = s.get('current') or {}
    for p in range(4):
        hit = 1.0 if cur.get('beat') == p else 0.0
        rows[p] += [hit, hit * float(cur.get('margin', 0.0)), 1.0 if p == 0 else 0.0]
    return np.array(rows)


def votes_of(mask, eps=1e-9):
    v = np.array([mask[p::4].sum() for p in range(4)], float)
    return v / (v.sum() + eps)


def add_vocal(rows, s, ratio, n, eps):
    # v0.9.74: does singing start on the "1"? Same shape as the energy cues above, on the app's own singing detector per beat.
    v = np.array(s['v'], float)[:n]
    vl = np.array(s['vl'], float)[:n]
    vp = np.array(s['vp'], float)[:n]
    for x in (v, vl - vl.min(), vp):
        r = ratio(x)
        for p in range(4):
            rows[p].append(r[p])
    # singing starts: voice probability crosses 0.5 after two quiet beats. Vote for that beat and, separately, for the beat after
    # (a line sung from a pickup lands its first strong word one beat later).
    sing = vp >= 0.5
    start = np.zeros(n, bool)
    start[2:] = sing[2:] & ~sing[1:-1] & ~sing[:-2]
    after = np.zeros(n, bool)
    after[1:] = start[:-1]
    for mask in (start, after):
        vv = votes_of(mask)
        for p in range(4):
            rows[p].append(vv[p])
    # the strongest rises of the singing score, beat to beat
    d = np.zeros(n)
    d[1:] = np.maximum(0, v[1:] - v[:-1])
    vv = votes_of(d >= np.quantile(d, 0.9))
    for p in range(4):
        rows[p].append(vv[p])
    # singing gets stronger over 2 bars starting here
    c = np.concatenate([[0], np.cumsum(v)])
    rise = np.zeros(n)
    for k in range(WIN, n - WIN):
        rise[k] = max(0.0, (c[k + WIN] - c[k]) - (c[k] - c[k - WIN])) / WIN
    vv = votes_of(rise >= np.quantile(rise, 0.9))
    for p in range(4):
        rows[p].append(vv[p])


VOCAL = False


def fit(X, y, lam=1.0, iters=600, lr=0.1):
    # X: [songs][4][f]; standardised outside
    w = np.zeros(X.shape[2])
    for _ in range(iters):
        z = X @ w
        z -= z.max(1, keepdims=True)
        pr = np.exp(z)
        pr /= pr.sum(1, keepdims=True)
        onehot = np.zeros_like(pr)
        onehot[np.arange(len(y)), y] = 1
        grad = ((pr - onehot)[:, :, None] * X).sum((0, 1)) / len(y) + lam * w / len(y)
        w -= lr * grad
    return w


def main():
    global VOCAL
    songs = json.load(open(PATH, encoding='utf8'))
    has_vocal = any('v' in s for s in songs)
    if has_vocal:
        bad = [s for s in songs if 'v' in s and s.get('vocalError')]
        print(f'singing data: {sum("v" in s for s in songs)} songs, {len(bad)} where the detector gave no answer (their singing cues are all 0)')
        unknown = sorted({s.get('genre') or '(none)' for s in songs if 'v' in s and s.get('genreKnown') is False})
        if unknown:
            print(f'genres the singing model does not know (weaker singing cues there): {", ".join(unknown)}')
        print('--- without singing cues (v0.9.72) ---')
        run(songs, verdict=False)
        VOCAL = True
        print('--- with singing cues (v0.9.74) ---')
    run(songs, verdict=True)


def run(songs, verdict):
    data = []
    for s in songs:
        f = phase_features(s)
        if f is None or s.get('truthBeat') is None:
            continue
        data.append((s, f))
    skipped = len(songs) - len(data)
    X = np.stack([f for _, f in data])
    y = np.array([s['truthBeat'] for s, _ in data])
    genre = [s.get('genre') or '' for s, _ in data]
    cur = np.array([(s.get('current') or {}).get('beat', 0) for s, _ in data])
    rng = np.random.default_rng(7)
    folds = rng.permutation(len(y)) % 10
    pred = np.zeros(len(y), int)
    for k in range(10):
        tr, te = folds != k, folds == k
        mu = X[tr].reshape(-1, X.shape[2]).mean(0)
        sd = X[tr].reshape(-1, X.shape[2]).std(0) + 1e-9
        w = fit((X[tr] - mu) / sd, y[tr])
        pred[te] = ((X[te] - mu) / sd @ w).argmax(1)

    def report(name, mask):
        m = np.array(mask)
        if m.sum() == 0:
            return
        print(f'{name:22s} {m.sum():4d} songs   today {np.mean(cur[m] == y[m]) * 100:5.1f}%   learned {np.mean(pred[m] == y[m]) * 100:5.1f}%   first beat {np.mean(y[m] == 0) * 100:5.1f}%')

    print(f'{len(y)} songs used, {skipped} left out (too short or no answer)')
    report('all', [True] * len(y))
    report('dance (House/Techno/Trance)', [g in DANCE for g in genre])
    report('Hip Hop + Mizrahi', [g in WEAK for g in genre])
    report('other genres', [g not in DANCE and g not in WEAK for g in genre])
    mu = X.reshape(-1, X.shape[2]).mean(0)
    sd = X.reshape(-1, X.shape[2]).std(0) + 1e-9
    w = fit((X - mu) / sd, y)
    print(f'ceiling (trained and tested on the same songs, on purpose): {np.mean(((X - mu) / sd @ w).argmax(1) == y) * 100:.1f}%')
    if not verdict:
        return
    weak = np.array([g in WEAK for g in genre])
    dance = np.array([g in DANCE for g in genre])
    ok_weak = weak.sum() > 0 and np.mean(pred[weak] == y[weak]) >= 0.80
    ok_dance = (pred[dance] == y[dance]).sum() >= (cur[dance] == y[dance]).sum() - 1
    print('PASS' if ok_weak and ok_dance else 'FAIL', f'(Hip Hop+Mizrahi >= 80%: {ok_weak}; dance no worse than today minus one song: {ok_dance})')


if __name__ == "__main__":
    main()
