---
name: deckmix-debug
description: DeckMix bug diagnosis and fix loop (adapted from compound-engineering ce-debug). Use in the DeckMix repo when something is broken, failing, glitching or slow.
---

# DeckMix Debug and Fix

Adapted from `ce-debug` in EveryInc/compound-engineering-plugin (MIT, (c) 2025 Every). Rewritten for DeckMix (shalomeliy/DeckMix): a browser DJ app, React 19 + TS strict + Vite, Web Audio / AudioWorklet, Web MIDI (Pioneer DDJ-FLX4), File System Access. The repo's `CLAUDE.md` always wins over this skill where they differ.

**Done when:** the causal chain from trigger to symptom is stated with no gaps and with `file:line` evidence, and either a verified fix is committed and pushed to `main`, or Shalom chose diagnosis only and got the summary.

**Escalate rather than persist:** 2-3 hypotheses exhausted without confirmation, or 3 failed fix attempts, means stop and diagnose *why* (table in Phase 2). One hypothesis, one change at a time. Changing several things to see what helps is shotgun debugging.

## Talking to Shalom

- Hebrew, masculine form, direct, no emojis.
- He is not a programmer. Every explanation and every question is written so a 10-year-old could follow it: plain words, a real-world comparison instead of a technical term.
- A question has 2-3 options, one short line each, with your recommendation marked. Use the host's question tool if it has one (AskUserQuestion, ask_decision); otherwise numbered options in chat. Never skip a question silently.
- His hand corrections (vocal marks, BPM, artist names) are ground truth. A bug where the app overrides or forgets one of them is a real bug, not a matter of taste.

## Phase 0: Triage and orientation

1. `git fetch --prune && git branch -r --no-merged origin/main` - an unmerged branch is a claim on its version. Then `git log --oneline origin/main -5`.
2. Read `HANDOFF.md` (status, known debt, open decisions). The bug may already be listed as debt, or a closed version in `docs/handoff/` may already describe the trap. `grep -ril <symptom words> docs/ HANDOFF.md ROADMAP.md`.
3. Start the dev server if the tools exist: `preview_start` with `deckmix-dev` from `.claude/launch.json`. Never `npm run dev` through Bash.
4. If Shalom says he already tried things ("keeps happening", "still broken"), ask what he tried *before* investigating.

**Trivial fast-path:** cause readable from the input, one-line fix, no tracing. Still say the cause and the fix before editing, and still run Phase 3's checks.

## Phase 1: Investigate

### 1.1 Reproduce

Reproduction is complete only when you hold a named, repeatable check that fails on this bug now and will pass once fixed, and you have run it and seen it fail on the exact symptom. "I read the code and see the problem" is not reproduction. DeckMix-specific instruments, cheapest first:

- **Pure logic in `src/core/`** (mapping, recommend, parseKey, scratch maths, beatgrid, vocal models): a vitest case in `tests/core/`. Run `npx vitest run <file>`.
- **Repo invariants** (docs, versions, names, paths): `tests/repo/`.
- **Audio engine / AudioWorklet / timing / sync:** no automated harness exists and faking an `AudioContext` tests the fake. Pull the maths into `core/` and test it there (the `core/scratch.ts` pattern), or use a recorded measurement in the running app via `javascript_tool` (positions, phase offsets, gains, with numbers written down).
- **Library / tags / analysis:** a small Node script against the real files (`C:\Users\Shalom\Music\Tracks`, reachable through the device folder tools when connected) with a minimal `File` shim, numbers recorded - the v0.1.7 pattern.
- **MIDI / FLX4:** trace `transport-webmidi/manager.ts:dispatch` -> `controls.ts` -> `mappings/flx4.ts`. Physical hardware is only on Shalom's desk: when needed, give him exact steps (which knob, which deck, what to watch) and what result means what.
- **UI:** DOM measurement with `javascript_tool`, errors with `read_console_messages`. Browser screenshots do not work here. Remember his screen is 1536x710 CSS px and everything looks ~24% smaller physically.
- **Performance:** a numeric baseline measurement first; code reading replaces neither the baseline nor the re-measurement.

Cannot reproduce here: say what was tried and what is missing, and ask Shalom for the one concrete thing needed (a file name, an exported marks JSON from `C:\Users\Shalom\Downloads`, the exact steps). Never start hypothesizing as if reproduction had succeeded.

### 1.2 Environment sanity

Right branch (`main`), deps installed, no stale `dist/`, the dev server is the current code. A dirty tree is a suspect: if uncommitted work could reach the failing behavior, `git stash push -u -m "debug: repro without WIP"`, rerun, then restore exactly that stash entry with `git stash pop --index` (and only if the push created one). Never auto-resolve conflicts in someone's uncommitted work. Parallel sessions push to `main` too: `git fetch` before blaming code.

### 1.3 Trace backward

