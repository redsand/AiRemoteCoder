#!/usr/bin/env python3
"""
PreToolUse hook – notifies the UI that Claude is about to invoke a tool.

Sends a tool_use event with phase=pre containing the tool name and a
truncated preview of the inputs.  Also performs lightweight safety checks
mirroring the reference implementation:
  - blocks recursive force-delete outside of safe directories
  - exits 0 in all cases so execution is never blocked by the hook itself
      (dangerous-command blocks use exit code 1 to halt the tool call)
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from send_event import send  # noqa: E402

# Directories where rm -rf is acceptable during development
_RM_SAFE_PREFIXES = ("trees/", "./trees/", "node_modules/", "./node_modules/",
                     "dist/", "./dist/", "build/", "./build/", ".data/", "./.data/")

_INPUT_MAX = 500  # chars – keep tool_use events small


def _is_dangerous_rm(tool_input: dict) -> bool:
    """Return True if this is a dangerously broad rm command."""
    command = tool_input.get("command", "")
    if "rm" not in command:
        return False
    has_force_recursive = ("rm -rf" in command or "rm --recursive --force" in command
                           or "rm -r -f" in command)
    if not has_force_recursive:
        return False
    # Allow rm -rf in known-safe directories
    for prefix in _RM_SAFE_PREFIXES:
        if prefix in command:
            return False
    # Block rm -rf targeting /, ~, or wildcard patterns
    if any(pat in command for pat in ("/ ", "~", "*")):
        return True
    return False


def main():
    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    tool_name = input_data.get("tool_name", "unknown")
    tool_input = input_data.get("tool_input", {})

    # Safety gate – block dangerous rm commands
    if tool_name in ("Bash", "bash", "shell") and _is_dangerous_rm(tool_input):
        print("Blocked: dangerous rm -rf detected by pre_tool_use hook", file=sys.stderr)
        sys.exit(1)  # exit 1 prevents the tool from executing

    # Truncate input for the event payload
    input_str = json.dumps(tool_input)
    if len(input_str) > _INPUT_MAX:
        input_str = input_str[:_INPUT_MAX] + "..."

    event_data = json.dumps({
        "phase": "pre",
        "tool": tool_name,
        "input": input_str,
    })

    send("tool_use", event_data)
    sys.exit(0)


if __name__ == "__main__":
    main()
