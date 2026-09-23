#!/usr/bin/env python3
"""Measure this conversation's cost, and say whether it should end.

Run at the close of every version / sub-version:

    python scripts/context_check.py

Why it exists: every turn re-reads everything written before it, so cost grows
with *conversation length*, not with task difficulty. The verdict replaces the
question "should I keep going here or start a new conversation?" — that question
should never be put to the owner, because a measurement answers it and a guess
does not.

    GREEN   start the next version in this conversation
    YELLOW  the version is closed and verified — say the conversation should end
    RED     stop; it must end now

YELLOW and RED always mean a **new conversation**, never `/clear`. Both wipe the
live context equally, so tokens are not what decides. `/clear` keeps appending to
the same transcript file, so it does **not** reset the numbers below — keep
clearing and this reads RED while the context is actually empty. One transcript
per version also keeps `--resume` and `/rewind` usable.

--------------------------------------------------------------------------
This file was moved into the repo in v0.2.9. It used to live in the global
`~/.claude/tools/`, which meant it did not exist in a remote session at all —
sessions closed versions without ever running it, and said nothing, which is
the silent skip this project forbids. It is here so it runs everywhere: Windows,
macOS (v1.0 targets a Mac build), and the Linux containers agents run in.

**The thresholds below are this repo's, calibrated on 2026-09-02**, and may not
match the ones the original global script carried. If you still have that file,
compare the four constants and keep whichever pair you trust — but keep them
*here*, in the repo, where every machine can read them.
--------------------------------------------------------------------------
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# --- thresholds -----------------------------------------------------------
# Calibrated against a real session on 2026-09-02: one version of work (v0.2.6,
# code + browser verification + docs) cost 5 owner turns and 3.09 MB. Size is
# the honest driver here, not turn count — a single turn that reads a file or
# takes a screenshot costs more than ten that do not.
TURNS_WATCH, TURNS_CLEAN = 25, 40          # owner prompts
MB_WATCH, MB_CLEAN = 2.5, 4.5              # transcript size on disk


def transcript_dir() -> Path:
    """Claude Code stores transcripts under ~/.claude/projects/<slugged cwd>/."""
    return Path.home() / ".claude" / "projects"


def slug(path: Path) -> str:
    """Claude Code's directory name for a project: every separator becomes '-'."""
    return "".join(c if c.isalnum() else "-" for c in str(path))


def find_transcript() -> tuple[Path | None, str]:
    """The active transcript, and a line saying how it was chosen.

    Returns `(None, reason)` rather than raising: a measurement that cannot be
    taken has to say so out loud, not read as zero.
    """
    root = transcript_dir()
    if not root.is_dir():
        return None, f"no transcript store at {root}"

    wanted = slug(Path.cwd())
    candidates = [d for d in root.iterdir() if d.is_dir()]
    exact = [d for d in candidates if d.name == wanted]
    pool = exact or candidates
    if not pool:
        return None, f"{root} has no project directories"

    # top level only: subagents/ holds separate transcripts that are not this one
    files = [f for d in pool for f in d.glob("*.jsonl")]
    if not files:
        return None, f"no .jsonl transcript under {pool[0]}"

    newest = max(files, key=lambda f: f.stat().st_mtime)
    how = "matched this working directory" if exact else (
        f"NO directory matched {wanted} — fell back to the newest transcript anywhere"
    )
    return newest, how


def count_owner_turns(path: Path) -> tuple[int, int]:
    """(owner prompts, assistant messages).

    A user line carrying a tool_result is the harness feeding output back, not a
    person typing; only the rest is a turn in the sense that matters.
    """
    turns = replies = 0
    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            kind = entry.get("type")
            if kind == "assistant":
                replies += 1
            elif kind == "user" and not entry.get("isMeta"):
                content = entry.get("message", {}).get("content")
                blocks = content if isinstance(content, list) else []
                if not any(
                    isinstance(b, dict) and b.get("type") == "tool_result" for b in blocks
                ):
                    turns += 1
    return turns, replies


def verdict(turns: int, mb: float) -> tuple[str, str, str]:
    """The worse of the two signals wins — one blown budget is enough."""
    if turns >= TURNS_CLEAN or mb >= MB_CLEAN:
        return "RED", "🔴", "Stop. Close this conversation now — do not start another version here."
    if turns >= TURNS_WATCH or mb >= MB_WATCH:
        return "YELLOW", "🟡", "The version is closed and verified. Say the conversation should end, and open a new one."
    return "GREEN", "🟢", "Start the next version in this conversation."


def main() -> int:
    # A Windows console defaults to cp1252, which cannot print the 🟢/🟡/🔴
    # verdict: the script died with UnicodeEncodeError on the owner's machine
    # (23/09) before saying anything — a measurement that silently isn't taken.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    path, how = find_transcript()
    if path is None:
        # Visible degradation, not a zero: a missing measurement must never be
        # mistaken for a green one.
        print("⚠️  context_check could not measure this conversation.")
        print(f"    {how}")
        print("    Verdict: UNKNOWN. Say so out loud rather than assuming 🟢.")
        return 2

    mb = path.stat().st_size / (1024 * 1024)
    turns, replies = count_owner_turns(path)
    name, mark, advice = verdict(turns, mb)

    print(f"{mark}  {name}")
    print(f"    transcript   {path.name}  ({how})")
    print(f"    owner turns  {turns}   (yellow {TURNS_WATCH}, red {TURNS_CLEAN})")
    print(f"    size         {mb:.2f} MB   (yellow {MB_WATCH}, red {MB_CLEAN})")
    print(f"    replies      {replies}")
    print(f"    → {advice}")
    if name != "GREEN":
        print("    → A NEW CONVERSATION, never /clear: /clear keeps writing to this")
        print("      same file, so it does not reset either number above.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
