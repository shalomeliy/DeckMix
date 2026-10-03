# FEATURE SPEC — v0.9.10 Vocal timeline (sound understanding, stage A, cut down)

Status: **draft for the owner's approval** (2026-10-01). No code written. Sources: ROADMAP.md §v0.9.10/§v0.9.15,
docs/research/stems-and-sound-understanding.md (option 1), four expert reviews (product, architecture, design, QA).

## Context and observed problem
The owner's mixing rule (ROADMAP §v0.9.15, 24/09): *vocals never over vocals; drums may overlap.* To follow it he must
know **where A's singing ends** so B's singing can come in. Today he finds out by ear. The app has no notion of "vocals".

## Target user and decision
Shalom, mid-mix, deciding "is A's vocal finished — can B's vocal enter?" He watches the waveform, not a table.

## Outcome
A thin strip per deck showing, along the whole track, where there are vocals / none / the app is unsure.
A display only: it does not suggest, perform, or change any mix (that is v0.9.15, and needs his re-approval).

## Goal / non-goals / assumptions
**Goal.** Per track, a vocal-presence timeline from classical DSP (no training, no source separation, no weights),
cached, computed in the background, drawn on the whole-track overview.

**Non-goals (decided with the owner, 01/10).**
- **No drums / bass+melody / vocal similarity scores in this version.** Experts: no live decision needs them yet, and there is
  no ground truth for drums or bass+melody (labels are vocal-only), so they would ship unvalidated — against "checked, not trusted".
  They move to a later cut (renumber in a gap of 5 when the owner asks).
- No change to `recommend.ts`, `embedding-search.ts`, Mix Assist, or the `Embedder` port. Nothing feeds v0.9.15 until boundary accuracy is measured.
- No stems, no playback of separated audio (patent caution US11347475; AlphaTheta US11176915B2 not touched).
- No trained model here; if the target is missed, that is v0.9.10b (ROADMAP).

**Assumptions.** The ~5 s/track cost is the research's number (§5.8), not measured on his laptop. Dance genres first (House/Techno/Trance);
Hip Hop/Mizrahi are measured and reported separately, not part of the target. All text Hebrew-first UI per project rule, layout LTR.

## Proposed experience
1. **Where.** A lane at the bottom of the 20 px whole-track overview (`WaveformOverview`), ~4 CSS px (≈3 physical on his screen),
   drawn as an element over the canvas like the loop box — the frequency colours stay untouched. The overview height and the 710 px page are not grown.
   The scrolling waveform gets nothing unless he asks after trying it. **Owner must look at it on his real screen** — 4 px is a risk (see Open decisions).
2. **Encoding by shape, not colour alone.** Solid bar = vocals. Hairline only = none. Dashed = unsure. Dotted flat line = not analysed.
   One neutral colour not used elsewhere (green = loop, yellow = bar lines, frequency colours = body).
3. **Named states in words**, next to the track title in the deck header, not inside the 4 px lane: `not analysed`, `mono — less sure`,
   `no vocals`, `too short`, `silent`, `decode failed: <reason>`. Unsure is **never drawn as empty**.
4. **Library counter** "N tracks not analysed for vocals", like the existing "N skipped" badge.
5. Hebrew strings for the above go through the existing hint/text system; hint `deck.vocalStrip` explains the four shapes.

## System / data implications
- New pure DSP in `src/core/` (HPSS-style median filter on the STFT, stereo-centre prior, vocal-presence cues → per-half-second presence + confidence). No DOM, no AudioContext.
- New background pass, a sibling of `queueEmbeddingBackfill` in `platform/source-fsaccess/library.ts`: runs after it, concurrency 1, cancellable with the same signal, **cache-first**.
  Decodes once, runs in a Worker (`?worker` import syntax is pinned by `tests/repo/worker-import-syntax.test.ts`); copy the PCM before any transfer (20/09 all-zeros bug).
- New small IndexedDB store `vocal-timeline-idb` with its own version constant (a time series, not an embedding). Degraded outcomes (mono, silent, too short, failed) **are cached too**, so they are not retried on every scan.
- `Track` gains `vocalState` / `vocalNote` (core/types.ts). Everything additive; rollback = remove the pass call.
- Unmeasured: memory (~60 MB STFT per track in the research) and CPU contention with live playback. Measure on his real library before declaring done.

