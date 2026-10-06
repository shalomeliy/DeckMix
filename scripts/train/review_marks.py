"""
v0.9.37 (06/10): the "maybe you marked this wrong" list for one genre, from fit-genre-marks.py --review=<list.json>.

The owner asked (06/10): learn from his Mizrahi marks when there is singing, then give him a list of songs where, by those conclusions, he
may have marked wrong — he listens, fixes or confirms, and only then are the conclusions used. His marks are the truth (he heard every
song); this list only points and asks, it never changes a mark.

Three kinds, each counted, the short ones too (nothing dropped silently):
  model    — a model that NEVER saw the song (leave-one-song-out, with its own shift) is sure of the opposite of his mark for at least MIN_SEC
             in a row: "you marked silence, I hear singing at 1:42-1:58" (or the reverse). Cells within EDGE of one of his edges are not
             counted: that is his reaction time, not a mistake. Shorter or less sure disagreements are counted as "left out", not listed.
  gap      — a stop of 2 s or less marked as silence between two sung parts. His own rule says that is still singing.
  phrase   — a mark that is not a whole number of 8-bar phrases after his previous one. Not a mistake in his marks (he marks where the voice
             is), but Mix Assist counts its 8-bar phrases from his marks (nextPhraseStartSec in src/core/vocal-handoff.ts), so these are where
             its count shifts. The bar length is the "- 128 BPM" in the song's name, else the one that puts every gap between his marks on
             whole bars (they are snapped to the yellow bar lines); a song where neither works is counted as "tempo unknown".
"""
import json, re
import numpy as np

SURE_VOICE, SURE_NONE = 0.75, 0.15  # how sure the held-out model must be (smoothed probability) to be listed
MIN_SEC = 4.0  # about two bars at Mizrahi tempos: a single sure bar was mostly a shout or a sung hook he chose not to count
GAP_SEC = 2.0  # his rule
PHRASE_BARS = 8  # vocal-handoff.ts PHRASE_BARS


def runs(x):
    out, s = [], 0
    for i in range(1, len(x) + 1):
        if i == len(x) or x[i] != x[s]:
            out.append((s, i, int(x[s])))
            s = i
    return out


def mmss(sec):
    return f"{int(sec // 60)}:{int(sec % 60):02d}"


def edges_of(regions, duration):
    """Times where his marks switch between voice and no voice, from the regions as he left them (black or purple)."""
    cells = np.zeros(int(duration / 0.05) + 1, np.int8)
    for r in regions:
        a, b = int(r["fromSec"] / 0.05), int(r["toSec"] / 0.05)
        cells[a:b] = 0 if r.get("kind") == "none" else 1
    return [a * 0.05 for a, _, _ in runs(cells)[1:]]


def bar_sec(name, edges):
    m = re.search(r"(\d{2,3}(?:\.\d+)?)\s*BPM", name, re.I)
    if m and 60 <= float(m.group(1)) <= 200:
        return 240 / float(m.group(1)), "name"
    diffs = [b - a for a, b in zip(edges, edges[1:]) if b - a > 1]
    if len(diffs) < 2:
        return None, None
    best = None
    for bar in np.arange(1.6, 2.9, 0.0005):
        err = max(abs(d / bar - round(d / bar)) * bar for d in diffs)
        if err < 0.06 and (best is None or err < best[1]):
            best = (bar, err)
    return (float(best[0]), "marks") if best else (None, None)


def write(path, genre, songs, Y, T, held, radius, edge, cell):
    items, left_out, tempo_unknown, phrase_checked = [], 0, 0, 0
    k = np.ones(2 * radius + 1)
    for h, s in enumerate(songs):
        y, t, p = Y[h], T[h], held[h]
        q = np.convolve(p, k, "same") / np.convolve(np.ones_like(p), k, "same")  # the strip's own smoothing
        near_edge = np.zeros(len(t), bool)
        for i in range(1, len(y)):
            if y[i] != y[i - 1]:
                near_edge[max(0, i - edge):i + edge] = True
        for want, sure in ((0, q >= SURE_VOICE), (1, q <= SURE_NONE)):
            flag = (t == want) & sure & ~near_edge
            for a, b, v in runs(flag.astype(np.int8)):
                if not v:
                    continue
                if (b - a) * cell < MIN_SEC:
                    left_out += 1
                    continue
                conf = float(np.mean(q[a:b]) if want == 0 else 1 - np.mean(q[a:b]))
                items.append({"kind": "model", "song": s["name"], "fromSec": round(a * cell, 1), "toSec": round(b * cell, 1),
                              "marked": "silence" if want == 0 else "singing", "model": "singing" if want == 0 else "silence",
                              "sure": round(conf, 3), "say": f"{mmss(a * cell)}-{mmss(b * cell)}: you marked {'silence' if want == 0 else 'singing'}, "
                                                            f"a model that never saw this song is {conf:.0%} sure of {'singing' if want == 0 else 'silence'}"})
        # his 2 s rule: silence of 2 s or less between two sung parts is still singing (T is his marks read with that rule)
        for a, b, v in runs(((y == 0) & (t == 1)).astype(np.int8)):
            if v:
                items.append({"kind": "gap", "song": s["name"], "fromSec": round(a * cell, 1), "toSec": round(b * cell, 1),
                              "say": f"{mmss(a * cell)}: a {(b - a) * cell:.1f} s silence between two sung parts; by your 2 s rule it counts as singing"})
        if not t.any():
            items.append({"kind": "model", "song": s["name"], "fromSec": 0, "toSec": round(len(t) * cell, 1), "marked": "silence",
                          "model": "-", "sure": 0, "say": "the whole song is marked without singing"})
        ed = edges_of(s["regions"], s["durationSec"])
        bar, how = bar_sec(s["name"], ed)
        if bar is None:
            tempo_unknown += 1
            continue
        phrase_checked += 1
        for a, b in zip(ed, ed[1:]):
            bars = (b - a) / bar
            off = bars - PHRASE_BARS * round(bars / PHRASE_BARS)
            if abs(off) > 0.25:
                items.append({"kind": "phrase", "song": s["name"], "fromSec": round(b, 1), "toSec": round(b, 1), "bars": round(bars, 2),
                              "barFrom": how, "say": f"{mmss(b)}: {bars:.0f} bars after your previous mark, not a whole number of 8-bar phrases"})
    order = {"model": 0, "gap": 1, "phrase": 2}
    items.sort(key=lambda it: (order[it["kind"]], -it.get("sure", 0), it["song"], it["fromSec"]))
    doc = {"genre": genre, "songs": len(songs), "items": items,
           "counts": {kind: sum(it["kind"] == kind for it in items) for kind in order},
           "leftOut": {"shortOrUnsure": left_out, "phraseTempoUnknown": tempo_unknown, "phraseChecked": phrase_checked},
           "rules": {"sureVoice": SURE_VOICE, "sureNone": SURE_NONE, "minSec": MIN_SEC, "edgeCells": edge}}
    json.dump(doc, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"review list {path}: {doc['counts']}; left out {doc['leftOut']}")
