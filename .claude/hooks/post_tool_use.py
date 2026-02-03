#!/usr/bin/env python3
"""
PostToolUse hook – notifies the UI that a tool call completed and sends
a truncated preview of its output.

The event payload mirrors pre_tool_use but adds phase=post and an output
field.  Combined, the UI can show a matched before/after for each tool call.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from send_event import send  # noqa: E402

_INPUT_MAX = 300   # chars for input preview (shorter – already shown in pre)
_OUTPUT_MAX = 600  # chars for output preview


def main():
    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    tool_name = input_data.get("tool_name", "unknown")
    tool_input = input_data.get("tool_input", {})

    # content is a list of content blocks; extract text from each
    content_blocks = input_data.get("content", [])
    output_parts: list[str] = []
    for block in content_blocks:
        if isinstance(block, dict):
            if block.get("type") == "text":
                output_parts.append(block.get("text", ""))
            elif block.get("type") == "tool_result":
                output_parts.append(str(block.get("content", "")))
        elif isinstance(block, str):
            output_parts.append(block)
    output_str = "\n".join(output_parts)

    # Truncate
    input_preview = json.dumps(tool_input)
    if len(input_preview) > _INPUT_MAX:
        input_preview = input_preview[:_INPUT_MAX] + "..."
    if len(output_str) > _OUTPUT_MAX:
        output_str = output_str[:_OUTPUT_MAX] + "..."

    event_data = json.dumps({
        "phase": "post",
        "tool": tool_name,
        "input": input_preview,
        "output": output_str,
    })

    send("tool_use", event_data)
    sys.exit(0)


if __name__ == "__main__":
    main()
