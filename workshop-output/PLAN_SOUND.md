# PLAN — v0.9.10 vocal timeline (file-level)

Contract: `workshop-output/FEATURE_SPEC_SOUND.md` (approved 01/10). Nothing here reopens a product decision.
Claim: version **v0.9.10** — `git fetch --prune && git branch -r --no-merged origin/main` run 01/10: only `origin/seorocket-recommendations/soundgrid`, unrelated.

## 1. Current architecture (traced, not remembered)
- `Library.tsx` runs three passes after a scan: tags → `queueLibraryAnalysis` (hash, decode, BPM/key/waveform, analysis cache) → `applyEmbeddingBackfill` → `queueEmbeddingBackfill` (`platform/source-fsaccess/library.ts` ~552). The last is the pattern to copy: `analysisState === 'analyzed'` filter, `concurrency: 1`, `signal.cancelled`, **cache first**, per-track `onUpdate(patch)` with a named state + error text, `catch` → `failed` visibly.
- Embedding runs in its own Worker (`platform/embed-classical/{index,worker,protocol}.ts`, `?worker` import pinned by `tests/repo/worker-import-syntax.test.ts`), PCM **transferred** (copy first if a second consumer exists — the 20/09 all-zeros bug). Cache: `embed-cache-idb` keyed by hash + model id, version constant in `version.ts`.
- `PcmData` (`core/ports/analyzer.ts`) carries all channels → stereo/mono is visible to DSP. **No FFT exists in `src/core`** (meyda has one inside the embedder only). `core/` must stay pure → we add our own small FFT.
- Overview strip: `WaveformOverview.tsx` (20 px, `h-5`), box elements over the canvas (played shade, loop box from v0.12.10), geometry helpers in `core/waveform-overview.ts`.
- Tagging: `core/tagging.ts` (`pickVocalSample`, `vocalSpotSec`, `VocalTag{atSec,answer}`), `TaggingScreen.tsx` vocal mode, `controls.ts` `tagPrepare/tagPlayVocal(~4584)/tagSaveVocal(~4677)`, `tagging-idb/store.ts` (`deckmix:tag:vocal:<hash>` — **one record per song today**), export with `vocal` key.

## 2. Thin end-to-end slice
One synthetic-but-real path from decode to pixels: *worker computes a tri-state half-second timeline for one track → cached → patched into the store → a 4 px lane on that deck's overview*. Everything else (tagging change, counters, measurement) hangs off it. Order below puts **tagging first**, so Shalom can label while the DSP is built — and the DSP is frozen in git before his labels are scored.

## 3. Files

**Add — pure (`src/core/sound/`)**
- `fft.ts` — radix-2 real FFT with precomputed twiddles, Float32. Test: known sine → bin; Parseval.
- `vocal-timeline.ts` — the contract: `VocalCell = 0 none | 1 vocal | 2 unsure`, `VocalTimeline { cellSec: 0.5, cells: Uint8Array, stereo: boolean }`, `VocalState` (named, below), `vocalStateOf(...)`, strip geometry `vocalStripSegments(timeline, durationSec, widthPx)` (merge runs; a run shorter than 1 px is kept — nothing vanishes), summary `dashedFraction`.
- `vocal-presence.ts` — `detectVocalTimeline(pcm): VocalResult` = the DSP: downmix/decimate to ~22 kHz, STFT (N 2048, hop 1024), HPSS by median filters (insertion-sort medians, research §5.8: ~4–5 s/track), features per frame — harmonic-foreground energy in 200 Hz–4 kHz, centre-panned share of it (stereo only: ψ/φ of research §5.4), 4–8 Hz pitch-motion cue (fluctogram-lite), MFCC-2–6 variance; hand-tuned weighted sum → 1 s median → hysteresis → cells; frames where the cues disagree or are weak → `2 unsure`. Mono ⇒ `stereo:false`, no stereo cue, cells with weak evidence → unsure. Returns `{state, timeline|null}`; **never throws on degenerate input** — returns the named state.
- Weights/thresholds are **hand-set on the owner's *training* clips only** (the non-sealed ones); constants live at the top with the reason, same style as `core/downbeat.ts`.

