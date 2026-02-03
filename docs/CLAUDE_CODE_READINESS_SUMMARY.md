# Claude Code Integration - Readiness Summary

## Overview

Claude Code is Anthropic's official CLI tool for AI-assisted development. We've thoroughly analyzed how it should integrate into the ai-runner system by studying:

1. The existing Rev worker implementation (working reference)
2. Current ClaudeRunner code structure
3. BaseRunner lifecycle and command handling
4. Gateway integration patterns

## Key Findings

### Current State

✓ **ClaudeRunner exists** - Separate implementation inheriting from BaseRunner
✓ **Command structure** - Supports positional argument prompts and autonomous mode
✓ **Integration registered** - Claude is a recognized worker type in registry
✓ **CLI support** - Both `create` and `start` commands support `--worker-type claude`

### Critical Differences: Claude vs Rev

| Aspect | Rev | Claude |
|--------|-----|--------|
| **Nature** | Task executor | Interactive assistant |
| **Execution Model** | Single-execution | Conversation loop |
| **Input** | Positional arguments | Arguments + potentially interactive |
| **Output** | Task results | Development progress |
| **Autonomy Flag** | `--trust-workspace` | `--dangerously-skip-permissions` |
| **TTY Requirement** | Not needed | May be required |
| **Typical Use** | One-off coding tasks | Iterative development |

### Implementation Comparison

**Rev Pattern (Proven Working):**
```
__INPUT__ → buildCommand() → spawn(args) → close stdin → wait → ack
└─ args: ['--trust-workspace', 'task description']
└─ Timeout: 5 minutes
└─ Dedup: 30 minutes
```

**Claude Pattern (Current Implementation):**
```
__INPUT__ → buildCommand() → spawn(args) → ??? → wait → ack
└─ args: ['--dangerously-skip-permissions', ???] or ['--dangerously-skip-permissions']
└─ Timeout: (needs testing)
└─ Dedup: 30 minutes (same as Rev)
```

## What We Don't Know (Testing Required)

### 1. Input Acceptance
**Question:** Does Claude accept prompts as positional arguments like Rev?
```bash
# Does this work?
claude "Create a helper function"

# Or must we use interactive stdin?
echo "Create a helper function" | claude
```

**Why This Matters:** If Claude only accepts stdin, we need different command building

### 2. Non-Interactive Mode
**Question:** How does Claude behave in non-interactive environments (piped stdin/stdout)?
```bash
# Does Claude work with stdio: ['pipe', 'pipe', 'pipe']?
# Or does it need inherited stdin for TTY?
```

**Why This Matters:** Affects how we spawn and control the process

### 3. Autonomous Behavior
**Question:** Does `--dangerously-skip-permissions` fully skip permission prompts?
```bash
# Or does Claude still ask for input?
claude --dangerously-skip-permissions "Create a file"
```

**Why This Matters:** Affects autonomous mode reliability

### 4. Output Format
**Question:** How does Claude structure its output?
```
[claude] Task started...
[claude] Creating file...
[claude] Done!

OR

File created successfully

OR
(some other format)
```

**Why This Matters:** UI log parsing and display

### 5. Execution Time
**Question:** What are typical execution times for various task complexities?
- Simple tasks: seconds?
- Medium tasks: minutes?
- Does it go over 5-minute timeout?

**Why This Matters:** Timeout configuration

### 6. Iterative Capability
**Question:** Can Claude handle multi-step tasks in single execution?
```bash
claude "Create a file, then add content, then run tests"
# Does Claude handle all three, or ask after each step?
```

**Why This Matters:** Whether we need interactive mode support

## Integration Readiness Checklist

### Code Ready ✓
- [x] ClaudeRunner class exists
- [x] Inherits from BaseRunner
- [x] Registered in worker-registry
- [x] CLI supports --worker-type claude
- [x] Autonomous mode support (`--dangerously-skip-permissions`)
- [x] Command building implemented (positional arg assumption)

### Infrastructure Ready ✓
- [x] Gateway command polling works
- [x] Deduplication (30-minute window) implemented
- [x] Signal handling (SIGINT/SIGKILL) in place
- [x] Output streaming infrastructure
- [x] Artifact upload support
- [x] Enhanced logging for debugging

### Testing Ready ✓
- [x] CLAUDE_CODE_TESTING_GUIDE.md created
- [x] Manual testing procedures documented
- [x] Integration testing steps defined
- [x] Debugging checklist provided
- [x] Log analysis helper provided

### Documentation Ready ✓
- [x] CLAUDE_CODE_INVESTIGATION.md explains architecture
- [x] REV_DEBUGGING_GUIDE.md (reference pattern)
- [x] Decision points documented
- [x] Comparison with Rev available

## Recommended Testing Path

### Phase 1: Manual Understanding (30 minutes)
```bash
# Run these commands to understand Claude Code behavior
claude "Create a file named test.txt"
claude --dangerously-skip-permissions "List files"
echo "Create a file" | claude
```

