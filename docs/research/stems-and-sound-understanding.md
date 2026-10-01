# Stems and sound understanding — research report

Written 2026-09-24 for ROADMAP v0.12.15 (was v0.20.0) ("Stems") and the "sounds similar" work (v0.8.18).
Research only: no code was changed. It answers one question: **what is the best legal,
feasible way for DeckMix to "understand" drums versus vocals versus bass+melody, and
later to play stems?**

**Scope set by the owner during this research.** DeckMix will **not ship existing
separation software or pretrained model weights**. The feature gets designed and written
from scratch, in TypeScript now and Rust after Tauri, once the underlying methods are well
understood. Papers and algorithms are fine to learn from. Code and weights are not to be
copied. So the survey in §2–§3 is mostly there to set quality and speed targets, and
§4–§8 carry most of the weight.

**How to read the evidence.** "VERIFIED" means I opened the primary source (LICENSE file,
model card, dataset record, paper, or patent page) and the quoted text comes from it.
"UNVERIFIED" means I could not open a primary source, or the number is my own estimate.
Patent claims were read through Google Patents summaries, not the full claim text (§9).
None of this is legal advice.

---

## 0. TL;DR

**The main finding:** most of what the owner asked for does not need source separation.
The per-stem similarity and the "where are the vocals" timeline can be built from
classical DSP plus, at most, a very small classifier trained on commercially clean
data. You only need real separation for *playable* stems. That is the expensive, risky
part, and it belongs after Tauri.

### Ranked options

