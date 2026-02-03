#!/usr/bin/env python3
"""
SessionStart hook – enriches the run's start event with git context so the
UI can display branch / dirty-file info without an extra round-trip.

Sends an info event containing:
    source      – how the session was started (startup / resume / clear)
    git_branch  – current branch name (if available)
    git_dirty   – number of uncommitted changes (if available)
"""

import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from send_event import send  # noqa: E402


def _git(args: list[str]) -> str:
    """Run a git command and return stdout, or empty string on failure."""
    try:
        result = subprocess.run(
            ["git"] + args,
            capture_output=True, text=True, timeout=5,
        )
        return result.stdout.strip() if result.returncode == 0 else ""
    except Exception:
        return ""


def main():
    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError):
        input_data = {}

    source = input_data.get("source", "unknown")

    context: dict = {"source": source}

    branch = _git(["rev-parse", "--abbrev-ref", "HEAD"])
    if branch:
        context["git_branch"] = branch

    dirty_output = _git(["status", "--porcelain"])
    if dirty_output:
        context["git_dirty"] = len(dirty_output.splitlines())
    else:
        context["git_dirty"] = 0

    send("info", json.dumps({"event": "session_start", **context}))
    sys.exit(0)


if __name__ == "__main__":
    main()