From the symptom back to where valid state first became invalid. Read code to form a hypothesis, then confirm with observed values, never assumed ones. Use `codegraph_explore` if available instead of broad grep. `git log --oneline -10 -- <file>` on every file you read; a regression ("it worked before") gets `git bisect` with the reproduction check. Commit messages here say what was wrong and how it was found, so they are evidence.

### 1.4 Prior work

Search `docs/handoff/*.md`, `docs/research/`, `HANDOFF.md` debt, and project memory for the symptom. A previous fix that took the approach you are about to take, while the bug persists, is negative evidence: rule that hypothesis out first.

## Phase 2: Root cause

**Assumption audit first:** list every "this must be true" belief (the worklet is running, the store holds what the name says, the AudioContext is not suspended, the deck's BPM is the analyzed one and not a fallback). Mark each verified or assumed.

**Hypotheses** ranked by likelihood, with at least one competing explanation named before testing the top one. Each states: what is wrong and where (`file:line`), one concrete observation supporting it, the step-by-step chain from trigger to symptom, and for uncertain links a prediction that must also hold elsewhere.

**The DeckMix central rule is a hypothesis generator:** a `catch` that swallows, an early `return`, a default that quietly substitutes, a fallback nobody sees. Ask of every one on the path: how does the user find out? A silent skip is often the bug itself.

**Smart escalation** after 2-3 dead hypotheses:

| Pattern | Diagnosis | Next move |
| --- | --- | --- |
| Hypotheses point to different layers (core / platform / app) | Design problem, not a local bug | Present findings, propose a spec via `write-feature-spec` |
| Evidence contradicts itself | Wrong mental model | Re-read the path without assumptions |
| Works here, fails on Shalom's PC | Environment: Chrome version, audio device, MIDI, file names | List the differences, ask for the one that decides |
| Fix works but the prediction was wrong | Symptom patch | Keep investigating |

### Gate: present, then ask

Do not edit until the full chain is explained with no gaps. Then write the findings in Hebrew, simply: what was broken, why (one real-world comparison), where (`file:line`), the proposed fix and the files it touches, the test or recorded check that will prove it, and why existing tests did not catch it. Only after that, unless he already said "fix it", ask:

1. **Fix it now** (recommended when the fix is local)
2. **Just explain it, don't touch the code**
3. **Rethink the feature** - only when the cause is a wrong design, not wrong logic

## Phase 3: Fix

- **Branch rule overrides the upstream skill:** work directly on `main` (Shalom's standing instruction, 2026-10-03). No feature branch, no PR, unless he asks for one for this specific piece of work. `git fetch` first; a non-fast-forward push is stop-and-say, never force.
- Record the pre-fix scope: `HEAD`, `git status --short`, and keep the list of fix-owned files.
- **Test first:** put the regression check where existing coverage already owns the behavior (`tests/core/`, `tests/platform/`, `tests/repo/`). It must fail on the bug for the right reason and pass after. If no seam can reach the bug, do not write a shallow test for false confidence: record the missing seam and use the recorded measurement instead.
- **Minimal fix:** the root cause only. No drive-by refactors. Respect the layers: `core/` stays pure, new user actions go through `controls.ts`, cross-file imports use `@/*`.
- **Never write to the user's existing files.** Never break the stereo fallback or the keyboard path. Never weaken or delete a check to get green.
- Comment the invariant where it lives: why it exists and which bug comes back if someone "simplifies" it.
- **On a failed fix:** go back to Phase 2 and state what evidence killed the hypothesis before forming a new one. 3 failures = escalation table.
- Remove all debug instrumentation (tag it with one marker so one grep finds it).

## Phase 4: Verify and hand off

1. `npm run check` green (tsc + oxlint + depcruise + vitest). Re-run the Phase 1 reproduction on the original scenario and record the numbers.
2. Verify in the running app where the bug was visible, not only in the type checker.
3. Independent review of the diff with the `change-reviewer` agent.
4. Version: bump `package.json`, the "גרסה נוכחית" line in `HANDOFF.md`, and a `ROADMAP.md` row together. Update `HANDOFF.md` (status, debt) within its 15,000-byte budget. If `CLAUDE.md` changed, `CLAUDE-HE.md` changes in the same commit.
5. Commit only the fix-owned files. Message starts `vX.Y.Z:` and says what was wrong and how it was found (`59c5fe5` and `f8f5cf8` are the bar). Push to `main`.
6. Write Shalom the summary in Hebrew:

```
מה היה שבור: ...
למה (במילים פשוטות): ...
מה תוקן: ...
איך תבדוק בעצמך: 1) ... 2) ... ומה אמור לקרות: ...
הסימן שזה עדיין שבור: ...
כמה אני בטוח: גבוה / בינוני / נמוך
```

7. If the bug taught something not recoverable from the final code and test, run `deckmix-compound`.
8. At the end of a version, `python scripts/context_check.py` and act on the verdict without asking.

## Secrets

No token, key or auth header ever appears in output, files or commits. Capture risky output to a file and show only redacted excerpts.
