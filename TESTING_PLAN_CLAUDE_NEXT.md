# Claude Code Integration - Next Phase Testing Plan

## Current Status

✅ **Rev Integration**: Working with known characteristics
- Commands execute via gateway polling
- 30-minute deduplication prevents re-execution
- Enhanced logging shows exact polling behavior
- Gateway still returns acknowledged commands (minor issue - doesn't prevent execution)
- Output flows correctly to UI
- Ctrl+C handling works on Windows with SIGKILL

✅ **Code Quality**: All 147 tests pass
- BaseRunner tests ✓
- ClaudeRunner tests ✓
- GenericRunner tests ✓
- Gateway client tests ✓

✅ **Claude Code Readiness**: Updated and prepared
- `--dangerously-skip-permissions` flag now always included
- Prevents permission/trust prompts that could block execution
- Command building supports both autonomous and task modes

## What We Learned from Rev

### 1. The Real Problem Was Gateway-Side
**Issue**: Commands kept appearing in polls even after acknowledgment
**Solution**: Deduplication window (30 minutes) prevents re-execution
**Still Broken**: Gateway should remove acknowledged commands (server-side bug)

### 2. Command Deduplication Works
**Pattern**:
```
Poll #1:  Command arrives → Execute → Acknowledge
Poll #2:  Same command returns → SKIP (in dedup window)
Poll #3:  Same command returns → SKIP (in dedup window)
...
Poll #70: Same command returns → SKIP (still in dedup window)
```

**Key Learning**: This is acceptable because deduplication prevents infinite loops. The gateway issue doesn't cause actual problems due to our dedup.

### 3. False Prompts Were UI Artifact
**Issue**: UI showed "prompt waiting" even though no prompt was asked
**Root Cause**: We were sending `prompt_resolved` event when starting task execution
**Solution**: Removed false event - only send actual prompt events

### 4. Input Model: Arguments vs Stdin
**Working Pattern** (Rev):
```
spawn('rev', ['--trust-workspace', 'Update documentation'])
// NOT: echo "Update documentation" | rev
// The prompt is passed as positional argument
```

**Why This Works**:
- Single-execution mode (each prompt = new process)
- No need for TTY/interactive mode
- Clean control flow

## Claude Code: What We Expect

### Based on Rev Pattern
**Hypothesis**: Claude Code should work similarly
```
spawn('claude', ['--dangerously-skip-permissions', 'Create a helper function'])
// Should execute the task with permissions already granted
// Should not ask for trust/permission confirmation
// Should exit after completing task
```

### What Could Be Different
1. **Output Format**: May use different markers than Rev
2. **Execution Time**: Might be faster or slower than Rev
3. **Error Messages**: Different error reporting style
4. **Multi-Step Handling**: May handle complex tasks differently

### The Flag We're Using
```typescript
// ALWAYS include this to prevent permission prompts
['--dangerously-skip-permissions', 'Your task here']

// This maps to command line:
claude --dangerously-skip-permissions "Your task here"
```

## Testing Strategy

### Phase 1: Quick Smoke Test (15 minutes)

**Goal**: Verify Claude Code works at all through ai-runner

```powershell
# 1. Manual Claude test (no ai-runner)
claude --dangerously-skip-permissions "Create a file named test.txt"

# 2. Check if file was created
dir test.txt

# 3. Create a simple run through UI
# Note the run ID and token

# 4. Start with ai-runner
ai-runner start --run-id $runId --token $token --worker-type claude --cmd "Create a helper function"

# 5. Watch the output
# Should see task executing
```

**Success Criteria**:
- ✓ No permission prompts
- ✓ Task executes
- ✓ Output appears
- ✓ Process completes

### Phase 2: Integration Verification (30 minutes)

**Goal**: Verify Claude integrates like Rev

```powershell
# 1. Check logging output
ai-runner start --run-id $runId --token $token --worker-type claude --cmd "Create a helper function" 2>&1 | Tee-Object -FilePath claude-test.log

# 2. Analyze logs
.\analyze-test-logs.ps1 $runId

# Expected output:
# - [POLL #1] Retrieved 1 command
# - ✓ Executing command
# - Task execution completed
# - ✓ Command acknowledged successfully
# - [POLL #2] ⊘ SKIPPING (still in dedup window)
```

**Success Criteria**:
- ✓ Command executes once
- ✓ Subsequent polls show "SKIP"
- ✓ No repeated execution
- ✓ Acknowledgment succeeds

### Phase 3: Comparison Test (30 minutes)

**Goal**: Compare Claude vs Rev on same task

```powershell
# Same task, two different workers

# Test 1: Rev
ai-runner start --run-id $revId --token $revToken --worker-type rev --cmd "Create a comprehensive test function"

# Test 2: Claude
ai-runner start --run-id $claudeId --token $claudeToken --worker-type claude --cmd "Create a comprehensive test function"

# Compare:
# - Execution time
# - Output quality
# - Resource usage
# - Reliability
```

**What to Document**:
- Which is faster?
- Which produces better output?
- Which is more reliable?
- Are there use cases for each?

### Phase 4: Edge Cases (30 minutes)

**Test**: Ctrl+C handling
```powershell
ai-runner start --run-id $runId --token $token --worker-type claude --cmd "Create a comprehensive test suite" &
Start-Sleep -Seconds 3
[System.Diagnostics.Process]::GetProcessById($pid) | Stop-Process  # Ctrl+C equivalent

# Check logs for proper signal handling
Get-Content .data\runs\$runId\runner.log | Select-String "Sending|SIGINT|SIGKILL"
```

**Test**: Long-running task
```powershell
ai-runner start --run-id $runId --token $token --worker-type claude --cmd "Create a large application with multiple modules"

# Should complete within reasonable time (< 5 minutes)
# Should not timeout
# Should not infinite loop
```

**Test**: Autonomous mode
```powershell
ai-runner start --run-id $runId --token $token --worker-type claude --autonomous

# Should start Claude without requiring a prompt
# Should work in fully autonomous mode
```

## Expected Outcomes

### Scenario 1: Claude Works Perfectly
✓ Same behavior as Rev
✓ All tests pass
✓ **Decision**: Merge ClaudeRunner into GenericRunner for unified architecture
✓ Claude becomes standard worker option

### Scenario 2: Claude Works with Minor Adjustments
⚠ Small differences in output format or behavior
⚠ May need Claude-specific command building
✓ **Decision**: Keep ClaudeRunner separate, document differences
✓ Both workers work through same gateway

### Scenario 3: Claude Doesn't Work Well
✗ Doesn't accept positional arguments
✗ Gets stuck at prompts despite flag
✗ Very different execution model
**Decision**: Document limitations, determine if Claude needs different architecture

## Key Files for This Testing Phase

1. **wrapper/src/services/claude-runner.ts** - Command building (just updated)
2. **wrapper/src/services/base-runner.ts** - Lifecycle (proven with Rev)
3. **test-loop-fix.ps1** - Template for testing
4. **analyze-test-logs.ps1** - Log analysis tool
5. **.data/runs/{runId}/runner.log** - Debug output

## Critical Command Reference

### Start Claude via ai-runner
```powershell
ai-runner start `
  --run-id $runId `
  --token $token `
  --worker-type claude `
  --cmd "Your task description"
```

### Start Claude in autonomous mode
```powershell
ai-runner start `
  --run-id $runId `
  --token $token `
  --worker-type claude `
  --autonomous
```

### Analyze results
```powershell
.\analyze-test-logs.ps1 $runId
```

### Check real-time logs
```powershell
Get-Content .data\runs\$runId\runner.log -Tail 50 -Wait
```

## Pre-Testing Checklist

- [ ] `claude` command works: `claude --dangerously-skip-permissions "Test"`
- [ ] ai-runner updated: `npm install -g ./wrapper`
- [ ] Version confirmed: `ai-runner -V` shows 1.1.0
- [ ] Tests pass: `npm test --workspace=wrapper`
- [ ] Gateway accessible: Test connection via UI
- [ ] Have run ID and token ready for tests

## Success Metric

Claude Code integration will be **proven successful** when:

1. At least 3 different tasks complete successfully through ai-runner
2. Output appears in real-time on UI
3. Deduplication prevents re-execution (verified in logs)
4. Ctrl+C stops the process gracefully
5. Command acknowledgment succeeds
6. No permission/trust prompts block execution
7. Performance is reasonable (< 5 minutes for typical tasks)

## Next Immediate Steps

1. **Verify Manual Claude Works**:
   ```bash
   claude --dangerously-skip-permissions "Create a test file"
   ```

2. **Create Simple Test Run**:
   - Use UI to create a run
   - Note the run ID and token

3. **Execute Phase 1 Smoke Test**:
   ```powershell
   ai-runner start --run-id $runId --token $token --worker-type claude --cmd "Create a simple test file"
   ```

4. **Analyze Results**:
   ```powershell
   .\analyze-test-logs.ps1 $runId
   ```

5. **Report Findings**:
   - Did Claude execute?
   - Any permission prompts?
   - Did output appear?
   - Any errors?

## Documentation for Future Reference

- **CLAUDE_CODE_INVESTIGATION.md**: Architecture and design decisions
- **CLAUDE_CODE_TESTING_GUIDE.md**: Detailed testing procedures
- **CLAUDE_CODE_READINESS_SUMMARY.md**: Current state and readiness
- **REV_DEBUGGING_GUIDE.md**: Reference pattern (working implementation)
- **TESTING_PLAN_CLAUDE_NEXT.md**: This document

---

**Ready to test Claude Code integration**
**Status**: All prerequisites met, waiting for manual testing phase
**Expected Duration**: 2-3 hours for complete validation