| # | Option | What it gives | Quality (expected) | Speed on target laptop, 360 tracks | License / legal | Effort |
|---|---|---|---|---|---|---|
| **1** | **Classical "understanding" pipeline, no training** (HPSS → drum-band onset patterns; harmonic chroma/bass; vocal-presence cues from stereo centre, pitch fluctuation and non-repetition) | 3 separate similarity scores (drums / vocals / bass+melody) + a vocal-presence timeline with a visible confidence | Drums and harmonic similarity: good for dance music. Vocal timeline: roughly 75–85% frame accuracy (UNVERIFIED estimate; the literature's hand-crafted baseline is 87.9% *with* a trained classifier) | ~5 s per track single-threaded, measured (§5.8) → **~10 min with 4 workers** | Clean: our own code, textbook algorithms, no weights | 1–2 versions |
| **2** | **Option 1 + a tiny vocal-activity classifier we train ourselves** (logistic regression / small MLP / small CNN over the same features) | A better vocal timeline (literature: 87–91% frame accuracy on Jamendo) | ≈ published baselines if the data is good | +1–2 s per track | Needs a commercially clean training set (§8): synthetic mixes of CC BY a-cappellas + CC BY instrumentals, plus the owner's hand labels for evaluation | +1–2 versions, most of it data work |
| **3** | **Classical "rough stems" to play live** (HPSS drums/harmonic split + centre-channel vocal cut) | Something to mute live: "drums only", "no drums", "karaoke-ish" | Clearly audible artefacts. Nowhere near commercial software | Real time is possible (block-wise median filters) | Our own code, **but check the patent holder's patents before shipping playback** (§9) | 1 version |
| **4** | **Our own neural separator** (mask-based band-split model, 2–10 M params), trained on commercially clean data, pre-computed offline in Tauri, stems stored as Opus | Real playable stems | Realistic target 5–7 dB SDR (Open-Unmix/Spleeter class), below Demucs' 9 dB (UNVERIFIED estimate) | Browser WASM: ~1–5 min per track → 6–30 h for 360. Tauri native/GPU: a few times faster (estimate) | Data licensing is the blocker (§8). Patent clearance (§9) is required | Months, plus data cost ($0 to ~$40k depending on data route) |
| ✗ | Ship Demucs / UMX-L / Essentia / madmom / community RoFormer weights | — | — | — | Excluded by the owner's rule. Most are non-commercial anyway (§11) | — |

**Recommendation:** do **1 now** (browser, no training). Measure it on 30 hand-labelled
tracks, the same way the downbeat version will be measured. Add **2** only if the vocal timeline misses its
target. Treat **3** as an optional stopgap. Plan **4** for after Tauri, and only after two
gates: **a data decision** (§8.4) and **a freedom-to-operate patent opinion** (§9).

### The ROADMAP claim, checked

`ROADMAP.md` v0.12.15 says the Demucs code is MIT but the weights are "for scientific use only".
**VERIFIED, and stated precisely:**

- The code's LICENSE (https://github.com/facebookresearch/demucs/blob/main/LICENSE) is the
  MIT license, "Copyright (c) Meta Platforms, Inc. and affiliates".
- The weights: in issue #327, "License of pre-trained models"
  (https://github.com/facebookresearch/demucs/issues/327), a company asked on 2022-05-05
  about "distributing demucs as part of a commercial project, including one of the provided
  pre-trained models". The author, adefossez, answered on 2022-05-23:
  **"The model weights are not covered by the MIT license, and are provided only for
  scientific purposes."**
- That answer came before htdemucs (v4), but no later license grant exists. The README
  says v4 was "trained on the MUSDB HQ dataset + an extra training dataset of 800 songs",
  and MUSDB18 is academic-only (§8.1). The repository says "this repository is not
  maintained anymore" and is archived (read-only since 2025-01-01). No company is there to
  sell a commercial license, so **it is realistically not obtainable**.
- One more trap: an ONNX conversion does not change the license. Intel's
  `Intel/demucs-openvino` on Hugging Face labels converted weights "MIT", and a commenter
  on the same issue points out that this conflicts with the author's statement. Relabelling
  a derivative does not create rights.

---

## 1. What the owner actually asked for, mapped to techniques

| Want | Needs separation? | Cheapest adequate technique |
|---|---|---|
| "Drums sound similar" | No | Percussive component (HPSS) → bar-synchronous kick/snare/hat onset pattern + percussive timbre |
| "Bass + melody sound similar" | No | Harmonic component → chroma, bass-band chroma, harmonic MFCC statistics |
| "Vocals sound similar" | Weakly | Timbre statistics computed **only over frames the vocal detector marks as vocal** (a gated embedding), plus the pitch range of those frames |
| Vocal on/off timeline (to stop two vocals clashing) | No | Vocal activity detection (VAD): classical cues, optionally plus a tiny classifier |
| Cleaner "one" (downbeat) hint for the downbeat version | No | Kick-band onsets on the percussive component |
| Mute vocals live, play drums only, etc. | **Yes** | A neural separator (classical methods are audibly poor) |

This matches the split already drafted in `ROADMAP.md` (half 1 "understand", half 2 "play").
The research supports that order.

---

## 2. Survey: source-separation models (for targets only, not to ship)

SDR here means signal-to-distortion ratio on the MUSDB18(-HQ) test set, averaged over
vocals/drums/bass/other, in dB. Higher is better. Around 6 dB is usable for DJ effects,
and 9 dB or more is the current state of the art.

| Model | Year | Avg SDR | Size | CPU time for a 5-min track | Browser feasibility | Code license | Weights license | Training data |
|---|---|---|---|---|---|---|---|---|
| **Demucs v4 htdemucs** | 2022 | 9.0 (README). Paper: 9.20 with sparse attention + per-source fine-tuning | ~42 M params. 81 MB fp16 in the browser port | README: "roughly equal to 1.5 times the duration of the track" (CPU) → ~7.5 min | **Yes:** freemusicdemixer.com (C++→WASM): "~41 min for a ~7-minute track single-threaded; ~9 min with 8 workers". ONNX export: sevagh/demucs.onnx; a GSoC 2025 project | MIT (VERIFIED) | **Scientific purposes only** (VERIFIED, #327) | MUSDB-HQ + 800 internal Meta songs |
| htdemucs_ft | 2022 | "Same 9.0 dB with enhanced quality" | 4 × htdemucs (one per source) | "4x processing time" | Same port, 4× slower | MIT | Same as above | Same |
| htdemucs_6s | 2022 | Adds guitar and piano ("piano quality noted as poor") | 53 MB fp16 (browser port) | ≈ htdemucs | Yes (freemusicdemixer) | MIT | Same as above | Same |
| **Open-Unmix** umxhq / umxl | 2019 / 2021 | UMXHQ median vocals 6.25, drums 6.04, bass 5.07, other 4.28. UMXL 7.21 / 7.15 / 6.02 / 4.89 | ~4 × 9 M params (UNVERIFIED) | Fast (BLSTM on magnitudes). No verified number | Feasible (small ops). No official web demo found | MIT (VERIFIED, GitHub API) | **umxhq: MIT on Zenodo** (VERIFIED: record 3370489, "License: MIT License") but trained on academic-only MUSDB18-HQ (§8.1). **umxl: "the weights are only licensed for non-commercial use (CC BY-NC-SA 4.0)"** (VERIFIED, README) | umxhq: MUSDB18-HQ. umxl: "private stems dataset" |
| **Spleeter** 2/4/5 stems | 2019 | JOSS paper, MWF variant: vocals 6.86, drums 6.71, bass 5.51, other 4.55 (Demucs v2 in the same table: 7.05 / 7.08 / 6.70 / 4.47) | Release tarballs: 2stems 73 MB, 4stems 146 MB, 5stems 183 MB (VERIFIED, GitHub release v1.4.0) | "100 seconds of stereo audio in less than 1 second" on an RTX 2080. CPU unknown | TF-based. Community TF.js ports exist (not verified) | MIT (VERIFIED) | Distributed as release assets of the MIT repo. No separate weights license found (UNVERIFIED whether MIT is meant to cover them) | Paper: "trained on Deezer's internal datasets", and "it was not trained, validated or optimized in any way with musdb18 data" (VERIFIED) |
| MDX-Net / UVR community models | 2021– | MDX23C vocals 10.17 (ZFTurbo table) | 30–100+ MB (UNVERIFIED) | Heavy | ONNX exists (UVR) | MIT (UVR GUI, kuielab/mdx-net) | **Most community weights have no license at all** → all rights reserved by default (UNVERIFIED per model) | Often MUSDB + undisclosed sets |
| **BS-RoFormer** | 2023 | Paper: "9.80 dB of average SDR" on MUSDB18HQ with no extra data. Won SDX23 with 500 extra songs | Large (tens of M params, UNVERIFIED) | Very heavy on CPU | Theoretically possible via ONNX. Impractical in WASM | lucidrains/BS-RoFormer MIT (unofficial reimplementation). ByteDance's official code not public | Community (viperx, KimberleyJensen, ZFTurbo): **no license stated** in the ZFTurbo model list (VERIFIED absence) | MUSDB18HQ ± undisclosed |
| **Mel-RoFormer** | 2023 | "outperforms BS-RoFormer in the separation tasks of vocals, drums, and other" (abstract). Community vocal model 10.98 | Large | Very heavy | Same as above | Same as above | Same as above | Same as above |
| **SCNet** | 2024 | "9.0 dB on the MUSDB18-HQ dataset without using extra data". "CPU inference time is only 48% of HT Demucs" | ~10 M params (UNVERIFIED) | ~3.5 min (derived from 48% × Demucs, UNVERIFIED) | Feasible via ONNX (no demo found) | starrytong/SCNet MIT (VERIFIED) | Not verified | MUSDB18-HQ → non-commercial taint |
| **HS-TasNet** (real-time) | 2024 | "For a latency of 23 ms … SDR of 4.65 on the MusDB test set, and increases to 5.55 with additional training data" | Small | Real time | Design target for live use | No official code found | — | MUSDB (+ extra) |
| LarsNet (drum kit pieces) | 2023 | Splits a drum stem into 5 kit pieces, "faster than real-time" | — | — | — | polimi-ispl/larsnet (not verified) | Not verified | StemGMD (CC BY 4.0, §8) |

Sources: Demucs README https://github.com/facebookresearch/demucs ; HT Demucs paper
https://arxiv.org/abs/2211.08553 ; Open-Unmix README https://github.com/sigsep/open-unmix-pytorch ;
UMX-HQ weights https://zenodo.org/records/3370489 ; Spleeter https://github.com/deezer/spleeter and
JOSS paper https://doi.org/10.21105/joss.02154 ; ZFTurbo model list
https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/pretrained_models.md ;
BS-RoFormer https://arxiv.org/abs/2309.02612 ; Mel-RoFormer https://arxiv.org/abs/2310.01809 ;
SCNet https://arxiv.org/abs/2401.13276 ; HS-TasNet https://arxiv.org/abs/2402.17701 ;
freemusicdemixer https://github.com/sevagh/free-music-demixer ; demucs.onnx
https://github.com/sevagh/demucs.onnx ;
LarsNet/StemGMD https://arxiv.org/abs/2312.09663.

**Useful runtime data points (all VERIFIED quotes, hardware mostly unstated):**
- WASM Demucs v4 (freemusicdemixer): 7-min track = 41 min on 1 thread, 9 min on 8 workers.
  That is **~6.4 min per 5-min track with 8 workers** → 360 tracks ≈ **38 hours**.
- A GSoC 2025 project, C++ ONNX Runtime on CPU: 50 MUSDB test tracks in 4,415 s. The MUSDB test set
  is "about 3 hours and 27 minutes" per the Spleeter paper, so that is ≈ 0.36× real time on
  their CPU. ONNX on GPU was 8% *slower* than PyTorch GPU. Quality matched (vocals SI-SDR
  7.84 vs 7.83).
- The freemusicdemixer site says its "AI model weights … are proprietary and not covered by
  the MIT license". A browser port does not solve the weights question.

---

## 3. How commercial DJ software does it

*(Removed in v0.12.3 at the owner's request: no names of, links to, or comparisons with other DJ software.)*

**Two patterns hold across the market:**
1. Everyone offers **pre-computation** as the fallback for weak machines, and on a
   13th-gen U-series laptop without a GPU, pre-computation is the realistic mode.
2. The winners use **licensed or in-house** models. Nobody publicly ships Demucs weights
   in a commercial DJ product. That lines up with §0.

A multi-track stem container (MP4: master plus 4 stems) exists as a possible interchange format for
later. One blog says it is "patent encumbered". **UNVERIFIED**: no patent number found.

---

## 4. How the methods work — enough to reimplement

Notation: x(n) is the stereo mixture. X(f,t) = STFT{x} is complex, f is the frequency bin
and t the frame. V = |X| is the magnitude and Φ = ∠X the phase. Sources are
j ∈ {vocals, drums, bass, other}, with x = Σ_j s_j.

### 4.1 Shared building blocks

**STFT and its inverse.** Hann window, N = 2048–4096, hop N/4. The inverse uses
overlap-add with window-sum normalisation. Everything below either (a) builds a
time-frequency **mask** and multiplies it into X, or (b) predicts the waveform directly.

**Masking.** Ŝ_j(f,t) = M_j(f,t) · X(f,t), with 0 ≤ M_j ≤ 1. Reusing the mixture phase
limits quality, but it is simple and it guarantees Σ_j Ŝ_j ≈ X when Σ_j M_j = 1.
That property matters for DJ use: all stems at unity sound exactly like the original.

**Soft (Wiener-like) masks from magnitude estimates.** Given estimated magnitudes V̂_j:

```
M_j(f,t) = V̂_j(f,t)^p / Σ_k V̂_k(f,t)^p        p = 2 (Wiener), p = 1 (ratio mask)
```

**Multichannel Wiener filter (MWF).** This is the post-filter Open-Unmix and Spleeter-MWF
use. Model each source as zero-mean complex Gaussian with power spectral density v_j(f,t)
and a 2×2 spatial covariance R_j(f). Then

```
ŝ_j(f,t) = v_j R_j ( Σ_k v_k R_k )^-1 x(f,t)        (x is the 2-vector [X_L, X_R])
```

Iterate EM: re-estimate v_j and R_j from ŝ_j and recompute. One to two iterations help.
In the Spleeter paper, MWF raised vocals from 6.55 to 6.86 dB. Reference: Nugraha,
Liutkus & Vincent, "Multichannel audio source separation with deep neural networks",
IEEE/ACM TASLP 2016. The SiSEC 2018 overview (Stöter, Liutkus & Ito, arXiv:1804.06267)
defines the oracle masks IBM/IRM1/IRM2/MWF. They are the ceiling for any mask method.

**Evaluation (we must build our own).** Per source:

```
SDR_j = 10 log10( Σ_n s_j(n)^2 / Σ_n (s_j(n) − ŝ_j(n))^2 )            ("new SDR" used by MDX 2021)
SI-SDR = 10 log10( ||α s||^2 / ||α s − ŝ||^2 ),   α = <ŝ,s>/||s||^2
```

Use these on a held-out set of multitracks we are allowed to hold (§8). The full BSS-Eval
(SIR/SAR/ISR, Vincent, Gribonval & Févotte, IEEE TASLP 2006) is optional.

### 4.2 Open-Unmix (Stöter, Uhlich, Liutkus & Mitsufuji, JOSS 2019, doi:10.21105/joss.01667)

The simplest deep baseline, and the one to model a first own-model on.

```
input:  |X| stereo, STFT N=4096 hop=1024, cropped to ~16 kHz bandwidth
per target model:
  z = (|X| − μ_in) / σ_in                     # learned per-bin input scaling
  z = FC(bins·2 → 512) → BatchNorm → tanh
  h = BLSTM(3 layers, 512 total width, i.e. 256 per direction)(z)
  z = concat(z, h) → FC → BN → ReLU → FC(→ bins·2) → BN
  z = z · σ_out + μ_out
  M = ReLU(z)                                 # unbounded "mask"
  V̂_j = M ⊙ |X|
loss:  MSE(V̂_j, |S_j|)
post:  MWF over all targets (1 EM iteration)
```

There is one independent network per source, which is why it has four checkpoints.

### 4.3 Demucs family (Défossez et al.)

- **Demucs v2, waveform U-Net** (arXiv:1911.13254). Encoder: 6 layers of Conv1d(K=8,
  S=4) → ReLU → Conv1d(1×1) → GLU, channels doubling from 64. Bottleneck: 2-layer BiLSTM.
  Decoder: mirrored ConvTranspose1d with U-Net skip connections. The output is 4 × stereo
  waveforms. **Loss: L1 on the waveform.** Input is upsampled internally in v1 and was
  dropped later.
- **Hybrid Demucs v3** (arXiv:2111.03600). Two parallel U-Nets: a waveform branch and a
  spectrogram branch. The spectrogram branch is "complex-as-channels": real and imaginary
  parts of the stereo STFT become 4 input channels, and the model predicts a complex
  spectrogram directly, not a mask. The two branches share a bottleneck. The output is
  time branch + iSTFT(spectral branch).
- **HT Demucs v4** (arXiv:2211.08553). The innermost layers are replaced by a
  "cross-domain Transformer Encoder, using self-attention within one domain, and
  cross-attention across domains". Segments are at most 7.8 s. The abstract says it
  "performs poorly when trained only on MUSDB", and wins only with 800 extra songs. **The
  lesson for us: transformers need more data than we are likely to have.**
- **Training tricks. These matter more than the architecture when data is small:**
  1. *Remixing*: build every training example by drawing each stem from a **different
     random song** at a random offset. This multiplies the effective dataset
     combinatorially.
  2. Random gain per stem, sign flip, left/right swap, pitch/tempo shift (±2 semitones,
     ±12%).
  3. Shift-trick at inference: average predictions over a few random time shifts.

### 4.4 Band-split models: BSRNN → BS-RoFormer → Mel-RoFormer; SCNet

The current state of the art. This is also the family most worth copying *as an idea* for
a small own model, because the band split gives most of the gain at low cost.

```
X: complex STFT, stereo → real tensor [2ch·2(re,im), F, T]
Band split: partition F bins into K bands, narrow at low frequency and wide at high
  (BSRNN: ~40–60 bands; Mel-RoFormer: overlapping mel-spaced bands)
  for each band k:  e_k(t) = FC_k( RMSNorm( X[band_k, t] flattened ) ) ∈ R^D     # D ≈ 128–384
Tensor E: [K, T, D]
Repeat L times:
  E ← TransformerOverTime(E)   for each band independently      (RoPE positions on t)
  E ← TransformerOverBands(E)  for each frame independently     (RoPE positions on k)
  (BSRNN uses BLSTMs instead of transformers here)
Mask head per band: MLP(D → 4·|band_k|) → GLU → complex mask M_k (re, im)
Ŝ = M ⊙ X  (complex multiply) → iSTFT
Loss: L1(waveform) + Σ_resolutions L1(|STFT_r(ŝ)| − |STFT_r(s)|)     (multi-resolution STFT loss)
```

References: Luo & Yu, "Music source separation with band-split RNN", arXiv:2209.15174;
Lu et al., BS-RoFormer, arXiv:2309.02612 ("band-split module to project the input complex
spectrogram into subband-level representations", "hierarchical Transformers to model the
inner-band as well as inter-band sequences"); Wang et al., Mel-RoFormer, arXiv:2310.01809.
SCNet (arXiv:2401.13276) instead compresses bands with "less information" harder, and
reaches 9.0 dB at 48% of HT Demucs' CPU time. That is the right direction for a laptop.

**Why a small version fits DJ use:** the model can be made causal and cheap by (a) using a
GRU over time instead of a transformer, (b) cutting to ~24 bands and D = 64, and (c) predicting
magnitude masks rather than complex masks. That lands near Open-Unmix quality at a
fraction of the cost (estimate, UNVERIFIED).

### 4.5 Time-domain, low latency: Conv-TasNet and HS-TasNet

Conv-TasNet (Luo & Mesgarani, arXiv:1809.07454) replaces the STFT with a *learned*
encoder: Conv1d with 16-sample kernels, producing N basis channels. A temporal
convolutional network (stacked dilated depthwise-separable 1-D convs) estimates masks in
that learned space, and a transposed-conv decoder turns them back into audio. The loss is
SI-SDR. HS-TasNet (arXiv:2402.17701) combines a TasNet branch with a spectrogram branch
for **23 ms latency**, at 4.65–5.55 dB. **That is the realistic quality of true
low-latency separation today.** It is also why the commercial "real time"
really means block-wise processing with a look-ahead buffer, which is exactly what
the patents in §9 claim.

### 4.6 MDX-Net / TFC-TDF (Kim et al., arXiv:2111.12203)

A U-Net on the spectrogram whose blocks are "Time-Frequency Convolutions" followed by
"Time-Distributed Fully-connected" layers across frequency. It is the basis of the UVR
models. Nothing essential beyond §4.4.

---

## 5. What needs NO training: classical DSP

All of these are textbook algorithms from papers. We can implement them from the
equations, and none needs weights. **Expected quality in general:** in the SiSEC 2018
evaluation, the classical methods (2DFT, RPCA, REP1, REP2, HPSS, via the NUSSL toolbox)
sit at the bottom of the ranking, below every trained system. I read that off the
figures, and the exact dB values are not machine-readable in the PDF (UNVERIFIED numbers;
my recollection is roughly 0–3 dB vocals SDR, against 6–9 for deep models). They are **not
good enough for playable stems**, and **good enough for features and timelines.**

### 5.1 HPSS: harmonic vs percussive by median filtering

Fitzgerald, "Harmonic/percussive separation using median filtering", DAFx 2010.
The idea: harmonic sounds are horizontal lines in a spectrogram (stable over time), and
percussive sounds are vertical lines (broadband, short).

```
V = |X|
H̃(f,t) = median( V(f, t−l_h … t+l_h) )     # along time,  l_h ≈ 0.2 s worth of frames
P̃(f,t) = median( V(f−l_p … f+l_p, t) )     # along freq,  l_p ≈ 500 Hz worth of bins
soft masks:  M_H = H̃^p / (H̃^p + P̃^p),  M_P = 1 − M_H,     p = 2
```

**With a residual** (Driedger, Müller & Disch, ISMIR 2014, "Extending harmonic-percussive
separation of audio signals"): use a separation factor β ≥ 1.

```
M_H = [H̃ / (P̃+ε) > β],   M_P = [P̃ / (H̃+ε) ≥ β],   M_R = 1 − M_H − M_P
```

The residual R collects noise-like, non-stable parts, and **it is where vocal
consonants, breaths and reverb tails land.** Iterating HPSS at two resolutions ("two-stage
HPSS": a long window first, then a short one on the harmonic part) pulls out fluctuating
components such as vibrato vocals. Leglaive et al. used that as the front-end of their
singing-voice detector (quoted in §6.1).

**On dance music:** kicks mostly go to P, except the tonal tail of an 808/909 kick, which
leaks into H below 80 Hz. Hats and claps go cleanly to P. Pads, bass and chords go to H.
That is exactly the drums-vs-(bass+melody) split §1 needs.

### 5.2 REPET / REPET-SIM: repeating background vs non-repeating foreground

Rafii & Pardo, "REpeating Pattern Extraction Technique (REPET)", IEEE TASLP 2013.
REPET-SIM: Rafii & Pardo, ICASSP 2012. Generalised as Kernel Additive Modelling by Liutkus
et al., IEEE TSP 2014.

**This fits DeckMix unusually well**, because loop-based dance music is highly
repetitive, and we already know the beat grid (`src/core/beatgrid.ts`), so the repetition
period is given rather than estimated.

```
REPET (period p known — e.g. 1 bar from the beat grid, in frames):
  S(f, τ) = median_k V(f, τ + k·p)          for τ in one period, k over all repetitions
  W(f,t)  = min( S(f, t mod p), V(f,t) )    # repeating model can't exceed the mixture
  M_rep   = W / (V+ε)                       # background (loops)
  M_fg    = 1 − M_rep                       # foreground: vocals, fills, one-shots

REPET-SIM (no fixed period — better for songs with changing sections):
  C = cosine-similarity matrix of frames (on V columns)
  for each frame t: J_t = the K most similar frames (min spacing d, similarity > θ)
  W(f,t) = min( median_{j ∈ J_t} V(f,j), V(f,t) )
```

A **vocal-evidence map** is then: foreground (REPET) ∩ harmonic-or-residual (HPSS) ∩ centre
panning (§5.4) ∩ the 150 Hz–8 kHz band.

### 5.3 NMF and NMFD: parts-based decomposition

Lee & Seung, NIPS 2000 (the multiplicative updates). Smaragdis & Brown, WASPAA 2003
(transcription). Smaragdis, ICA 2004 (convolutive NMFD). Dittmar & Gärtner, DAFx 2014
("Real-time transcription and separation of drum recordings based on NMF decomposition").

```
V ≈ W H,  W ∈ R+^{F×R} (spectral templates), H ∈ R+^{R×T} (activations)
KL-divergence multiplicative updates:
  H ← H ⊙ ( Wᵀ (V ⊘ WH) ) ⊘ ( Wᵀ 1 )
  W ← W ⊙ ( (V ⊘ WH) Hᵀ ) ⊘ ( 1 Hᵀ )
Semi-supervised drums: fix W_drum = [kick, snare, hat] templates, learn W_other freely;
  kick/snare/hat activations H_drum(t) = a drum transcription.
NMFD: each template is a short spectrogram patch W_r(f,τ) (captures the decay of a hit):
  V ≈ Σ_τ W(τ) · shift_τ(H)
```

**Templates without training data:** synthesise them ourselves. A kick is a sine sweeping
150 → 50 Hz with an exponential decay, a snare is noise plus a ~200 Hz body, a hat is
high-passed noise. Render each through our own STFT and average. Nothing gets copied.
**Cost:** at full resolution (1025 bins × 13 k frames × R = 32 × 100 iterations) it is too
heavy for JS. On a 64–128-band mel spectrogram at 43 frames/s it takes seconds (estimate).

### 5.4 Stereo cues: the "vocals are in the centre" prior

Avendano & Jot, "A frequency-domain approach to multichannel upmix", JAES 2004.
Barry, Lawlor & Coyle, "Sound source separation: azimuth discrimination and resynthesis
(ADRess)", DAFx 2004.

```
Inter-channel coherence and panning index per bin:
  φ(f,t) = |X_L X_R*| / sqrt(|X_L|^2 |X_R|^2)            # 1 = fully correlated
  ψ(f,t) = 2|X_L X_R*| / (|X_L|^2 + |X_R|^2)            # 1 = centre-panned, 0 = hard L/R
Centre mask: M_c = [ψ > 0.9] · [φ > 0.8]   (soft version: ψ^γ)
Classic "karaoke": side = (L − R)/2 removes everything centre-panned.
```

**Limit:** in dance music, the kick, bass and snare are also centred. That is why this
cue only works in combination (∩ harmonic ∩ foreground ∩ vocal band). Mono tracks give no
stereo cue at all, so **the UI must say "mono: vocal detection less reliable"**, per the
repo's "never skip silently" rule. **Possible patent note:** ADRess was the subject of a
patent application by its authors' institution around 2004–2005. I could not verify a
number or its status (UNVERIFIED). If it was granted, it has most likely expired by now
(20-year term), but check that in the FTO (§9).

### 5.5 RPCA: low-rank accompaniment + sparse vocals

Huang, Chen, Smaragdis & Hasegawa-Johnson, "Singing-voice separation from monaural
recordings using robust principal component analysis", ICASSP 2012.

```
V = L + S,  min ||L||_* + λ ||S||_1,  λ = 1/sqrt(max(F,T))     (solved by inexact ALM)
Each iteration: SVD shrinkage on L, soft-threshold on S.
```

This needs one SVD per iteration, which is expensive in JS at full resolution. It is
viable on a mel spectrogram. REPET-SIM does a similar job more cheaply, so RPCA is
optional.

### 5.6 Vocal-presence cues without training

The features of Lehner, Widmer & Sonnleitner, "On the reduction of false positives in
singing voice detection", ICASSP 2014, computed frame-wise and then smoothed:

- **Fluctogram:** per sub-band, the frame-to-frame shift of spectral peaks (cross-correlation
  lag). The human voice moves pitch continuously (vibrato, glides), and synths and guitars
  mostly do not.
- **Vocal variance:** the variance of MFCCs 2–6 over ~1 s. Vocals vary more.
- **Spectral flatness and spectral contraction** in the 200 Hz–4 kHz formant region.
- Our addition: **centre-panned harmonic-foreground energy ratio** (§5.2 + §5.4) and
  **pitch salience with vibrato** (a YIN/harmonic-sum f0 track on the harmonic
  component, flagging 4–8 Hz modulation with a 20–100 cent extent).

With no training, combine these as a hand-tuned score:
z = Σ w_i · normalise(feature_i). Smooth it with a median filter of ~1 s, then add
hysteresis (enter above θ_hi, leave below θ_lo), or run a 2-state HMM with Viterbi
(transition probabilities set so that a segment lasts ~2 s or more). **Expected quality:**
below a trained classifier. The same paper's features with a Random Forest reached
87.2% (§6.1). An untrained weighted sum will likely land 5–10 points lower (UNVERIFIED
estimate). The owner's 30-track measurement will settle it.

### 5.7 Drum features without training (onsets and patterns)

On the percussive component P:

```
Band onset envelopes (spectral flux, half-wave rectified, log-compressed):
  O_b(t) = Σ_{f∈band b} max(0, log(1+γP(f,t)) − log(1+γP(f,t−1)))
  bands: kick 40–120 Hz, snare/clap 150–400 Hz + 1–5 kHz (both required), hat 6–16 kHz
Bar-synchronous pattern (uses the existing beat grid):
  for each bar: sample each O_b at 16 steps (16th notes), normalise per bar
  pattern_b = median over bars (robust to fills)   → 3 × 16 = 48 dims
  plus: swing ratio (offset of off-beat 16ths), density (onsets/bar per band),
        syncopation index, percussive spectral centroid mean/std (timbre: 909 vs acoustic)
```

Reference for the problem space: Wu et al., "A review of automatic drum transcription",
IEEE/ACM TASLP 2018. Pattern similarity should compare patterns under circular shift by
whole beats, taking the max over the 4 shifts (in case a downbeat is misplaced), until
the downbeat version's bar-start confidence is high.

### 5.8 Measured cost of the classical front-end (this session)

A throwaway Node script (plain JS, single thread, no SIMD, not in the repo) ran on the
machine this session ran on. **Note:** that machine reports itself as a **Latitude 7410,
i7-10610U (4 cores/8 threads), Intel UHD graphics**, *not* the 7440 in the brief. It is an
older, slower CPU, so treat these numbers as a pessimistic bound.

| Step, 5-minute track | 44.1 kHz, N=2048, hop 512 (25,836 frames) | 22.05 kHz mono, N=2048, hop 1024 (6,458 frames) |
|---|---|---|
| STFT (naive radix-2, twiddles recomputed) | 7.2–7.5 s | 0.62 s |
| HPSS, two 17-tap median filters | 44 s (Array.sort) | **4.4 s** (insertion sort) |
| Dense matmul, naive JS | 0.28–0.72 GFLOPS | — |

So **~5 s per track, single-threaded, before any optimisation**. With 4 workers that is
360 tracks in **≈ 8–10 minutes**, plus decode, which already happens for the existing
analysis. The obvious optimisations (precomputed twiddles, Float32 and a real FFT,
a sliding-median histogram, WASM SIMD) should bring it down a further 3–10× (estimate).
Naive JS matmul at ~0.5 GFLOPS is also why any neural model needs WASM SIMD with threads
or WebGPU (§7.3), never plain JS.

---

## 6. What needs training (small models): VAD, tagging, drum transcription

### 6.1 Singing-voice / vocal activity detection

**Literature numbers**, from Lee, Choi, Nam, "Revisiting singing voice detection: a
quantitative review and the future outlook", ISMIR 2018 (arXiv:1806.01180). Table 2, their
re-implementations on the Jamendo test set:

| System | Acc. | F-measure |
|---|---|---|
| FE-VD (Lehner 2014-style hand features + classifier) | 87.9% | 87.6% |
| CNN-VD (Schlüter & Grill 2015-style CNN on mel) | 86.8% | 86.3% |
| RNN-VD (Leglaive 2015: two-stage HPSS → BLSTM) | 87.5% | 86.6% |

The same paper notes that the RNN-VD system as originally published reported "accuracy of
91.5% on the Jamendo dataset". **Key takeaway (VERIFIED):** a hand-feature system with a
small classifier matched the deep ones in this comparison. So option 2 in §0 is realistic
without a big network.

**Model shape for our own VAD:** input is 80 mel bands × ~1.5 s context (plus the §5.6
features). A small CNN (Schlüter & Grill, "Exploring data augmentation for improved singing
voice detection with neural networks", ISMIR 2015 — 4 conv layers + 2 dense, well under
1 M params) or a logistic regression over the hand features. Output is P(vocal) per
~100 ms, followed by §5.6's smoothing. Inference cost is negligible (<1–2 s per track).
The training data problem is §8.

### 6.2 Audio tagging models (PANNs, YAMNet, EfficientAT, MusiCNN, Essentia): out of scope as weights

They matter only as reference designs, since the owner's rule excludes their weights. For
the record:

| Model | Code license | Weights license | Training data | Size |
|---|---|---|---|---|
| PANNs (Kong et al., arXiv:1912.10211) | MIT (VERIFIED, repo) | **CC BY 4.0** (VERIFIED, Zenodo 3987831: "Creative Commons Attribution 4.0 International") | AudioSet (YouTube clips, labels CC BY; the audio itself is third-party) | Cnn14 327 MB; MobileNetV1 23.6 MB, V2 20.8 MB |
| YAMNet | tensorflow/models (Apache-2.0 per repo header, but GitHub reports NOASSERTION) | README has no license statement (VERIFIED absence). Kaggle page unreadable → UNVERIFIED | AudioSet | "3.7M weights", 521 classes, 0.96 s frames at 16 kHz |
| EfficientAT (Schmid et al.) | MIT (VERIFIED) | README states no weights license (VERIFIED absence) → treat as unlicensed | AudioSet | 0.98–68 M params, mAP 43.2–49.8 |
| MusiCNN (Pons et al.) | ISC (VERIFIED) | In-repo, presumably ISC (UNVERIFIED) | MagnaTagATune / MSD | small |
| **Essentia** library + essentia.js | **AGPL-3.0** (VERIFIED). Licensing page: "Affero GPLv3, for non-commercial applications … before deciding to licence it under a comercial licence" [sic] | Models page: "All the models created by the MTG are licensed under CC BY-NC-SA 4.0 and are also available under proprietary license upon request". **The licensing page says "CC BY-NC-ND 4.0"**, so the site contradicts itself (both VERIFIED). A commercial license is available from mtg-info@upf.edu; the price is not public | — | — |
| madmom (beat/onset/downbeat) | BSD-style code (VERIFIED) | "All model and data files are distributed under … Creative Commons Attribution-NonCommercial-ShareAlike 4.0" (VERIFIED, LICENSE) | — | — |

AudioSet does include "Singing", "Drum", "Bass guitar" and similar classes. Training our
own small tagger on AudioSet means downloading YouTube audio, which runs into YouTube's
terms. **Do not go this route.**

### 6.3 Drum transcription (learned)

Vogl, Dorfer & Widmer (ISMIR 2017, CRNN) and Southall et al. (2017) train on
ENST-Drums / MDB-Drums / RBMA, whose licenses are mostly non-commercial (UNVERIFIED
individually). The **commercially clean** route is **synthetic**: Magenta's Groove MIDI
Dataset / E-GMD and **StemGMD** (CC BY 4.0, VERIFIED, §8) give aligned drum hits with
labels. For DeckMix's goal (pattern similarity), the untrained §5.7 features are probably
enough. Transcription is a "later, if needed".

---

## 7. Per-stem embeddings for similarity

### 7.1 What to put in each vector

Today (`src/platform/embed-classical/`, model id `meyda-mfcc-chroma-v1`): 13 MFCC means + 12
chroma = 25 floats per track, compared in `src/core/embedding-search.ts`. The proposal
keeps that shape but computes three vectors on different components:

| Vector | Computed on | Contents | Dims |
|---|---|---|---|
| **drums** | Percussive component P | 3×16 bar pattern (§5.7), per-band density, swing, syncopation, percussive centroid mean/std, 13 MFCC mean of P | ~70 |
| **bass+melody** | Harmonic component H | 12 chroma (tonal colour), 12 bass-chroma (<250 Hz), 13 MFCC mean+std of H, spectral contrast (6 bands), key-strength | ~70 |
| **vocals** | Frames where P(vocal) > θ, on the centre-harmonic-foreground map | 13 MFCC mean+std **over vocal frames only**; f0 median, 10th–90th percentile range (≈ register / voice type); vibrato rate/extent; vocal coverage % of the track; mean vocal segment length | ~35 |
| **vocal timeline** | — | P(vocal) per 0.5 s, quantised to 8 bits (or a 1-bit on/off plus confidence) | 600 per 5 min |

**Similarity:** cosine per vector after per-dimension z-scoring across the library (stored
μ/σ). The drum pattern uses max-over-beat-shift cosine. **Show three scores and never
fuse them** ("drums similar · vocals different"), as ROADMAP already decided. If a track
has less than ~5% vocal coverage, the vocal score is **"no vocals"**, not a number. That
follows the no-silent-substitution rule.

**Mix Assist vocal clash:** overlap(A, B, offset) = Σ_t P_A(t) · P_B(t + offset) over the
planned transition window. Pick the transition point that minimises it, and say on screen
when no clash-free window exists.

### 7.2 Storage

| Item | Size per track | 360 tracks |
|---|---|---|
| 3 vectors (~175 float32) | ~0.7 KB | ~250 KB |
| Vocal timeline (600 × uint8) | 0.6 KB | ~220 KB |
| **Understanding total** | **~1.5 KB** | **~0.5 MB** (IndexedDB, keyed by content hash like the existing embedding cache) |
| Playable stems, 4 × stereo 16-bit PCM | ~212 MB | ~76 GB ✗ |
| Playable stems, 4 × Opus 128 kbps (WebCodecs AudioEncoder, a browser API) | ~19 MB | ~7 GB |
| Stored masks instead of stems (low-res, 8-bit) | ~3–50 MB | 1–18 GB. **Patent risk, see US 11,740,862 in §9** |

### 7.3 Inference cost of an own neural model (for option 4, estimates)

An Open-Unmix-sized model is ~4.4 GFLOP per second of audio (my estimate: 3 BLSTM layers
at hidden 512 × 43 frames/s × 4 targets), so ~1.3 TFLOP per 5-min track:
- WASM SIMD + 4–8 threads (practically 20–40 GFLOPS on a U-series CPU, UNVERIFIED): **~0.5–1
  min per track → 3–7 h for 360.**
- WebGPU on Iris Xe (peak ~2 TFLOPS fp32; LSTMs use it poorly, conv/attention models
  better): **~10–30 s per track** (UNVERIFIED).
- HT Demucs-class models: the measured ~6.4 min per track in WASM (§2) → ~38 h. **Not for
  the browser.**

DeckMix is already cross-origin isolated in dev: `vite.config.ts` sets COOP `same-origin`
and COEP `credentialless`, which WASM threads need. **Production hosting must send the
same headers**, or WASM falls back to one thread, which the UI must then say.

---

## 8. Training our own model: data, compute, legality

### 8.1 Datasets: verified licenses

| Dataset | Content | License (VERIFIED quote) | Commercial training? |
|---|---|---|---|
| **MUSDB18 / -HQ** | 150 full songs, 4 stems | sigsep: "requires that users request access, since the tracks can only be used for academic purposes". MedleyDB part "(BY-NC-SA 4.0)", Easton Ellises "(BY-NC-SA 3.0)" | **No** |
| **MoisesDB** | 240 songs, 47 artists, fine stems | HF card: "distributed under the Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License (CC BY-NC-SA 4.0)" | **No** (commercial license only by asking Music.AI; price not public) |
| MedleyDB, DSD100 / Mixing Secrets, Cambridge MT | multitracks | MedleyDB: BY-NC-SA (via the MUSDB page). Cambridge MT terms page returned 403 (UNVERIFIED) | No / UNVERIFIED |
| **Slakh2100** | 2,100 mixes synthesised from Lakh MIDI, 145 h; "at least one instance each of Piano, Guitar, Drums, and Bass"; **no vocals**; audio is **mono** | Zenodo 4599666: "Creative Commons Attribution 4.0 International (CC-BY-4.0)" | **Yes, with a caveat:** Lakh MIDI is "distributed with a CC-BY 4.0 license", but its MIDI files are transcriptions of copyrighted songs, and the author says attribution "is not feasible". The underlying compositions are a residual risk |
| **StemGMD** | 1,224 h of isolated drum-kit pieces, 9 channels, 10 kits | Zenodo 7860223: "Creative Commons Attribution 4.0 International". Rendered with "Logic Pro X sample libraries" | **Yes, with a caveat:** Apple's Logic sound-content terms govern the samples (UNVERIFIED whether they allow redistribution as a dataset) |
| Groove MIDI / E-GMD (Magenta) | drum MIDI (+ audio) | CC BY 4.0 per Magenta (UNVERIFIED, not opened) | Likely yes |
| **VocalSet** | 10.1 h a-cappella, 20 singers, technique exercises (scales, arpeggios, excerpts) | Zenodo 1492453: "Creative Commons Attribution 4.0 International" | **Yes.** It is not pop singing, so on its own it is a weak domain match |
| **ccMixter** | CC-licensed remix stems and **a-cappellas** | Site text is "CC BY-NC 4.0". **Each track carries its own license** (VERIFIED that it is per track) | **Only tracks under CC BY / CC0**, filtered one by one |
| Free Music Archive (FMA dataset) | Full mixes under their artists' CC licenses | Per track (UNVERIFIED) | CC BY/CC0 subset for **mixture-only** training (§8.2) |
| Jamendo (Ramona 2008) VAD corpus | 93 songs with vocal on/off labels | Tracks under Jamendo CC licenses, mixed incl. NC (UNVERIFIED per track) | Evaluation only, unless filtered |

### 8.2 Ways to get commercially clean training signal

1. **Synthetic remixing from clean parts (recommended starting point).** Draw drums from
   StemGMD, bass/other from Slakh (mono, so use random panning), and vocals from ccMixter
   CC BY a-cappellas plus VocalSet. Mix with the Demucs-style random remixing (§4.3). That
   gives endless labelled mixtures, and **perfect vocal on/off labels for the VAD**. The
   weakness is domain gap: synthetic MIDI pop is not Mizrahi or HipHop.
2. **Procedurally generated dance music (DeckMix-specific).** Our own code synthesises
   drum machines, bass synths and pads (like the NMF templates in §5.3), sequenced in 4/4
   at 120–140 BPM. For House/Techno/Trance this is close to the real domain, and it costs
   nothing but engineering. It does not help with vocals.
3. **Commissioned stems (work-for-hire).** Pay producers for original tracks with stems,
   under a contract granting ML-training rights. Rough cost: $30–150 per track on freelance
   marketplaces, so 100–300 tracks ≈ $3k–45k (UNVERIFIED market estimate). This is the
   cleanest data covering Mizrahi and HipHop vocals.
4. **Mixture-only training (no stems needed).** MixIT, "Unsupervised sound separation
   using mixture invariant training" (Wisdom et al., NeurIPS 2020, arXiv:2006.12701):
   mix two mixtures, train the model to separate into M outputs that can be re-assigned to
   rebuild each input mixture. It learns from any pile of CC BY mixes. Quality for music
   is below supervised, and it becomes a strong semi-supervised add-on when combined with
   route 1.
5. **Commercial dataset license.** MoisesDB via Music.AI (ask). Essentia/MTG via UPF.
   MUSDB is realistically unobtainable: it is a compilation of several rights holders with
   no single licensor.
6. **The owner's own library.** This is a legal question, not a technical one. **Israel's
   Ministry of Justice opinion (Dec 2022)** says "the use of copyrighted content to train a
   machine-learning tool is likely to be permissible as 'fair use'". It excludes content
   that "consists of the works of a few individual creators", it "does not discuss the
   output", and it is **non-binding** (VERIFIED via law.co.il). A separator is not a
   generator competing with the artists, which helps. But selling in the US/EU brings
   their law in, and there are no stem targets in a library anyway. It is usable for
   routes 4 and 6, and for **evaluation** (hand labels), which is clearly fine.
   **Get a lawyer's view before shipping weights trained on it.**

**Do not "distil" from Demucs/UMX-L/etc.** Using their outputs as training targets
makes our weights derived from research-only or NC weights. That is the same taint in a
different form.

**Does MUSDB taint weights trained on it?** Nobody has settled this legally. The
MUSDB page itself states no terms for trained models (VERIFIED absence). However: access
requires agreeing to academic-only use, which is a contract regardless of copyright; some
of its tracks are CC BY-**NC**-SA, and whether weights are an "adapted work" under CC is
unresolved; and the Demucs author and third parties treat MUSDB-trained weights as
non-commercial (issue #327 comments). **Treat it as tainted.** This is also why the
"MIT" label on umxhq's Zenodo record is not a safe harbour.

### 8.3 Compute and model size (estimates, UNVERIFIED)

| Model | Params | fp16 download | Training data | Training compute | Expected SDR |
|---|---|---|---|---|---|
| VAD (§6.1) | 0.05–1 M | <2 MB | 20–100 h synthetic mixes | Hours on one consumer GPU, or even a CPU | n/a. Target ≥ 88% frame accuracy |
| Small band-split GRU separator | 2–5 M | 4–10 MB | 100–300 h (remixed) | 2–7 days on one RTX 4090-class GPU (rented at ~$0.5–1/h → $50–200) | 5–7 dB if data is good |
| BS-RoFormer-class | 30–90 M | 60–180 MB | 500+ songs of real stems | Multi-GPU weeks | 9–12 dB, **out of reach without real stems** |

Training can use any framework on a rented GPU. The *shipped* inference is our own
TS/WASM/WebGPU (browser) or Rust (Tauri) code reading our own weight file. Writing the
inference kernels (STFT, conv, GRU/attention, masks) is the smaller part of the work, and
the data is the larger part.

### 8.4 The data decision the owner must make

For vocals, **there is no free, commercially clean, in-domain multitrack set.** So:
(a) accept synthetic + CC BY a-cappella data and its domain gap; (b) pay for commissioned
stems; or (c) get a legal opinion on training with the owner's library under the Israeli
MoJ reasoning, combined with mixture-only training. For "understanding" (options 1–2),
(a) is enough. For playable stems (option 4), probably (b) or (c) is needed to approach
commercial quality.

---

## 9. Patents a from-scratch implementation could still infringe

Writing our own code does **not** avoid patents. Patents cover *methods*, and copyright
covers code. **This is not a freedom-to-operate (FTO) search.** The claim summaries below
come from Google Patents pages read through a summarising tool, so the real claims contain
more limitations than shown. A patent attorney must read the full claims.

One DJ software maker publishes this patent list (VERIFIED list; the maker is no longer named, v0.12.3):

| Patent | Title (VERIFIED) | Priority / expiry (Google Patents) | Why it matters to DeckMix |
|---|---|---|---|
| **US 10,887,033** | "Live decomposition of mixed audio data" | 2020-03-06 / ~2040 | Claim 1 (summary): receive a continuous stream of mixed audio, decompose it with an AI system, and play output from the decomposed data *while still receiving*. → **Real-time / on-the-fly stem playback** |
| **US 11,216,244 B2** | "…decomposing and recombining of audio data in real-time" | 2020-03-06 / 2040 | Claim 1 (summary): decompose mixed input into a track resembling a source, and generate and play output. As summarised it reads **broad**; the real claim must be read |
| **US 12,461,704 B2** | "AI-based DJ system and method for decomposing, mixing and playing of audio data" (granted 2025-11-04) | 2020-03-06 / 2040 | Summary: on-the-fly processing with "playback starting within 2 seconds" of receipt. → **Real-time decomposition**. Offline whole-file pre-computation may fall outside it (attorney question) |
| **US 11,347,475 B2** | "Transition Functions of Decomposed Signals" | 2020-03-06 / 2040 | Claim 1 (summary): decompose track 1, recombine so the output ≈ the input, **fade the decomposed signals with different transition functions**, and start track 2 before all of them reach silence. → **Directly relevant to a Mix Assist that fades vocals separately from drums.** Note: *choosing the transition point* from a vocal timeline without decomposing audio is a different method. Keep half 1 on that side of the line |
| **US 11,740,862 B1** | "Method and system for accelerated decomposing of audio data using intermediate data" | 2022-11-22 / 2042 | Claim 1 (summary): identify the song, load **pre-computed intermediate data** for it, and **combine it with the input audio** to obtain the separated output. → **Reads on "store compact masks per track and apply them to the audio at playback"** (§7.2). Storing finished stem audio may avoid "combining", but "instrumental = mix − vocals" might not |
| US 11,462,197 / JP 7136979 | Audio effect (pitch shifting) | — | Only if pitch-shifting decomposed signals |
| EP 4005243, DE 202020005830, AU, JP, NZ family members | Decomposing/recombining/visualising | — | EU/Germany coverage. **No Israeli patent is listed**, but the sale markets matter, not the developer's location |

Others found:
- **US 10,014,002 B2**, "Real-time audio source separation using deep neural networks"
  (Red Pill VR). Claim 1 (summary): 1.5–3 s fragments → spectrogram → DNN binary masks →
  inverse → cross-fade the fragments. Status: **"Expired - Fee Related"**, so it is free.
- **US 11,532,317 B2** (Munster Technological University), a distributed upload-and-queue
  NMF decomposition service. Active to 2041, but it claims a **client/server** system.
  DeckMix has no server. If a server ever appears, re-check.
- **The multi-track stem format:** described as "patent encumbered" by one blog. No number found
  (UNVERIFIED).
- **Two other DJ software makers, AudioShake, AlphaTheta:** my searches found no patents on stems or
  separation. **This is not proof that none exist** (UNVERIFIED).

**Practical reading:** the patent exposure is concentrated in **playing and mixing
decomposed audio** (half 2 and any per-stem crossfade), not in **analysing** audio
(half 1). That is another reason to ship half 1 first.

---

## 10. Phasing recommendation and time estimates

| Phase | Where | Deliverable | Processing time, 360 tracks | Gate |
|---|---|---|---|---|
| **A: classical understanding** | Browser, now (a new platform module behind a port in `core/ports`, like `src/platform/embed-classical/`) | HPSS + REPET-SIM + stereo cues → three similarity vectors + vocal timeline + visible confidence and "mono / uncertain" labels | ~5 s per track, measured (§5.8) → **~10 min with 4 workers** (older CPU; the 7440 should be faster) | Owner hand-labels vocal on/off on 30 tracks (House/Techno/Trance/HipHop/Mizrahi). Report frame accuracy per genre. Owner judges 20 "drums similar" pairs by ear |
| **B: tiny trained VAD** | Browser | Classifier over the §5.6 features, or a small CNN, trained on synthetic CC BY mixes | +1–2 s per track | Only if A misses the target (suggested ≥85% frame accuracy on dance genres). Data licensing checklist (§8.1) signed off |
| **C: rough classical stems (optional)** | Browser | "Drums / no drums / karaoke-ish" toggles from HPSS + centre extraction, pre-computed, visibly labelled "rough" | Real time or ~5 s per track | **Patent FTO on per-stem playback and transitions (§9)** |
| **D: own neural separator** | Tauri (Rust + GPU/CPU), after v1.0 | 4-stem pre-computed stems as Opus, with a visible progress counter overnight | Browser WASM: 3–7 h (small model, estimate). Tauri native: likely 2–4× faster (estimate) | Data decision (§8.4) + FTO opinion + measured SDR on our own clean test set |

---

## 11. Consolidated license table (code vs weights vs training data)

| Item | Code | Weights | Training data | Commercially usable weights? |
|---|---|---|---|---|
| Demucs v4 | MIT: "Permission is hereby granted, free of charge…" (VERIFIED) | "not covered by the MIT license, and are provided only for scientific purposes" (VERIFIED, #327) | MUSDB-HQ (academic) + 800 internal songs | **No** |
| Open-Unmix umxhq | MIT (VERIFIED) | Zenodo: "MIT License" (VERIFIED) | MUSDB18-HQ, "can only be used for academic purposes" | **Doubtful** (taint, §8.2) |
| Open-Unmix umxl | MIT | "only licensed for non-commercial use (CC BY-NC-SA 4.0)" (VERIFIED) | "private stems dataset" | **No** |
| Spleeter | MIT (VERIFIED) | Release assets of the MIT repo; no separate statement found | Deezer internal, "not trained … with musdb18 data" (VERIFIED) | Probably, but UNVERIFIED. Excluded anyway by the owner's rule |
| BS-/Mel-RoFormer, MDX23C, SCNet community weights | MIT reimplementations (VERIFIED for lucidrains, ZFTurbo, starrytong) | **No license stated** (VERIFIED absence in the ZFTurbo list) | MUSDB ± undisclosed | **No** (all rights reserved by default) |
| freemusicdemixer | MIT (WASM + JS) | "proprietary and not covered by the MIT license" (VERIFIED) | Demucs | **No** |
| Essentia / essentia.js | **AGPL-3.0** (VERIFIED) | CC BY-NC-SA 4.0 (models page) / CC BY-NC-ND 4.0 (licensing page), contradictory. Proprietary license on request | various | **Only with a UPF license** |
| madmom | BSD-style (VERIFIED) | CC BY-NC-SA 4.0 (VERIFIED) | — | **No** |
| PANNs | MIT (VERIFIED) | CC BY 4.0 (VERIFIED) | AudioSet (YouTube) | Yes as licensed, but data provenance is murky. Excluded by the owner's rule |
| EfficientAT | MIT (VERIFIED) | No statement (VERIFIED absence) | AudioSet | No (unlicensed) |
| YAMNet | Apache-2.0 repo (GitHub: NOASSERTION) | UNVERIFIED | AudioSet | UNVERIFIED |
| meyda (already a dependency) | MIT (not re-verified here) | — | — | n/a. **Note:** an existing library already in DeckMix. See open question 5 |

---

## 12. Risks

1. **The vocal timeline under-performs on dense productions.** Mizrahi and HipHop have
   centred, harmonically rich leads and heavy vocal processing (autotune kills the
   "fluctogram" vibrato cue). Mitigation: measure per genre, show confidence, and keep a
   manual "vocal here / not here" correction per track (the same pattern as the downbeat version's bar
   correction).
2. **Mono or near-mono masters** remove the stereo cue. Mitigation: detect it and say so.
3. **Classical rough stems (option C) disappoint.** Users compare against commercial DJ software. Label
   them "rough" or skip C.
4. **Patents (§9)** on per-stem playback and transitions, and on stored "intermediate
   data". Mitigation: ship analysis first, and get an FTO opinion before any stem playback.
5. **Training-data provenance** (§8). One tainted source contaminates shipped weights.
   Mitigation: a data manifest recording source, license and date for every file, checked
   like the repo's other invariants.
6. **Performance claims are estimates.** Only the classical front-end was measured, and on
   a 10th-gen 7410, not the 7440. Re-measure on the real target in the browser before
   promising times.
7. **Production headers.** Without COOP/COEP on the real host, WASM threads are unavailable
   and processing is 4–8× slower. The UI must surface that.
8. **Storage.** Opus stems ≈ 7 GB for 360 tracks. The browser storage quota and eviction
   need a visible budget.

---

## 13. Open questions for the owner

1. **Is "understand first, play later" the right order?** It gives three similarity
   scores and the vocal timeline soon, with no training and no patent exposure. Playable
   stems come much later.
2. **What accuracy is "good enough" for the vocal timeline?** Proposed: ≥85% of half-second
   slots correct on House/Techno/Trance, with HipHop/Mizrahi measured and reported
   separately. Will you hand-label ~30 tracks (vocal on/off) to measure it?
3. **For playable stems, which data route?** (a) Free synthetic + CC BY data, which is
   lower quality. (b) Pay for commissioned stems, roughly $3k–45k. (c) Ask a lawyer about
   training on your own library under the Israeli fair-use opinion.
4. **Will you pay for a patent freedom-to-operate opinion** before any stem playback or
   per-stem crossfade ships? Without it, half 2 carries known risk from the §9
   patents.
5. **Does "no existing software" include the tools we build with?** For example PyTorch to
   *train* our model, WebCodecs/Opus (a browser feature) to store stems, and **meyda**,
   which DeckMix already uses for MFCC/chroma. The report assumes build-time tools and
   browser APIs are fine, and that runtime libraries such as meyda get replaced by our own
   code over time.
6. **Mono tracks and stems:** is it acceptable that some tracks show "vocal detection
   less reliable (mono)" rather than a guess?

---

## 14. Sources (primary unless noted)

- Demucs: https://github.com/facebookresearch/demucs (README, LICENSE), https://github.com/facebookresearch/demucs/issues/327 (comments read via GitHub API), https://arxiv.org/abs/2211.08553, https://arxiv.org/abs/2111.03600, https://arxiv.org/abs/1911.13254
- Open-Unmix: https://github.com/sigsep/open-unmix-pytorch, https://zenodo.org/records/3370489, doi:10.21105/joss.01667
- Spleeter: https://github.com/deezer/spleeter, https://doi.org/10.21105/joss.02154 (PDF text extracted)
- MUSDB18: https://sigsep.github.io/datasets/musdb.html ; SiSEC 2018: https://arxiv.org/abs/1804.06267
- BS-RoFormer https://arxiv.org/abs/2309.02612 ; Mel-RoFormer https://arxiv.org/abs/2310.01809 ; BSRNN https://arxiv.org/abs/2209.15174 ; SCNet https://arxiv.org/abs/2401.13276 ; HS-TasNet https://arxiv.org/abs/2402.17701 ; Conv-TasNet https://arxiv.org/abs/1809.07454 ; MDX-Net https://arxiv.org/abs/2111.12203 ; MixIT https://arxiv.org/abs/2006.12701
- Community weights list: https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/pretrained_models.md
- Browser ports: https://github.com/sevagh/free-music-demixer , https://github.com/sevagh/demucs.onnx
- Singing voice detection: https://arxiv.org/abs/1806.01180 (Table 2 extracted) ; Lehner et al. ICASSP 2014 (via search summary, secondary)
- Classical: Fitzgerald DAFx 2010; Driedger/Müller/Disch ISMIR 2014; Rafii & Pardo TASLP 2013 / ICASSP 2012; Liutkus et al. TSP 2014; Huang et al. ICASSP 2012; Avendano & Jot JAES 2004; Barry et al. DAFx 2004; Lee & Seung NIPS 2000; Smaragdis 2003/2004; Dittmar & Gärtner DAFx 2014; Wu et al. TASLP 2018 (cited from knowledge, not re-opened: UNVERIFIED bibliographic details)
- Tagging/Essentia/madmom: https://essentia.upf.edu/models.html , https://essentia.upf.edu/licensing_information.html , https://zenodo.org/records/3987831 , https://github.com/fschmid56/EfficientAT , https://github.com/tensorflow/models/tree/master/research/audioset/yamnet , madmom LICENSE via GitHub API
- Datasets: https://huggingface.co/datasets/wearemusicai/moisesdb , https://zenodo.org/records/4599666 , https://colinraffel.com/projects/lmd/ , https://zenodo.org/records/7860223 , https://zenodo.org/records/1492453 , https://ccmixter.org/
- Law: https://www.law.co.il/en/news/2022/12/22/fair-use-of-copyrighted-content-for-aiml-training/
- Patents: https://patents.google.com/patent/US10887033B1/en , https://patents.google.com/patent/US11216244B2/en , https://patents.google.com/patent/US12461704B2/en , https://patents.google.com/patent/US11347475B2/en , https://patents.google.com/patent/US11740862B1/en , https://patents.google.com/patent/US10014002B2/en , https://patents.google.com/patent/US11532317B2/en
- DJ products: see §3 source list.
