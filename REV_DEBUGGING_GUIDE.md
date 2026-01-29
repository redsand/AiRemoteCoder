# Rev Command Behavior Analysis Guide

## Problem Statement
The current implementation has an undefined behavior where commands appear to be re-executed or get stuck in loops. Before applying more "band-aid" fixes, we need to understand exactly how Rev works with piped input/output in our execution model.

## What We Need to Understand

### 1. Rev's Input Model
**Question:** How does Rev accept input when stdin is piped?

- **Hypothesis A:** Rev expects prompts as command-line arguments (positional)
- **Hypothesis B:** Rev reads from stdin for interactive input
- **Hypothesis C:** Rev has both modes and auto-detects based on TTY

**Current Implementation:** We pass prompts as positional arguments (line 218 in generic-runner.ts)

```bash
rev --llm-provider claude --model "qwen" "Your task here"
```

**Test This:**
```powershell
# Test 1: Verify Rev accepts positional arguments
rev "Update the README documentation"

# Test 2: Verify Rev works with piped stdin
echo "Update the README documentation" | rev

# Test 3: Check if Rev detects non-interactive mode
rev --help | grep -i "repl\|interactive\|stdin"
```

### 2. Rev's Output Behavior
**Question:** How does Rev produce output when running non-interactively?

- Does it stream output line-by-line?
- Does it buffer output until completion?
- Does it produce special markers for different output types?

**Current Implementation:** We listen to stdout/stderr events (lines 985-996 in base-runner.ts)

**Test This:**
```powershell
# Test 1: Check raw Rev output
rev "List files in current directory" 2>&1 | head -50

# Test 2: Check output timing
time rev "Count lines in a file" 2>&1

# Test 3: Verify exit codes
rev "Invalid command"
echo "Exit code: $LASTEXITCODE"
```

### 3. Prompt Optimization Behavior
**Question:** What triggers Rev's [PROMPT OPTIMIZATION] feature?

- When is it triggered?
- How can we prevent it in autonomous mode?
- Does it cause infinite recursion or just additional processing?

**Test This:**
```powershell
# Test 1: Simple task (shouldn't trigger optimization)
rev --trust-workspace "Create a file named test.txt"

# Test 2: Vague task (might trigger optimization)
rev --trust-workspace "Ensure our documentation is up to date"

# Test 3: With logging to see optimization messages
rev --trust-workspace "Check the test status" 2>&1 | grep -i "optim"
```

### 4. Command Execution Timeline
**Question:** How long does each stage take?

- How long from spawn to first output?
- How long for complete execution?
- Does Rev have any internal delays or loops?

**Test This:**
```powershell
# Use time command to measure execution
$start = Get-Date
rev --trust-workspace "Ensure our documentation is up to date"
$end = Get-Date
Write-Host "Total time: $($end - $start)"
```

## Enhanced Logging Output Format

When you run the updated ai-runner with Rev, look for:

```
[POLL #1] Retrieved 1 command(s) from gateway
[POLL #1.1] Command: ID=abc123, Command=__INPUT__:Ensure documentation..., Processed=false
[POLL #1.1] ✓ Executing command now...
    [DEDUPE ADDED] Command abc123 added to dedup set (30 minute window)
    ► Starting prompt execution...
    [stdout] Line 1 of output
    [stdout] Line 2 of output
    ◄ Prompt execution completed after 45000ms
    ✓ Command acknowledged successfully

[POLL #2] Retrieved 1 command(s) from gateway
[POLL #2.1] Command: ID=abc123, Command=__INPUT__:Ensure documentation..., Processed=true
[POLL #2.1] ⊘ SKIPPING: Recently processed (still in dedup window)

[POLL #3] Retrieved 2 command(s) from gateway
[POLL #3.1] Command: ID=xyz789, Command=__INPUT__:Check tests..., Processed=false
[POLL #3.1] ✓ Executing command now...
```

## Debugging Checklist

- [ ] **Verify Input Model**: Run the Rev input tests above and confirm it accepts positional arguments
- [ ] **Check Output Format**: Verify Rev outputs one of these patterns:
  - `[rev] Output text`
  - `Output text without prefix`
  - `[some-prefix] Output text`
- [ ] **Measure Execution Time**: Ensure Rev completes in < 5 minutes for typical tasks
- [ ] **Monitor Deduplication**: Check if "SKIP" messages appear for the same command ID
- [ ] **Verify Ack Success**: Confirm "Command acknowledged successfully" appears for each execution
- [ ] **Check for Optimization**: Search logs for "[PROMPT OPTIMIZATION]" messages
- [ ] **Test Timeout**: Verify the 5-minute kill timeout works by sending a long-running task

## Test Run Scenario

1. Create a simple test task through the UI:
   - Command: "Update README with current date"
   - Worker: Rev
   - Model: Your default Rev model
   - Autonomous: Yes

2. Run ai-runner with the generated token:
   ```powershell
   ai-runner start --run-id $runId --token $token --worker-type rev --cmd "Update README with current date"
   ```

3. Capture the console output fully

4. Analyze the logs with:
   ```powershell
   .\analyze-test-logs.ps1 $runId
   ```

5. Answer these questions:
   - How many times did the command execute?
   - How many "SKIP" messages appeared?
   - What was the total execution time?
   - Did you see [PROMPT OPTIMIZATION] messages?
   - Did Ctrl+C stop the process immediately?

## What Success Looks Like

✓ Command executes exactly once
✓ Subsequent polls show "SKIP" for the same command ID
✓ Prompt execution time is logged
✓ Acknowledgment succeeds
✓ Deduplication window is active for 30 minutes
✓ Ctrl+C terminates process within 1-2 seconds
✓ No [PROMPT OPTIMIZATION] loops

## What Failure Looks Like

✗ Command executes multiple times with different IDs
✗ Same command ID executes multiple times despite deduplication
✗ "SKIP" messages appear but command still executes later
✗ Execution time doesn't match observed wait time
✗ Acknowledgment fails silently
✗ Process doesn't respond to Ctrl+C
✗ [PROMPT OPTIMIZATION] loops infinitely
