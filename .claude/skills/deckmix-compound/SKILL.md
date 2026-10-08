---
name: deckmix-compound
description: Turn a solved DeckMix problem into a permanent lesson (adapted from compound-engineering ce-compound). Use in the DeckMix repo after a verified fix or finding that future sessions must not rediscover.
---

# DeckMix Compound: make each fix make the next one easier

Adapted from `ce-compound` in EveryInc/compound-engineering-plugin (MIT, (c) 2025 Every). The upstream skill writes to a new `docs/solutions/` folder. DeckMix already has homes for lessons and a rule that outranks prose, so this version uses those instead and creates no new folder. The repo's `CLAUDE.md` wins where they differ.

**Outcome:** one solved, verified problem becomes a durable lesson in the right DeckMix home, checked by `npm run check`, findable by the next session.

**One lesson per run.** Several lessons = several runs.

## The bar (keep it high)

A lesson earns its place only if it holds reasoning that is not readily recoverable from the final code, tests, comments or existing docs, and losing it would plausibly cause the bug to return, a real risk, or a big rediscovery. Counterfactual: if this lesson disappeared, would the next session reading the final code still be likely to repeat the mistake? Effort, diff size and "we finished something" do not qualify. If the bar fails, write nothing and say why in one line.

An existing lesson that has become wrong or incomplete qualifies: fix it in place, never add a duplicate.

Only document what is solved and verified. Unverified claims are marked as such or left out.

## Where the lesson goes - strongest home first

DeckMix's rule: **every bug caught once becomes a permanent check.** Prose is the fallback, not the default. Pick the first rung that can carry the lesson, and add a later rung only when it carries something the first cannot.

1. **A test that fails without the fix.** `tests/core/` for pure logic, `tests/platform/`, or `tests/repo/` for repository-wide invariants (names, paths, versions, a forbidden pattern in `src/`). Prove it fails with the fix reverted, then passes. A grep-style repo test is the right answer for "never do X again anywhere".
2. **A why-comment at the invariant's site.** It says why the invariant exists and which bug returns if someone "simplifies" it (the `position:absolute` note on the waveform canvas and the WAV chunk-seek note in `tags.ts` are the model). Not what the code does.
3. **The version record.** Open work or debt goes to `HANDOFF.md` ("חובות טכניים ידועים"), within its 15,000-byte budget; never raise the budget, move closed blocks out instead. A closed version's trap or measurement goes in `docs/handoff/<version>.md` (create it with original scope + outcome if absent, add its row to `docs/handoff/README.md`). Measurements carry numbers and the method.
4. **Research findings** (algorithm comparisons, accuracy numbers, why an approach was rejected) go to `docs/research/<topic>.md`.
5. **A working rule for all future sessions** goes in `CLAUDE.md` and `CLAUDE-HE.md` in the same commit (`tests/repo/claude-md-pair.test.ts` enforces it). Only for rules about how to work, not for facts about one bug.
6. **Something about Shalom** (a preference, a decision, a standing instruction, ground truth from his listening) goes to project memory, one fact per file, updating an existing file rather than duplicating. Not code facts; the repo holds those.

The commit message itself is part of the record: `vX.Y.Z:` + what was wrong + how it was found.

## Steps

1. **Extract** the problem, root cause, fix and evidence from the session (and from `deckmix-debug`'s summary if it ran). Before stating how code behaves, read the defining line on the current tree; soften anything you could not verify.
2. **Search for overlap:** `grep -ril` the symptom and key terms across `docs/`, `HANDOFF.md`, `ROADMAP.md`, `CLAUDE.md`, `tests/repo/`, and project memory. Update an existing entry if it covers the same problem.
3. **Apply the bar.** Fails -> stop, one line saying why.
4. **Choose the rung(s)** above and write. Hebrew docs stay in Hebrew; code comments and tests in English, matching the surrounding style.
5. **Validate** - these are enforced by `tests/repo/`, so break none of them:
   - every path named in a doc exists (or the line carries `<!-- dead-path -->` on purpose);
   - every commit SHA quoted resolves;
   - no hard-coded test-case count in `HANDOFF.md`;
   - `HANDOFF.md` under budget; the two `CLAUDE` files moved together.
   After any scripted (sed/python) edit to a doc, print the edited region and read it back.
6. `npm run check` green. Commit on `main` and push (Shalom's standing instruction: main only, no branch or PR unless he asks). `git fetch` first; never force.
7. **Report to Shalom in Hebrew,** two or three plain lines: what lesson was saved, where, and what it will prevent next time. No jargon. If nothing qualified, say so in one line and why.

## What not to do

- Do not create `docs/solutions/` or any new doc tree; the doc map in `CLAUDE.md` decides where things live, and changing it is a decision for Shalom.
- Do not paste whole investigations; keep the reasoning a future session needs.
- Do not record a lesson as a convention when a test can enforce it.
- Never weaken or delete a check to make the new lesson fit.