### Phase 2: Direct Integration Test (30 minutes)
```powershell
# Create a simple task through the UI
# Run with ai-runner
ai-runner start --run-id $runId --token $token --worker-type claude --cmd "Create a helper function"

# Analyze logs
.\analyze-test-logs.ps1 $runId
```

### Phase 3: Comparison Testing (1 hour)
```powershell
# Same task with Rev and Claude
# Compare output, timing, reliability
# Check UI display
# Verify deduplication
```

### Phase 4: Edge Case Testing (30 minutes)
```powershell
# Test Ctrl+C handling
# Test long-running tasks
# Test error cases
# Test autonomous mode
```

## Expected Outcomes

### If Claude Works Well
✓ Merge ClaudeRunner into GenericRunner for unified architecture
✓ Claude becomes alternative to Rev for different use cases
✓ Both workers operate through same gateway polling mechanism
✓ UI supports worker selection (Claude vs Rev)

### If Claude Needs Adjustments
- Document specific limitations
- Add Claude-specific command building logic
- Adjust timeout values based on testing
- Update command architecture if needed

### If Claude Has Incompatibilities
- Determine if separate implementations required
- Document when to use Claude vs other workers
- Add special handling for Claude quirks

## Implementation Notes

### Current ClaudeRunner Command Building
```typescript
buildCommand(command?: string, autonomous?: boolean): WorkerCommandResult {
  if (autonomous) {
    return { args: ['--dangerously-skip-permissions'], fullCommand: 'claude (autonomous)' };
  } else if (command) {
    return { args: [command], fullCommand: `claude ${command}` };
  } else {
    return { args: [], fullCommand: 'claude' };
  }
}
```

**Assumption:** Claude accepts the command as positional argument like: `claude "your prompt"`

**This may need adjustment if:**
- Claude doesn't accept positional arguments
- Needs special flags for non-interactive mode
- Requires stdin-based input

### Gateway Integration Points

1. **Command Reception**: `executeCommand()` in base-runner.ts
2. **Command Building**: `buildCommand()` in claude-runner.ts
3. **Process Spawning**: `executePrompt()` for `__INPUT__` commands
4. **Output Handling**: `handleOutput()` captures stdout/stderr
5. **Acknowledgment**: `ackCommand()` confirms completion
6. **Deduplication**: 30-minute window prevents re-execution

All these are already in place and tested with Rev. Claude just needs to work within this framework.

## Key Files to Monitor During Testing

1. **wrapper/src/services/claude-runner.ts** - Command building logic
2. **wrapper/src/services/base-runner.ts** - Lifecycle and logging (shared)
3. **.data/runs/{runId}/runner.log** - Debug output during tests
4. **UI Log Output panel** - Real-time monitoring

## Quick Reference Commands

### Create test run with Claude
```powershell
# Interactive UI-based creation, or use curl:
curl -X POST https://localhost:3100/api/runs \
  -H "Authorization: Bearer $sessionToken" \
  -H "Content-Type: application/json" \
  -d '{
    "command": "Create a helper function",
    "workerType": "claude",
    "autonomous": false
  }'
```

### Start ai-runner with Claude
```powershell
ai-runner start \
  --run-id $runId \
  --token $token \
  --worker-type claude \
  --cmd "Your task here"
```

### View logs
```powershell
Get-Content .data\runs\$runId\runner.log -Tail 100 -Wait
```

### Analyze test results
```powershell
.\analyze-test-logs.ps1 $runId
```

## Success Criteria

Claude Code integration will be considered successful when:

1. ✓ Commands execute through ai-runner without errors
2. ✓ Output streams correctly to UI
3. ✓ Deduplication prevents repeated execution
4. ✓ Ctrl+C stops the process cleanly
5. ✓ Command acknowledgment succeeds
6. ✓ No false "prompt waiting" in UI
7. ✓ Performance is acceptable (< 5 min for typical tasks)
8. ✓ Works as reliably as existing Rev integration

## Next Steps

1. **Read Testing Guide**: Review CLAUDE_CODE_TESTING_GUIDE.md for detailed procedures
2. **Manual Testing**: Run Phase 1 tests to understand Claude Code behavior
3. **Integration Testing**: Run Phase 2-4 tests with ai-runner
4. **Analysis**: Use provided log analysis and compare with Rev
5. **Decisions**: Based on results, decide on integration approach
6. **Implementation**: Make any needed adjustments to command building or architecture

## Questions to Answer Before Full Deployment

1. Does Claude Code reliably accept positional argument prompts?
2. How does it handle non-interactive piped I/O?
3. What's the actual execution time for typical tasks?
4. Does `--dangerously-skip-permissions` fully prevent prompts?
5. How does output differ from Rev?
6. Are there any timeout or signal handling issues?
7. Should Claude be merged into GenericRunner or stay separate?
8. Are there Claude-specific optimizations or special cases?

---

**Status**: Ready for comprehensive testing
**Next Action**: Execute CLAUDE_CODE_TESTING_GUIDE.md Phase 1 (Manual Testing)
**Expected Timeline**: 2-3 hours for full investigation and basic integration
