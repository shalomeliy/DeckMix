# Downbeat detection for DeckMix: research report

*Written 2026-09-24. Read-only research. No code was changed. Scope: finding "beat 1 of the bar" (4/4) inside the browser, accurately and legally, for a proprietary product.*

**Owner constraint (added during the research):** DeckMix will **not** ship existing software or pretrained
models. We design and implement the feature ourselves from the published *ideas*. Papers and algorithms are
fine to learn from. Code and weights are not copied. So the survey of existing systems below is there as a
**yardstick and a source of ideas**, not a shopping list.

Notation: "F1" means the standard downbeat F-measure with a ±70 ms tolerance (mir_eval / MIREX convention),
0-1 or 0-100 as the source reports it. "UNVERIFIED" means I could not confirm it from a primary source.

---

## 0. TL;DR recommendation

**Key reframing.** DeckMix already has a **fixed-tempo grid** (`{bpm, offsetSec}`, see `src/core/beatgrid.ts`).
With a constant grid and 4/4, "find the downbeat" is **not** a frame-level detection problem. It is a
**4-way choice**: which of the 4 beat phases (beat index mod 4) is beat 1. That is a much easier problem than
the one the academic benchmarks measure, and it is a better fit for a small from-scratch implementation. It
also gives a natural confidence number: how clearly the winning phase beats the runner-up.

