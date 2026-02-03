#!/usr/bin/env python3
"""
Stop hook – fires after Claude finishes generating a response.

In session-based (multi-turn) usage this is distinct from process exit:
each __INPUT__ command spawns a fresh Claude process, and Stop fires at the
end of that single response before the process exits.  Surfacing this in the
UI lets operators see a clear "response complete" boundary in the log stream.

Sends a marker event with event=response_complete so the UI can render a
visual separator between successive turns.
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

    send("marker", json.dumps({
        "event": "response_complete",
        "session_id": input_data.get("session_id", ""),
    }))
    sys.exit(0)


if __name__ == "__main__":
    main()
