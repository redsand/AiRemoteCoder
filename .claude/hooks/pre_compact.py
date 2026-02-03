#!/usr/bin/env python3
"""
PreCompact hook – fires before Claude Code compacts (summarises) the
conversation context.

Context compaction is invisible to the UI under normal circumstances, yet it
can cause Claude to "forget" details that were discussed earlier in the
session.  Surfacing this as an event lets operators understand why behaviour
might shift mid-session.

Sends an info event with event=context_compaction so the UI can render a
visual marker at the compaction boundary in the timeline.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from send_event import send  # noqa: E402


def main():
    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError):
        input_data = {}

    trigger = input_data.get("trigger", "auto")

    send("info", json.dumps({
        "event": "context_compaction",
        "trigger": trigger,
    }))
    sys.exit(0)


if __name__ == "__main__":
    main()