Ranked options, all built by us (the owner's constraint):

| # | Option | Expected accuracy (my estimate, to be measured) | Speed per 5-min track (Iris Xe laptop, estimate) | License / legal | Effort |
|---|---|---|---|---|---|
| **1 (do first)** | **Classical, no training.** Beat-synchronous cues (harmonic change, bass/kick re-entry, spectral difference, 8/16/32-bar phrase novelty) fused into a score for each of the 4 phases, decoded with a tiny beat-level HMM. Confidence = posterior margin. | EDM 4/4 (House/Techno/Trance): **~85-95%** of tracks with the correct bar phase, *if* the BPM octave is right. Hip-hop/pop: **~65-85%**. Mizrahi: **unknown, likely 60-80%**. The closest published classical baselines score much lower on *frame* F1 (Davies & Plumbley 0.46 on GTZAN), but they solve a harder problem: no fixed grid, and every genre. | < 1 s (one extra STFT pass + chroma; HMM with 4-8 states is negligible) | Own code. No third-party code or weights. **Patent watch:** AlphaTheta US11176915B2 and Yamaha US9378719B2 are active. See §8. | ~1 version |
| **2 (next)** | **Own tiny learned model, beat-synchronous**, in the style of Krebs et al. 2016: per-beat feature vectors → 2-layer bidirectional GRU (≈20-45k params) → downbeat probability per beat → the same HMM. Inference is hand-written in TS (no onnxruntime needed). | Krebs 2016 (the published ideas) reached a mean F1 of **90.4** with annotated beats and **77.3** with detected beats across 6 Western datasets. With DeckMix's fixed grid and EDM-heavy library, I expect a clear gain over #1 on hip-hop/pop/Mizrahi. | ~10-50 ms of inference. Feature extraction as in #1. | Own code **and own weights**, but it needs **legally clean training data**. That is the real cost. See §5. | 2-3 versions (data pipeline + labeling + training) |
| 3 (not now) | Own frame-level model (Beat This!-style transformer, 2-20M params) run through onnxruntime-web or hand-written kernels. | Beat This! (the published system): GTZAN downbeat F1 **78.3** (20M) / **77.2** (2M). | My estimate: 5-40 s per track on WASM (the frontend dominates cost, so "small" is not 10× faster). WebGPU is faster but UNVERIFIED on Iris Xe. | Needs ~4,500 annotated tracks and GPU training. The legally clean data does not exist at that scale. | Large |

**Not usable under the owner's constraint (shown for reference):** madmom models (CC BY-NC-SA, non-commercial),
Essentia (AGPL code, CC BY-NC-ND models), qm-dsp (GPL). Also excluded by policy, though license-clean:
Beat This! (MIT code *and* weights), All-In-One (MIT code and weights, but needs Demucs + NATTEN), BeatNet
(CC BY 4.0, but depends on madmom).

**Ground truth first.** Before building anything, have the owner label the bar phase on **100-150 tracks** of
his own library, stratified by genre. It is a 4-choice task per track, about 10-20 s each. The existing
`setDownbeatAt` tool is almost enough. Other programs' grids are **not** reliable ground truth on their own (§6).

**The one thing that breaks everything:** a wrong tempo octave (e.g. DnB at 87 vs 174, hip-hop at 90 vs 180).
The bar is 4 beats at the *right* metrical level. The detector must see the tempo octave as an input it can
doubt (§7).

---

## 1. State of the art: what the published systems score

### 1.1 Results table (numbers copied from the primary sources)

| System (year) | Core idea | Downbeat F1 | Where the number comes from |
|---|---|---|---|
| Davies & Plumbley (2006) | Beat-synchronous spectral difference (classical) | GTZAN **0.462**, Klapuri 0.528 | Böck et al. 2016, Table 2 |
| Klapuri et al. (2006) | Comb-filter resonators + probabilistic meter model (classical) | GTZAN **0.309**, Klapuri 0.483 | Böck et al. 2016, Table 2 |
| Peeters & Papadopoulos (2011) | HMM with beat template + chroma variation + spectral balance (classical) | RWC Pop **0.800**, Hainsworth 0.630 | Böck et al. 2016, Table 3 |
| Durand et al. (2016) | Feature-adapted CNN ensemble + Viterbi | GTZAN **0.624** | Böck et al. 2016, Table 2 |
| **Böck, Krebs, Widmer (2016), madmom joint** | BLSTM (3×25 units) on multi-resolution spectrogram → bar-pointer DBN | GTZAN **0.640**; Ballroom 0.863; Beatles 0.832; RWC Pop 0.861 (cross-validation) | [ISMIR 2016 paper](https://archives.ismir.net/ismir2016/paper/000186.pdf), Tables 2-3 |
| Krebs, Böck, Dorfer, Widmer (2016) | **Beat-synchronous** percussive + chroma features → 2 small BiGRUs → beat-level DBN | Mean over 6 Western sets: **90.4** (annotated beats), **77.3** (detected beats). RNN without DBN: 85.0 / 73.7 | [ISMIR 2016 paper](https://archives.ismir.net/ismir2016/paper/000249.pdf), Table 2 |
| MIREX 2016 "BK4" (Böck/Krebs joint tracker) | same as madmom joint | **HJDB (hardcore/jungle/DnB): 0.970**; Ballroom 0.908; Beatles 0.865 | [MIREX 2016 results](https://music-ir.org/mirex/wiki/2016:Audio_Downbeat_Estimation_Results) |
| MIREX 2016 "KB1" (Krebs/Böck rhythmic-pattern HMM) | rhythmic-pattern bar-pointer model | HJDB 0.690; Ballroom 0.898 | same |
| BeatNet (Heydari et al. 2021), online | CRNN + two cascaded particle filters | GTZAN **46.49** (online); 54.07 offline with DBN | [arXiv 2108.03576](https://arxiv.org/abs/2108.03576), Table 2 |
| 1D state space (Heydari et al. 2022), online | semi-Markov "jump-back" 1D state space | GTZAN **42.57**, 30× faster than BeatNet (0.29 s vs 8.87 s per 30 s excerpt) | [arXiv 2111.00704](https://arxiv.org/abs/2111.00704), Table 1 |
| Böck & Davies 2020 TCN (reproduced) | TCN multi-task | GTZAN **0.672** | Beat Transformer paper, Table 1 |
| Beat-Transformer (Zhao et al. 2022) | Transformer on 5 Spleeter stems, dilated attention | GTZAN **0.714**; Harmonix 0.898 | [arXiv 2209.07140](https://arxiv.org/abs/2209.07140); Harmonix figure from All-In-One Table 1 |
| Hung et al. (2022) | Spectro-temporal transformer + DBN | GTZAN **0.756** | Beat This! paper, Table 2 |
| All-In-One (Kim & Nam 2023) | Neighbourhood attention on 4 Demucs stems, 300K params, DBN | Harmonix **0.915** (8-fold CV) | [arXiv 2307.16425](https://arxiv.org/abs/2307.16425), Table 1 |
| **Beat This! (Foscarin, Schlüter, Widmer 2024)** | 20M-param transformer, shift-tolerant loss, **no DBN** | GTZAN **78.3 ± 0.4**; small (2M) 77.2; with DBN 77.4. CV: Harmonix 90.7, **HJDB 96.6**, Ballroom 95.3 | [arXiv 2407.21658](https://arxiv.org/abs/2407.21658), Tables 1-2 |
| BEAST (2023/24), online streaming transformer | streaming transformer | downbeat 46.78 (online) | [arXiv 2312.17156](https://arxiv.org/abs/2312.17156) (abstract, via search. UNVERIFIED in full text) |

Recent directions (2025-2026) with no downbeat numbers checked: "Beat Tracking as Object Detection"
([arXiv 2510.14391](https://arxiv.org/abs/2510.14391)), and "Masked diffusion enables coherent beat tracking"
([arXiv 2608.04624](https://arxiv.org/abs/2608.04624), ISMIR 2026, Foscarin/Korzeniowski/Vogl), which targets
exactly the "consecutive downbeats / erratic tempo" failures of DBN-free models.

### 1.2 EDM specifically: the most important finding

**Raveform** (Kim, Kim, Kim, Nam, *TISMIR* 9(1), April 2026, [paper](https://transactions.ismir.net/articles/10.5334/tismir.288), [site](https://mir-aidj.github.io/raveform/))
is the only large EDM-specific evaluation I found: 1,423 EDM tracks from DJ mixes, annotated with beats,
downbeats and EDM section labels. Its results table, read as "first 4 rows = Harmonix test set, last 4 =
Raveform test set" (my reading of the extracted table):

| Trained on | Model | Downbeat F1 on **pop** (Harmonix) | Downbeat F1 on **EDM** (Raveform) |
|---|---|---|---|
| Harmonix (pop) | All-In-One | 0.915 | **0.753** |
| Raveform (EDM) | All-In-One | 0.727 | **0.965** |
| Both | All-In-One | 0.921 | **0.967** |
| 10 datasets, no EDM | madmom | 0.805 | **0.669** |

Three lessons for DeckMix:
1. **General-purpose downbeat trackers are weak on modern club EDM** (0.67-0.75). This is not an
   architectural limit. The authors attribute it to training data: madmom was "trained on 10 datasets covering various
   genres except EDM". In EDM the cue for "beat 1" is structural (phrase entries, drops, fills), not
   harmonic. A four-on-the-floor kick makes all 4 beats look alike locally.
2. **EDM-aware models reach ~0.97.** So EDM downbeats *are* learnable and quite regular. That supports a
   phrase-structure-driven classical approach (§2.3).
3. Raveform confirms the phrase prior: the most common EDM segment length is **16 bars (~30 s)**, and
   changes "tend to occur at multiples of four or eight measures". That is the cue option #1 relies on.

Older EDM evidence: HJDB (236 excerpts of 80s/90s hardcore, jungle, drum & bass) scores 0.97 (MIREX 2016
BK4) and 96.6 (Beat This!, cross-validation, so HJDB was in training). Breakbeat genres are
not House/Techno, but they show that electronic music with a strong drum identity is tractable.

Harmonix Set composition (counted from its `metadata.csv`, 912 tracks): Pop 422, **Hip-Hop 140**,
**Dance/Electronic 129**, Country 39, Rock 36, and others. Time signatures: 890 in 4/4, 14 in 6/8, 4 in 3/4.

**Hip-hop / pop.** No hip-hop-only downbeat benchmark was found. Harmonix (≈15% hip-hop, ≈46% pop) gives
0.90-0.92 for the best learned systems. The classical systems are much lower on mixed-genre GTZAN (0.31-0.46).
**Mizrahi / Middle-Eastern pop:** no benchmark found (UNVERIFIED territory). The closest evidence is that
learned systems drop sharply on non-Western meters (Böck 2016: Turkish 0.495 with 3/4+4/4 models), but
most Mizrahi pop is in a Western 4/4 pop production frame. Treat it as an open measurement question.

---

## 2. Classical / heuristic methods runnable in pure TS

### 2.1 The published classical ideas

- **Beat-synchronous spectral difference** (Davies & Plumbley, EUSIPCO 2006, "A spectral difference approach
  to downbeat extraction in musical audio"). Given beats, compute a spectrum per beat. The QM Vamp
  documentation says the audio is downsampled to 2.8 kHz. The downbeat phase is the one where the change between
  consecutive beat spectra is largest on average. The QM "Bar and Beat Tracker" docs describe the
  divergence as Jensen-Shannon. Böck 2016 describes it as Kullback-Leibler between band-limited frames, noting
  "lower frequency bands are perceptually more important"
  ([QM Vamp docs](https://vamp-plugins.org/plugin-doc/qm-vamp-plugins.html)). **Idea free to use. The qm-dsp code is GPL-2.0.**
- **Chord-change and drum-pattern cues** (Goto 2001, *JNMR*: chord changes and bass/snare patterns
  mark measures). Harmonic changes tend to fall on downbeats in Western pop.
- **Joint HMM with beat template + chroma variation + spectral balance** (Peeters & Papadopoulos, IEEE TASLP 2011).
  RWC Pop 0.80.
- **Rhythmic-pattern bar-pointer model** (Krebs, Böck, Widmer, ISMIR 2013): GMMs over 2-band onset features
  at 64 positions per bar, learned per rhythm pattern. It needs (small) training.
- **Genre-specific breakbeat regression** (Hockman, Davies, Fujinaga, ISMIR 2012, "One in the jungle").
- **Nokia's combination** (chord-change likelihood + two accent-based downbeat likelihoods, LDA, summed per
  beat phase). Published as patents US9653056B2 / EP2845188B1, which are **expired / not in force** (§8), so it
  is freely usable. It is also exactly the "score each phase, pick the max" shape recommended here.

### 2.2 What DJ software does

*(Removed in v0.12.3 at the owner's request: no names of, links to, or comparisons with other DJ software.)*

What stays: code under the GPL (for example `qm-dsp`) must not be copied or ported. The ideas are
published in papers and can be reimplemented from those papers.

### 2.3 Proposed from-scratch classical pipeline (Option 1). Enough detail to implement.

**Inputs we already have:** fixed grid `{bpm, offsetSec}`, decoded PCM in the worker, the 200 fps kick-band
onset envelope (`buildOnsetEnvelope` in `src/platform/analyzer-js/analyze.ts`) and 3-band RMS.

**Step A: beat times.** `t_k = offsetSec + k·T`, with `T = 60/bpm`, for k = 0..K-1 across the whole track.

**Step B: beat-synchronous features.** This follows Krebs et al. 2016's recipe, adapted. The recipe computes
features at frame rate and then averages them within windows of length T/n centred on beat subdivisions.
- *Percussive, per band b ∈ {low, mid, high}:* positive spectral flux (or the existing positive-difference
  envelope) averaged in 4 sub-beat windows per beat → `P_k ∈ R^{3×4}`.
- *Harmonic:* 12-bin chroma from an STFT. The paper uses CLP chroma. A plain log-compressed, L2-normalized
  pitch-class projection of a 4096-sample STFT over 60 Hz-5 kHz is a simpler start. Average over 2 half-beat
  windows → `C_k ∈ R^{2×12}`.
- *Energy:* mean RMS per band per beat → `E_k ∈ R^3` (derivable from existing `bands`).

**Step C: per-beat cue curves** (each z-scored over the track):
1. *Harmonic change:* `H_k = 1 − cos(mean(C_{k−2}, C_{k−1}), mean(C_k, C_{k+1}))`. Chord changes land on beat 1.
2. *Spectral difference* (Davies & Plumbley): `D_k = JS(p_{k−1} ‖ p_k)`, where `p_k` is the normalized
   low-passed magnitude spectrum of beat k.
3. *Bass / low-band re-entry:* `R_k = max(0, Ē_low[k..k+3] − Ē_low[k−4..k−1])`. The kick or bass returns on a
   bar (and phrase) start after a break.
4. *Phrase novelty* (Foote 2000 checkerboard kernel on a beat-level self-similarity matrix of
   `[E_k, P_k, C_k]`, kernel half-width 8 and 16 beats): `N_k` peaks at section changes. In EDM they fall
   on downbeats, and usually on 16- or 32-bar phrase starts (Raveform).
5. *Crash / high-band accent:* positive jump in high-band flux at sub-beat 0 relative to the bar mean. Crashes
   and risers resolve on beat 1 of a phrase.

(Deliberately **not** used as a hand rule: "the kick one beat before a snare starts the bar". That is close to
the claim of an active AlphaTheta patent, §8. Backbeat information may still reach a *learned* model as generic
features. Get a lawyer's opinion before shipping anything close to it.)

**Step D: score the 4 phases.** For φ ∈ {0,1,2,3}:

```
S(φ) = Σ_c w_c · mean_{k ≡ φ (mod 4)} cue_c[k]
P(φ) = softmax(β · S)_φ          // calibrated on the owner's labels (β, w_c fitted by logistic regression)
```

Add a **phrase term**. For φ16 ∈ {0..15}, count novelty peaks `N_k` with `k ≡ φ16 (mod 16)`, weighted by peak
height. Then marginalize to φ = φ16 mod 4. That gives a 16-bar phrase phase too: a free "phrase start"
feature that `src/core/structure.ts` can reuse.

**Step E: beat-level HMM, for local robustness and phase slips.** This is the Krebs et al. 2016 language model,
simplified. State = beat counter b ∈ {1..4} (optionally r ∈ {3,4} for rare 3/4 tracks). Transitions:

```
P(b_k | b_{k−1}) = 1 − p_slip   if b_k = (b_{k−1} mod 4) + 1
                 = p_slip / 3   otherwise          // Krebs used strict cycling (p_slip = 0)
                                                    // and p_r = 1e−7 for meter changes
Observation: P(o_k | b_k = 1) ∝ λ · a_k ,  P(o_k | b_k > 1) ∝ (1 − a_k)
             with a_k = σ(Σ_c w_c cue_c[k]) and λ ≈ 100 in Krebs 2016 (a prior correction, tune it)
```

Run Viterbi for the labels and forward-backward for posteriors. With 4-8 states and ~600 beats this costs
microseconds. A small `p_slip` (e.g. 1e−4) lets the model find edits where a bar was cut. That is new
behaviour, and it must be *surfaced* ("phase changes at 2:14"), not silently applied, because the grid
model is `{bpm, offsetSec}` with one phase.

**Pseudocode (TypeScript-shaped):**

```ts
function downbeatPhase(beats: BeatFeatures[], w: Weights): { phase: 0|1|2|3; posterior: number[]; margin: number } {
  const cues = computeCues(beats)            // H, D, R, N, X as z-scored Float32Arrays
  const a = beats.map((_, k) => sigmoid(dot(w, cuesAt(cues, k))))
  const post = forwardBackward4(a, { lambda: 100, pSlip: 1e-4 }) // P(b_k = 1) per beat
  const S = [0, 1, 2, 3].map((phi) => meanLog(post, (k) => k % 4 === phi))
  const P = softmax(S, w.beta)
  const order = [0, 1, 2, 3].sort((i, j) => P[j] - P[i])
  return { phase: order[0], posterior: P, margin: P[order[0]] - P[order[1]] }
}
```

**Expected accuracy (my estimate, not a measurement).** On 4/4 club EDM with the correct tempo octave, the
phrase and re-entry cues are strong and redundant, so I expect roughly 85-95% of tracks with the right
phase. Hip-hop and pop rely on the harmonic and spectral cues. The published classical systems in that
regime score 0.46-0.80 frame F1 without a fixed grid, and a fixed grid removes most of their failure modes
(tempo drift, octave errors inside the track). Hence my 65-85% track-level estimate. **These numbers are
hypotheses to measure on the owner's labeled set (§6), and the report should be updated with the
measured numbers.**

---

## 3. How the learned systems work (for reimplementing the ideas)

### 3.1 The bar-pointer model and the madmom DBN (Whiteley et al. 2006; Krebs et al. 2015; Böck et al. 2016)

Hidden state per audio frame k: `s = (φ, φ̇, r)`. `φ` is the position inside the bar (1..Φ), `φ̇` the tempo
(bar-position increment per frame), and `r` the meter. Krebs 2015's efficient state space gives each tempo
exactly as many position states as its beat period has frames: `Φ(φ̇) = beats_per_bar × round(frames per beat)`.
Tempi are spaced logarithmically, N = 60 tempo states (Böck 2016: "a good compromise between computation time
and performance").

- **Position transition:** `φ_k = φ_{k−1} + 1` (mod bar length) at a fixed tempo.
- **Tempo transition:** only at beat boundaries, exponential in the tempo ratio (Krebs 2015):
  `P(φ̇_k = j | φ̇_{k−1} = i) ∝ exp(−λ · |τ_j/τ_i − 1|)`, where `τ` is the beat interval. madmom default
  `TRANSITION_LAMBDA = 100` (from `madmom/features/downbeats.py`: `MIN_BPM = 55.`, `MAX_BPM = 215.`,
  `NUM_TEMPI = 60`, `OBSERVATION_LAMBDA = 16`, `THRESHOLD = 0.05`).
- **Observation** (Böck 2016, Eq. 1): given the network's per-frame downbeat, beat and non-beat
  probabilities `d_k, b_k, n_k`:
  `P(o_k|s_k) = d_k` if `s_k ∈ D` (downbeat states), `b_k` if `s_k ∈ B` (beat states),
  `n_k / (λ_o − 1)` otherwise. `λ_o = 16` controls what fraction of each beat period counts as "on the beat".
- **Inference:** Viterbi for the MAP sequence. Downbeats are the frames in D. Each is then refined to the
  activation maximum within a window of Φ/λ_o. Activations below θ = 0.05 at the start and end are trimmed
  (intros and fade-outs hurt).
- **Gain from the DBN:** "about 15% F-measure" over thresholding plus peak picking (Böck 2016, footnote 1).
- **Size for DeckMix:** at 100 fps and 55-215 BPM the bar state space has roughly 10⁴ states. Viterbi over
  30k frames is ~3·10⁸ simple ops, which is feasible in a worker but **unnecessary**: DeckMix's grid already fixes
  tempo and beat phase, so the beat-level HMM of §2.3 Step E is the right reduction.

### 3.2 Krebs et al. 2016: downbeats from known beats (the blueprint for Option 2)

- Features per beat: log-filtered spectral flux, 6 bands per octave, 30 Hz-17 kHz = 45 bins × 4 sub-beats = 180
  dims (percussive). CLP chroma, 12 × 2 half-beats (harmonic). "The time unit modelled by the RNNs is the beat period."
- Networks: 2-layer **bidirectional GRU, 25 units per layer**, sigmoid output. About **44k params** (rhythmic) and
  **19k** (harmonic). The two outputs are averaged.
- DBN at beat level: beat counter b ∈ {1..N_r}, deterministic cycling, meter change probability p_r = 10⁻⁷,
  observation scaling λ = 100 for downbeat states. Uniform initial distribution, Viterbi decoding.
- Results: RNN+DBN mean F1 90.4 (annotated beats) / 77.3 (detected beats). Most errors come from beat-tracker
  octave errors, as the paper's own error analysis says.

This matches DeckMix's situation almost exactly: beats come from our own grid, and only the bar position is
missing.

### 3.3 BeatNet: particle filtering (Heydari, Cwitkowitz, Duan, ISMIR 2021)

Two cascaded sequential Monte Carlo filters over a bar-pointer-like space. Beat filter:
`φ_{b,k} = (φ_{b,k−1} + φ̇_{b,k−1}) mod (φ_b^max + 1)`. Tempo jumps only at `φ_{b,k} = 0` with
`∝ exp(−λ_b |φ̇_k/φ̇_{k−1}|)` (as printed). Observation `max(b_k, d_k)` if it reaches T = 0.4 at a beat state,
else γ = 0.03. Resampling runs only when that "information gate" opens. The downbeat/meter filter runs once
per detected beat, over beat-in-bar phase and meter ∈ {2..}, with observation `d_k` at φ_d = 0 and `b_k`
otherwise. It is **causal (online)**, which DeckMix does not need, and its downbeat F1 is low (46.5 GTZAN online).
Useful only if DeckMix ever needs live input (e.g. a turntable or line-in).

### 3.4 Beat This! (Foscarin, Schlüter, Widmer, ISMIR 2024)

- Input: 22.05 kHz mono, 128-band mel 30 Hz-10 kHz, window 1024, hop 441 (**50 fps**), `ln(1 + 1000x)`.
- Frontend: a stem (per-band BatchNorm, 3×4 conv, freq-stride 4, 32 ch), then 3 blocks of
  {frequency-directed transformer, time-directed transformer, strided conv halving bands and doubling channels} →
  T×4×256 → linear to 512.
- 6 transformer blocks (512-d, 16 heads of 32, rotary position embeddings, sigmoid gating, FF 2048).
  "Small" = 128-d, 4 heads, ≈2M params.
- **Sum head:** the beat logit is beat_layer + downbeat_layer, so a downbeat implies a beat.
- **Shift-tolerant weighted BCE:** `L = −Σ_t [ w·y_t·log(m7(ŷ)_t) + (1 − m13(y)_t)·log(1 − m7(ŷ)_t) ]`, where
  `m_k` is max-pooling over k frames, and `w` = negatives/positives. This was the ablation's most impactful choice
  (no shift tolerance: downbeat 85.4 → 82.2; also dropping the weights → 68.7).
- Post-processing: local max within ±3 frames and p > 0.5, then snap each downbeat to the nearest beat.
  30 s chunks.
- Augmentation: time-stretch ±4-20%, pitch −5..+6 semitones (the most important augmentation), and masking
  (0-6 areas of 0.5-2 s with shuffled pieces).
- Training: 4,556 tracks from 16 datasets, 100 epochs, about 8 h on one RTX 2080 Ti.
- Takeaway for us: the **loss and augmentation ideas transfer** to a small beat-synchronous model. The
  architecture itself is too expensive for what DeckMix needs (a 4-way choice).

### 3.5 All-In-One and Beat-Transformer

Both depend on **source separation** (Demucs, 4 stems / Spleeter, 5 stems) plus attention. All-In-One is only
300K params, but Demucs costs far more than the tracker, and NATTEN is a custom CUDA op. Neither is viable in a
browser on an Iris Xe. The idea worth keeping is that per-stem input helps, and the cheap version we already have
is the 3-band split.

---

## 4. Browser deployment of small neural models (ONNX / WASM / WebGPU)

Relevant even with our own model, for Option 3 or if Option 2 grows.

- onnxruntime-web: **MIT** ("MIT License / Copyright (c) Microsoft Corporation",
  [LICENSE](https://raw.githubusercontent.com/microsoft/onnxruntime/main/LICENSE)). Backends: wasm (CPU,
  SIMD + threads), webgpu, webgl, webnn ([docs](https://onnxruntime.ai/docs/tutorials/web/)). Using the
  *runtime* is a library dependency, not a pretrained model. Whether that is acceptable under the "no existing
  software" rule is an open question for the owner (§10). For a 20-50k-param GRU, hand-written TS is simpler and
  needs no dependency.
- Third-party ONNX exports of Beat This! exist:
  [aaatmy/beat-this-onnx](https://huggingface.co/aaatmy/beat-this-onnx) (final0, FP32, opset 17, 82,098,846 bytes,
  input `[1, frames, 128]` log-mel, outputs `beat`/`downbeat` `[1, frames]`),
  [05Narwhal/lumen-models](https://github.com/05Narwhal/lumen-models) (small0, 9,274,894 bytes, "matches PyTorch within
  2.2e-6"), and [mosynthkey/beat_this_cpp](https://github.com/mosynthkey/beat_this_cpp) (MIT, final0, about 97 MB, includes a
  C++ reimplementation of madmom's DBN). None publish CPU timings. **Excluded by the owner's policy.** Listed
  only as proof that such models can be exported to ONNX.
- **Cost estimates (mine, from the published architecture, not measured).** Beat This! main is about 43M MAC per
  frame (transformer ≈ 28M, frontend ≈ 15M). At 50 fps × 300 s that is ≈ 1.3 TFLOP per 5-min track; at an
  assumed 30-100 GFLOPS effective for WASM SIMD+threads on a 13th-gen U-series CPU, that is **~13-45 s**. The small
  model only shrinks the main transformer, so the frontend dominates: ≈ 18M MAC/frame, ≈ 0.55 TFLOP, **~5-20 s**.
  A Krebs-style beat-level BiGRU (≈ 60k params × ~600 beats × 2 directions) is ≈ 0.1 GFLOP, **well under 50 ms**
  in plain TS. That is the gap that makes Option 2 attractive.

---

## 5. Training our own small model: what it would take

### 5.1 Model and compute
- **Model:** beat-synchronous BiGRU (2 × 25 units) or a 1-D CNN over a 16-32-beat window. Input is 3-band flux at
  4 sub-beats + 12-d chroma at 2 half-beats + 3-band energy, roughly 40-60 dims per beat. Output is P(downbeat)
  per beat. About 20-60k params, about 100-250 KB as float32.
- **Loss:** weighted BCE (w = negatives/positives ≈ 3 for 4/4), or 4-way softmax over bar position. Beat This!'s
  shift tolerance is unnecessary at beat resolution.
- **Augmentation:** pitch shift ±5 semitones (applied to chroma as a circular rotation, which is free), time-stretch (free:
  features are beat-synchronous), random crop of 16-64 beats, random start phase.
- **Training compute:** at beat resolution a 1,000-track corpus is ≈ 500k beat vectors. That is minutes on a laptop
  CPU. Training tooling (Python/PyTorch or a TS trainer) runs offline at development time and is never shipped.
  Whether offline Python tooling is acceptable is an owner question.
- **Data size needed (estimate):** Krebs 2016 trained on ~1.7k excerpts. For a 4-way phase problem with a
  structured model, **300-1,000 tracks** is a reasonable target, with at least 100 per target genre (House, Techno, Trance,
  Hip-hop, Mizrahi).

### 5.2 Data whose license permits **commercial** training (each verified where marked)

| Source | Audio included? | Beats/downbeats? | License (verified quote) | Fit |
|---|---|---|---|---|
| **Slakh2100** (MERL / Northwestern) | Yes, 145 h synthesized multitrack, 104 GB | Derivable from the aligned MIDI (tempo + time-signature meta) | Zenodo record: "Creative Commons Attribution 4.0 International" ([zenodo 4599666](https://zenodo.org/records/4599666)) | Good volume. Pop/rock-like, not EDM. **Caveat:** the Lakh MIDI source says "I did not transcribe any of the MIDI files", and the underlying compositions are copyrighted songs. Legal review advised. |
| **Groove MIDI Dataset** (Google) | Yes, synthesized drums, 13.6 h | Yes, tempo-aligned, >22k measures | "made available by Google LLC under a Creative Commons Attribution 4.0 International (CC BY 4.0) License" ([Magenta](https://magenta.tensorflow.org/datasets/groove)) | Drums only. Good for the percussive branch. |
| **GuitarSet** | Yes | "beats, downbeats, and playing style" | "Creative Commons Attribution 4.0 International" ([zenodo 3371780](https://zenodo.org/records/3371780)) | Solo guitar. Harmonic branch only. |
| **Synthetic EDM we generate ourselves** | Yes, rendered from our own patterns with CC0 or self-made samples | Exact by construction | Ours (sample licenses must allow ML training; check each pack) | **Best fit for House/Techno/Trance.** Phrase structure (16/32 bars, breakdowns, drops, fills, crashes on 1) can be generated. Risk: the synthetic-to-real gap, so always validate on real tracks. |
| **Harmonix Set annotations** | No (YouTube links + mel spectrograms) | Yes | Repo "MIT License / Copyright (c) 2019 Oriol Nieto" ([LICENSE](https://raw.githubusercontent.com/urinieto/harmonixset/main/LICENSE)) | Annotations are free to use, but the **audio is copyrighted** and not licensed for training. |
| **Raveform annotations** | No (DJ-mix links) | Yes, plus EDM section labels | HF dataset tag "cc-by-4.0" ([HF](https://huggingface.co/datasets/taejunkim/raveform)). Code repo MIT. | Same as Harmonix: the audio is copyrighted. **Best EDM evaluation reference.** |
| **Owner's own library + owner labels** | Yes (his purchased files) | From his labels | Copyrighted works | Evaluation: fine (personal use). **Training a model we then sell** is a legal question. Israel's Ministry of Justice opinion (Dec 2022) says ML training is "likely" fair use, with caveats ([law.co.il summary](https://www.law.co.il/en/news/2022/12/22/fair-use-of-copyrighted-content-for-aiml-training/), [Herzog summary](https://herzoglaw.co.il/en/news-and-insights/ministry-of-justice-opinion-on-the-use-of-copyrighted-works-for-machine-learning-purposes/)). EU/US positions differ. **Ask a lawyer.** |
| GTZAN, Ballroom, Beatles/Isophonics, RWC, HJDB, SMC, Hainsworth | Copyrighted audio. RWC requires a research agreement. HJDB audio availability UNVERIFIED. | Yes | No commercial license (Beat This! README: "some of the training files are fully copyrighted or under limited Creative Commons licenses") | **Not for commercial training.** Evaluation-only at most, and only if we had the audio legally. |

**Pseudo-labels from a permissive model** (e.g. running Beat This!, which is MIT, over a CC-licensed or owned corpus to create
training labels) would be *legally* permitted by MIT, but it conflicts with the owner's "not using pretrained models"
policy. Listed as an owner decision.

### 5.3 In-browser cost of our own model
Feature extraction is shared with Option 1 (≈ 1 STFT pass: at 22.05 kHz/hop 441, 15k frames × 2048-pt FFT is
≈ 1-2 GFLOP, about 0.3-1 s in a worker, estimate). Inference is < 50 ms. Weights of 100-250 KB ship as a static asset
or a TS constant. No onnxruntime is needed. The same TS runs inside the Tauri webview for v1.0, or can be
ported to Rust.

---

## 6. Ground truth: measuring accuracy on the owner's library

### 6.1 Other programs' grids as labels

*(Removed in v0.12.3 at the owner's request: no names of, links to, or comparisons with other DJ software.)*
What stays: grids analysed automatically by another program are a biased proxy (they tend to put bar 1 on
the first transient), not ground truth. Only grids the owner fixed by hand are candidate labels.

### 6.2 Recommended protocol
1. **Owner labeling:** 100-150 tracks, stratified (about 25 each of House, Techno, Trance, Hip-hop, Mizrahi).
   In-app: play from a bar that is claimed to be beat 1, and the owner picks which of 4 marked beats is "1".
   About 15 s per track, so about 40 minutes in total. Re-label 20 tracks a week later to measure his own consistency.
2. **Metric:** *track-level bar-phase accuracy* (the fraction of tracks where the predicted phase ≡ the true phase mod 4),
   reported per genre, plus coverage-vs-accuracy at confidence thresholds (§7). Also report mir_eval-style downbeat F1
   so the numbers can be compared with the literature.
3. **Free extra labels:** intersect the owner's library with the Harmonix (Dance/Electronic 129, Hip-Hop 140) and
   Raveform track lists by artist/title. For overlaps, the published annotations can be aligned to his copy
   (Harmonix ships alignment tools). Raveform annotates tracks *inside DJ mixes*, so alignment is harder (UNVERIFIED).
4. Record numbers the v0.1.7 way (a Node script on `C:\Users\Shalom\Music\Tracks` with numbers written down).

### 6.3 Public datasets with downbeat annotations for EDM
Raveform (1,423 EDM tracks, CC BY 4.0 annotations, 2026). HJDB (236 breakbeat excerpts; annotations in the Beat This!
annotation repo). Harmonix (129 Dance/Electronic of 912, MIT annotations). None ships audio under a license that
permits commercial training. GiantSteps has tempo and key only, no downbeats.

---

## 7. Confidence: knowing when the detector is unsure

1. **Phase posterior margin.** `m = P(φ̂) − P(φ₂)` from §2.3 Step D (or the HMM's forward-backward marginals averaged per
   phase). This matches the existing `peakToMeanRatio`/`CONFIDENCE_RATIO` pattern in `src/core/beatgrid.ts`.
2. **Cue agreement.** Run each cue family (harmonic, low-band re-entry, spectral difference, phrase novelty)
   separately. If ≥ 3 of 4 agree, confidence is high. If harmonic and phrase cues disagree, flag the track.
3. **Temporal consistency.** Decode the first and second halves (or each 32-bar section) separately. Disagreement
   means either an edit (a real phase slip) or noise. Either way, surface it.
4. **Tempo-octave check.** Rerun at 2×/½× BPM. If the bar phase at the half tempo is more confident, the tempo
   octave is probably wrong. Flag it, don't guess. Beat This! notes that networks get overconfident, and Krebs 2016
   traces most downbeat errors to beat-level octave errors.
5. **Calibration.** Fit β (softmax temperature) and the thresholds on the owner's labels. Choose the "confident" cut
   so that confident tracks are ≥ 97% correct, and report the coverage. Show a reliability plot in the
   eval script.
6. **UI (the project's "never skip silently" rule):** an unsure track gets a visible "bar 1 unsure" marker and one
   click to set it (`setDownbeatAt`). A detected phase slip is shown with its time, never silently
   corrected.

---

## 8. Patents relevant to commercial DJ software

**Not legal advice.** This is a non-exhaustive search on Google Patents. Before selling, get a freedom-to-operate
opinion from a patent attorney, especially in the US, EU and Japan.

| Patent | Holder | Status (per Google Patents) | What it claims (summary) | Relevance |
|---|---|---|---|---|
| **US11176915B2** "Song analysis device" | **AlphaTheta** (Pioneer DJ) | **Active, anticipated expiry 2037-10-06** | Bar start from drums: "a bass drum position extractor configured to extract the sounding positions of the bass drum positioning one beat before the sounding positions of the snare drum", with the first position above a power threshold taken as the measure start | **High.** Do not implement the "kick one beat before snare → bar start" rule as claimed. |
| **US10629173B2** "Musical piece development analysis" | **AlphaTheta** | **Active, to 2036-03-30** | Detect a specific instrument sound (e.g. bass drum), compare sound-production patterns between sections, and determine development change points | **Medium** for phrase/section cues built from kick patterns. Our novelty-on-3-band-energy approach differs, but ask counsel. |
| **US9378719B2** (pub. US20140033902A1) "Analyzing rhythm structure" | **Yamaha** | **Active, to 2033-07-31** | Beat positions → divide the audio under *multiple offset models* → match each against *reference performance patterns* → select the best division | **Medium.** Close to "try each phase against rhythm templates". Scoring phases with generic cues and no reference-pattern library is further from it. Ask counsel. |
| US11328699B2 "Musical analysis method" | UNVERIFIED (likely Yamaha) | UNVERIFIED | Cheap first process proposes candidate points, a learned model scores a selected subset (mutual-information selection). The spec names "head of a bar" | Low-medium, only if we adopt a candidate-selection + NN design. |
| US9653056B2 / EP2845188B1 "Evaluation of (beats, chords and) downbeats" | Nokia | **Expired (fee related) / not in force** | Chord-change likelihood + accent-based downbeat likelihoods, combined per beat | **Free to use.** Supports Option 1's design. |
| US7026536B2 / US7132595B2 "Beat analysis of musical signals" | Microsoft | US7026536B2 **expired** (fee related); US7132595B2 UNVERIFIED | Onset + autocorrelation tempo + phase rectification | Low. |
| EP2207163A2 (Sony, bar detection via chord/key + beat-section similarity + Viterbi) | Sony | EP application **withdrawn**. US family status UNVERIFIED | | Low (check the US counterpart). |
| US6316712 "tempo and downbeat detection" | UNVERIFIED | Filed ~1999; should be expired by term (UNVERIFIED) | | Low. |

One DJ software maker's published patent list covers stems,
transport and effects. None of the titles are about beat grids or downbeats. Searches of two other DJ software makers found no patent
on downbeat detection was found (absence of evidence only).

---

## 9. License table: existing systems (code vs weights, verified quotes)

| System | Code license (quote) | Weights / model license (quote) | Commercial use in DeckMix |
|---|---|---|---|
| madmom | BSD-2 for source ("all source code files are published under this license") | "All model and data files are distributed under ... Creative Commons Attribution-NonCommercial-ShareAlike 4.0"; commercial via Gerhard Widmer, gerhard.widmer@jku.at ([LICENSE](https://raw.githubusercontent.com/CPJKU/madmom/main/LICENSE)) | Code yes (BSD), **weights no**. A commercial license means negotiating with JKU. Excluded by policy anyway. |
| Beat This! | "MIT License / Copyright (c) 2024 Institute of Computational Perception, JKU Linz" ([LICENSE](https://raw.githubusercontent.com/CPJKU/beat_this/main/LICENSE)) | README: "The code and the published model weights are released under the MIT license." Caveat: "some of the training files are fully copyrighted or under limited Creative Commons licenses." | Legally yes, with the training-data caveat. **Excluded by owner policy.** |
| BeatNet | "Attribution 4.0 International" (CC BY 4.0) ([LICENSE](https://raw.githubusercontent.com/mjhydri/BeatNet/main/LICENSE)) | Same file covers the repo including weights (weight-specific license UNVERIFIED) | Legally yes with attribution. Depends on madmom (BSD code). Excluded by policy. |
| All-In-One (allin1) | "MIT License / Copyright (c) 2023 Taejun Kim" ([LICENSE](https://raw.githubusercontent.com/mir-aidj/all-in-one/main/LICENSE)) | HF `taejunkim/allinone` declares "License: mit". Trained on Harmonix (copyrighted audio). | Legally yes. Technically unviable (Demucs + NATTEN). Excluded. |
| Demucs (needed by allin1) | "MIT License / Copyright (c) Meta Platforms, Inc. and affiliates." ([LICENSE](https://raw.githubusercontent.com/facebookresearch/demucs/main/LICENSE)) | UNVERIFIED separately | n/a |
| Beat-Transformer | "MIT License / Copyright (c) 2022 Zhao Jingwei" ([LICENSE](https://raw.githubusercontent.com/zhaojw1998/Beat-Transformer/main/LICENSE)) | UNVERIFIED (checkpoint license not stated separately). Needs Spleeter. | Excluded. |
| Essentia / essentia.js | "Affero GPLv3, for non-commercial applications", commercial license from UPF MTG | "CC BY-NC-ND 4.0 license for non-commercial use ... also available under a proprietary license upon request" ([licensing](https://essentia.upf.edu/licensing_information.html)) | **No**, unless a paid license is negotiated (contact mtg-info@upf.edu). No dedicated downbeat algorithm found (UNVERIFIED). |
| an open-source DJ program | "GNU General Public License ... version 2 of the License, or (at your option) any later version" | n/a | **No** (GPL). Ideas only. |
| qm-dsp / QM Vamp plugins | "GNU GENERAL PUBLIC LICENSE Version 2" ([COPYING](https://raw.githubusercontent.com/c4dm/qm-dsp/master/COPYING)) | n/a | **No** (GPL). The Davies & Plumbley paper can be reimplemented. |
| librosa | "ISC License ... Copyright (c) 2013--2026, librosa development team" | n/a | Yes, but it has no downbeat tracker, and it is Python. |
| onnxruntime(-web) | "MIT License / Copyright (c) Microsoft Corporation" | n/a | Yes (runtime only). |
| Raveform | Code repo MIT | Annotations "cc-by-4.0" (HF tag). Audio not included. | Annotations yes (attribution). Audio no. |
| Harmonix Set | "MIT License / Copyright (c) 2019 Oriol Nieto" | Annotations under the same repo license. Audio not included. | Annotations yes. Audio no. |

---

## 10. Risks

1. **Tempo-octave errors dominate downbeat errors** (Krebs 2016 error analysis). A wrong octave makes the
   "bar" wrong regardless of the downbeat method. Mitigation: the octave check in §7, and the tag hint already in `estimateBeatGrid`.
2. **The accuracy numbers for Option 1 are my estimates.** No published classical system was evaluated on
   the fixed-grid 4-way formulation or on Mizrahi. The owner's labeled set is what turns them into facts.
3. **Constant-tempo, single-phase grid.** Edits with a dropped or added beat, live drummers and old disco break the
   single-phase assumption. The HMM can detect this. The `BeatGrid` type cannot represent it yet. Surface it.
4. **Patents** (§8), especially AlphaTheta's drum-pattern bar-start claim, which is the most "obvious" heuristic.
5. **Training-data legality** (§5.2). The clean data is synthetic or non-EDM. Real EDM labels exist only for
   copyrighted audio.
6. **Other-software ground-truth bias** (§6.1). Using auto grids as "truth" would reward copying another program's first-transient
   heuristic.
7. **Genre mix.** Hip-hop with sparse harmony and Mizrahi with Middle-Eastern percussion patterns may defeat
   the harmonic and phrase cues. That is why the per-genre breakdown is required.

## 11. Open questions for the owner

1. Is **offline development tooling** (e.g. Python/PyTorch used only to *train* our own model, never shipped)
   acceptable? Is a generic runtime library such as onnxruntime-web acceptable? Or must everything, including training, be our own TS?
2. May we use **your own music files to train** a model we then sell, after a lawyer confirms it? Or only to *measure* accuracy?
3. Can you spend about 40 minutes **labeling "which beat is 1"** on about 120 tracks (the ground truth everything else is judged by)?
4. Do you have **another DJ program's** analysis for part of the library (a second opinion on downbeats)? Which of the grids in your main DJ program did you **fix by hand**?
5. When the app is unsure, do you prefer **"unsure, please tap beat 1"** or a best guess with a visible warning?
6. Should we get a **patent freedom-to-operate opinion** before a public release (recommended, §8)?
7. Should the detector allow **3/4 and 6/8** (some Mizrahi and older songs), or treat everything as 4/4 and flag misfits?

## Sources (primary unless noted)
Böck, Krebs, Widmer, ISMIR 2016: https://archives.ismir.net/ismir2016/paper/000186.pdf ·
Krebs, Böck, Dorfer, Widmer, ISMIR 2016: https://archives.ismir.net/ismir2016/paper/000249.pdf ·
Beat This!: https://arxiv.org/abs/2407.21658, https://github.com/CPJKU/beat_this ·
BeatNet: https://arxiv.org/abs/2108.03576, https://github.com/mjhydri/BeatNet ·
1D state space: https://arxiv.org/abs/2111.00704 ·
Beat Transformer: https://arxiv.org/abs/2209.07140 ·
All-In-One: https://arxiv.org/abs/2307.16425, https://github.com/mir-aidj/all-in-one, https://huggingface.co/taejunkim/allinone ·
Raveform: https://transactions.ismir.net/articles/10.5334/tismir.288 ·
MIREX 2016 downbeat: https://music-ir.org/mirex/wiki/2016:Audio_Downbeat_Estimation_Results ·
Tempo/beat/downbeat tutorial (HJDB history): https://tempobeatdownbeat.github.io/tutorial/ch2_basics/annotation.html ·
Harmonix: https://github.com/urinieto/harmonixset ·
QM Vamp plugins: https://vamp-plugins.org/plugin-doc/qm-vamp-plugins.html ·
Patents: https://patents.google.com/patent/US11176915B2/en, https://patents.google.com/patent/US10629173B2/en,
https://patents.google.com/patent/US20140033902A1/en, https://patents.google.com/patent/US11328699B2/en,
https://patents.google.com/patent/US9653056B2/en, https://patents.google.com/patent/EP2845188B1/en,
https://patents.google.com/patent/US7026536B2/en, https://patents.google.com/patent/EP2207163A2/en ·
Israel MoJ opinion (secondary summaries): https://www.law.co.il/en/news/2022/12/22/fair-use-of-copyrighted-content-for-aiml-training/