## Acceptance criteria (observable)
1. After the library is scanned, every analysed track shows a strip; a track that cannot be analysed shows its **named** state — none is blank.
2. A mono file shows `mono — less sure` and a dashed strip; a silent file `silent`; a sub-30-second sample `too short`; a corrupt file `decode failed: …`. No state is shown as "no vocals".
3. Loading a track is never slower or blocked by this pass; playing a deck while the pass runs causes no audible dropout (measured, see verification).
4. Closing and reopening the app does not recompute (cache hit); bumping the version constant recomputes.
5. The page still fits 710 px, the overview is still 20 px, click/drag seeking on the overview works over the strip (pointer-events none).
6. **Accuracy (measured on his labels, section below):** on dance songs, agreement with the owner's labels ≥ 85% of *scored clips*, **above the always-"vocals" baseline**; plus the **fraction of the song drawn dashed** is reported, and dashed counts as *abstained*, not correct and not wrong (both numbers shown, never only the better one).
7. Boundary check (product's addition): on songs where a vocal start/end falls inside a labelled clip pair, report whether the strip's boundary is within ±1 bar of the owner's; reported, not a gate in this version.

## States
Loading: strip absent while `not analysed` queued (dotted line). Empty: `no vocals` hairline. Partial: dashed regions. Error: `decode failed` with reason. Recovery: next scan retries failed states once per version bump or on a manual "analyse again" (open decision #3).

## Accessibility, security, privacy, operational
- State is carried by shape + text, not colour alone; hint text for every shape.
- **SECURITY NOT TRIGGERED:** local analysis of the owner's own files, read-only, no network, no new dependency, no auth surface.
- Files are only read, never written (project invariant). No audio leaves the machine.

## Verification plan
- **Unit (`tests/core/`):** synthetic signals — centre-panned harmonic vs side-panned, silence, mono, very short, onset of "voice-like" modulation — each state reachable; strip geometry helper (like `overviewLoopBox`).
- **Repo checks:** worker import syntax; a doc/test pinning that the three similarity scores are not merged anywhere.
- **Browser script (pattern of `verify-loop-band.mjs`):** synthetic WAVs: strip states render; page 710 px; strip box doesn't block seeking; no page errors.
- **Real-library measurement (script, like `measure-downbeat.mjs`):** time per track, memory, and playback-dropout check on his machine.
- **Accuracy:** from the owner's labels, protocol frozen *before* the holdout is opened (v0.9.5 pattern: method committed to git, then scored):
  - Define "vocal presence" in the tagging screen text: **any sung or rapped human voice that is audible as a lead or prominent part; backing "oohs", chops and sub-second ad-libs = no** (to confirm).
  - **3 clips of 5 s per song** (start / middle / end region, fixed spots), **30 songs** (existing 6-per-genre sample, 2 per genre sealed). ~90 quick answers.
  - Answers yes / no / unsure; unsure excluded from the score and reported as a count.
  - Consistency: 10 clips re-answered blind a week later; his own agreement is the ceiling.
  - Report per genre; Hip Hop/Mizrahi separately.

## Decisions taken (expert disagreements resolved)
| Question | Options | Taken | Why |
| --- | --- | --- | --- |
| Scope | timeline only / timeline + 3 scores | **timeline only** | one live decision; no ground truth for the other two |
| Placement | overview lane / scrolling waveform / both | **overview lane** | decision needs the whole song at a glance |
| Ground truth | 1 clip / 3 clips per song / owner marks vocal sections on the waveform | **3 clips per song** | measurable with the tool that exists; section marking is more work for him and needs a new screen — kept as the fallback if clips prove too coarse |
| Behaviour | display / suggest / perform | **display only** | owner has not decided; belongs to v0.9.15 |
| Scores shape (vectors vs scalars) | — | **deferred** | scores are out of scope |

## Open decisions and tradeoffs
1. **Is a 4 px lane readable on his screen?** If not: grow the overview 20→24 px and shrink the waveform by 4 (the 710 px test still holds) — his call after seeing it.
2. **Definition of "vocal presence"** (rap counts? backing vocals? chops?) — needs his answer before labelling starts; the wording above is a proposal.
3. **Re-analyse trigger** for failed tracks: automatic on version bump only, or also a button.
4. Whether the strip also appears (duplicated) in the scrolling waveform after he tries the overview.
5. The 30 vocal tags do not exist yet (0/30); the 3-clips-per-song labelling is a prerequisite for the accuracy criterion, and needs a small change to the tagging screen (`pickVocalSample`, `vocalSpotSec`, `VocalTag`, export schema).

## Risks
A confident wrong "no vocals" at a mix point would teach him to distrust the strip; hence dashed-not-empty and no feeding of v0.9.15 before the boundary check. Memory/CPU of the STFT on his laptop is unmeasured. 85% on clips from 30 songs may not hold on the whole library.