**Add — platform**
- `src/platform/vocal-timeline/{index,worker,protocol}.ts` — Worker mirror of `embed-classical` (`?worker`, `onerror` → every pending resolves with an error, main-thread fallback via `detectCapabilities().webWorker`). Request carries PCM **copied before transfer** (decode also feeds nothing else today, but the copy is cheap insurance and the comment says why).
- `src/platform/vocal-timeline-idb/{store,version}.ts` — `idb-keyval`, key `deckmix:vocalTimeline:<hash>`, value `{ version, state, note?, cells (Uint8Array), stereo }`; `VOCAL_TIMELINE_VERSION = 1` with the "stale entry is a silent-skip risk" comment. **Degraded results are stored too** (mono, silent, too short) so they are not recomputed; a *failed* decode is not cached (retried next scan, version bump or manual "analyse again" — spec open decision #3 → default: next scan).

**Change**
- `src/core/types.ts` — `Track`: `vocalState?: VocalState`, `vocalNote?: string`, `vocalTimeline?: VocalTimeline`. `VocalState = 'queued' | 'analysing' | 'ready' | 'mono' | 'no-vocals' | 'too-short' | 'silent' | 'failed'`; labels (Hebrew + English) in `core/library-list-copy.ts`-style table so the text is one source.
- `src/platform/source-fsaccess/library.ts` — `queueVocalTimelineBackfill(tracks, onUpdate, {signal, concurrency:1})`, a sibling of the embedding backfill; filter `analysisState==='analyzed' && !vocalState-final`; cache first; `catch` → `failed` + message; progress callback as the embedding one.
- `src/app/components/Library.tsx` — `applyVocalBackfill(scan)` called after `applyEmbeddingBackfill` settles (fire-and-forget, same `void` rule); header counter "N tracks not analysed for vocals" built like the existing skipped/queued badges from `library.tracks[].vocalState`.
- `src/app/components/WaveformOverview.tsx` — prop `vocal`; a **4 px lane** at the bottom (DOM/canvas layer over the existing canvas, `pointer-events-none`), segments from `vocalStripSegments`: solid = vocal, hairline = none, dashed (CSS repeating gradient) = unsure, dotted = not analysed. One new neutral colour token. Height of the overview stays 20 px.
- `src/app/components/Deck.tsx` — pass `vocal={deck.track…}`; the named state text next to the title only when not `ready` (mono / too short / silent / failed / analysing).
- `src/core/hints.ts` — `deck.vocalStrip` (the four shapes in words; Hebrew).
- **Tagging (ground truth), first:** `src/core/tagging.ts` — `VOCAL_CLIPS_PER_SONG = 3`, `vocalSpotsSec(trackId, durationSec): number[]` (three fixed spots in the 15–40 / 40–65 / 65–85 % regions, deterministic like today's); `VocalTag` gains `clipIndex` and `MARK_SCHEMA`-style schema bump so old one-clip records are readable as clip 0; `pickVocalSample` unchanged (30 songs); counter counts clips (n/90). `tagging-idb/store.ts` key becomes `…:vocal:<hash>:<clipIndex>` (read old key as clip 0). `controls.ts` `tagPlayVocal/tagSaveVocal` take the clip index; `TaggingScreen.tsx` vocal mode steps through 3 clips per song and shows the **definition of "vocal presence"** (proposal: any sung/rapped human voice audible as lead or prominent; backing oohs, chops, sub-second ad-libs = no) — wording is open decision #2, **placeholder until the owner confirms**. Export carries `clipIndex`.

**Add — scripts/docs**
- `scripts/verify-vocal-strip.mjs` — Playwright, synthetic WAVs (pattern of `verify-loop-band.mjs`).
- `scripts/measure-vocal-timeline.mjs` — against the owner's real library and `deckmix-tags-*.json` `vocal` rows: agreement per clip (cells inside the 5 s clip: majority; `unsure` abstains and is counted), always-"vocal" baseline, dashed fraction, per genre, ms/track and memory.
- `docs/handoff/v0.9.10.md` (at close), `ROADMAP.md` row, `HANDOFF.md` line (**budget: 14,942/15,000 bytes — trim something before adding**).

## 4. Type / failure behaviour
| Situation | State shown | Cached |
| --- | --- | --- |
| normal stereo | `ready` | yes |
| mono (1 channel, or L≈R) | `mono — less sure`, cells weak → dashed | yes |
| track < 30 s | `too short` | yes |
| RMS ≈ 0 | `silent` | yes |
| all cells none | `no vocals` (hairline) | yes |
| decode / worker error | `failed: <message>` | no |
| not reached yet | `not analysed` (dotted) | — |
`unsure` is never drawn as empty. A cancelled rescan drops patches but the store write already happened (cache-first on the next run).

## 5. UI state model
`Track.vocalState` + `vocalTimeline` (store, serialisable: `Uint8Array` like peaks) → `WaveformOverview` lane. The lane is redrawn only when the timeline/width changes (elements/canvas layer, never per frame). Library counter derives from the same array.

## 6. Tests, cheapest layer first
- `tests/core/sound/fft.test.ts`, `vocal-timeline.test.ts` (segments: nothing < 1 px vanishes; dashed fraction; state mapping), `vocal-presence.test.ts` (synthetic: centre-panned vibrato tone ≈ vocal; side-panned pad ≈ none; silence; mono; short; every state reachable; no throw on 1-sample / NaN-free).
- `tests/core/tagging.test.ts` — three deterministic spots per song, inside regions, stable across calls; old one-clip record reads as clip 0.
- `tests/repo/` — worker import syntax already covers the new worker; add a check that `VOCAL_TIMELINE_VERSION` is mentioned in `HANDOFF`'s doc only if needed (skip).
- Browser: `verify-vocal-strip.mjs` — states render, overview 20 px / page 710 px, seeking over the lane works, no page errors, a failed decode is *named*.
- Real library: `measure-vocal-timeline.mjs` (time, memory, playback dropout: play a deck during the pass and watch `AudioContext` underruns via `getOutputTimestamp`/glitch counter if available, else report as not measured).

## 7. Risks, rollback, non-goals
- **Accuracy is unknown until measured; the target is a hypothesis.** 4 px readability is the owner's eyes.
- Memory/CPU of STFT per track unmeasured on his laptop → measure first (step 3) before wiring the pass.
- Rollback: remove the `applyVocalBackfill` call; stored records are inert. Tagging schema change is backward-readable.
- Non-goals: drums / bass+melody scores, any change to Mix Assist/`recommend.ts`/`Embedder`, trained models, stems.

## 8. Ordered steps (each ends with its check)
1. **Tagging: 3 clips per song** + definition text placeholder (`core/tagging.ts`, `tagging-idb`, `controls.ts`, `TaggingScreen.tsx`) → unit tests, `verify-tagging.mjs` extended, `npm run check`. **Hand to Shalom to start labelling.** *(needs open decision #2 answered, or ships the proposal wording as editable constant)*
2. `core/sound/fft.ts`, `vocal-timeline.ts` + tests → `vitest`.
3. `core/sound/vocal-presence.ts` + synthetic tests; then a **cost measurement** (Node script on real tracks: ms, MB) → numbers recorded. Stop and report if > ~10 s/track or > ~150 MB.
4. Worker + cache + `queueVocalTimelineBackfill` + `Track` fields → script run against a handful of real files; cached second run is instant.
5. UI lane + state text + hints + counter → `verify-vocal-strip.mjs` (incl. 710 px), owner looks at the 4 px on his screen (**decision #1**).
6. **Freeze the method in git** (commit with the constants), *then* open the labels: `measure-vocal-timeline.mjs` on training clips, then the sealed ones once. Record agreement vs baseline, dashed fraction, per genre.
7. `change-reviewer`, `npm run check`, docs (`v0.9.10.md`, ROADMAP ✅/⚠️ by the measured result, HANDOFF trimmed), commit, owner's how-to-check lines, `context_check.py`.
If agreement < 85%: v0.9.10 closes as ⚠️ with the numbers, and v0.9.10b (small trained classifier on permitted data) is the next proposal — not silently re-tuned on the sealed clips.
