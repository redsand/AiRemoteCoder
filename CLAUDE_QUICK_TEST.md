# Claude Code Quick Testing - With Correct Flags

## Quick Reference: Claude Code Command Format

```bash
claude [options] [command] [prompt]

# Required flags for ai-runner (prevent permission prompts):
--permission-mode acceptEdits

# Optional but recommended:
--model <model>              # Specify model (e.g., claude-3-5-sonnet)
--output-format text         # Force text output

# Example:
claude --permission-mode acceptEdits --output-format text --model claude-3-5-sonnet "Create a test file"
```

## Pre-Testing Verification

### 1. Verify Claude Code is Installed
```bash
# Check if claude command exists
which claude    # macOS/Linux
where claude    # Windows

# Check version
claude --version

# Should output something like:
# Claude Code version X.X.X
```

### 2. Check Available Models
```bash
# See what models Claude Code has access to
claude --help | grep -i model
```

### 3. Test Permission Flag
```bash
# This is critical - verify --permission-mode acceptEdits works
cd /tmp
mkdir claude-test
cd claude-test

# Test the flag without ai-runner
claude --permission-mode acceptEdits --output-format text "Create a file named hello.txt with content 'Hello World'"

# Check if file was created
ls -la hello.txt

# Expected: hello.txt exists with correct content
```

## Phase 1: Manual Claude Testing (5 minutes)

### Test 1.1: Simple Task
```bash
cd /tmp && rm -rf claude-test && mkdir claude-test && cd claude-test

claude --permission-mode acceptEdits --output-format text "Create a simple helper function that validates email addresses"
```

**Watch for**:
- ✓ No permission/trust prompts
- ✓ Task executes
- ✓ Output appears
- ✓ Process exits cleanly

### Test 1.2: With Model Specification
```bash
claude --permission-mode acceptEdits --output-format text --model "claude-3-5-sonnet" "Create a test suite with 5 simple tests"
```

**Expected**:
- Same behavior with explicit model
- Slightly different response quality based on model

### Test 1.3: Long Task
```bash
time claude --permission-mode acceptEdits --output-format text "Create a comprehensive helper library with validation functions for emails, phone numbers, and URLs with full documentation"
```

**Expected**:
- Task completes
- Execution time noted (baseline for comparison with Rev)
- All output captured

## Phase 2: ai-runner Integration (10 minutes)

### Step 1: Create Test Run
```powershell
# Via UI:
# 1. Navigate to https://localhost:3100/runs/create
# 2. Leave command empty (we'll provide via CLI)
# 3. Select worker type: "Claude"
# 4. Leave autonomous unchecked
# 5. Click Create
# 6. Note the Run ID and Token shown

# Or via curl (if you have gateway credentials):
# curl -X POST https://localhost:3100/api/runs ...
```

### Step 2: Run Test with ai-runner
```powershell
# Using the Run ID and Token from above:
ai-runner start `
  --run-id YOUR_RUN_ID `
  --token YOUR_TOKEN `
  --worker-type claude `
  --model "claude-3-5-sonnet" `
  --cmd "Create a comprehensive test function with error handling"
```

**Watch for**:
- ✓ "Executing task via new process" message
- ✓ No permission prompts
- ✓ Output streams to console
- ✓ Command acknowledged successfully
- ✓ Clean exit

### Step 3: Analyze Logs
```powershell
# Analyze the run
.\analyze-test-logs.ps1 YOUR_RUN_ID

# Look for:
# - Execution patterns: 1 execution, multiple skips
# - Command acknowledged: ✓ Command acknowledged successfully
# - No repeated execution
# - No errors or timeouts
```

## Phase 3: Comparison Test (15 minutes)

### Test: Same Task with Rev and Claude

```powershell
# Task: Create a helper function with tests
$task = "Create a helper function that validates input strings and includes unit tests"

# Step 1: Get two run tokens from UI (one for Rev, one for Claude)

# Step 2: Run with Rev
Write-Host "Testing with Rev..." -ForegroundColor Cyan
$revStart = Get-Date
ai-runner start `
  --run-id $revRunId `
  --token $revToken `
  --worker-type rev `
  --cmd $task
$revEnd = Get-Date
$revTime = ($revEnd - $revStart).TotalSeconds

# Step 3: Run with Claude
Write-Host "Testing with Claude..." -ForegroundColor Cyan
$claudeStart = Get-Date
ai-runner start `
  --run-id $claudeRunId `
  --token $claudeToken `
  --worker-type claude `
  --model "claude-3-5-sonnet" `
  --cmd $task
$claudeEnd = Get-Date
$claudeTime = ($claudeEnd - $claudeStart).TotalSeconds

# Step 4: Compare
Write-Host ""
Write-Host "=== COMPARISON ===" -ForegroundColor Green
Write-Host "Rev execution time: ${revTime}s"
Write-Host "Claude execution time: ${claudeTime}s"
Write-Host "Speed ratio: $(($claudeTime / $revTime).ToString('F2'))x"
```

## Phase 4: Edge Cases (10 minutes)

### Test: Autonomous Mode
```powershell
ai-runner start `
  --run-id $runId `
  --token $token `
  --worker-type claude `
  --autonomous
```

**Expected**:
- Claude starts in autonomous mode
- No prompts or permission requests
- Waits for commands from gateway

### Test: Long-Running Task
```powershell
ai-runner start `
  --run-id $runId `
  --token $token `
  --worker-type claude `
  --cmd "Create a complete application with multiple modules, comprehensive tests, and documentation"
```

**Expected**:
- Completes within reasonable time (< 5 minutes)
- No timeout
- All output captured

### Test: Signal Handling
```powershell
# Start a long task
$job = Start-Job {
  ai-runner start `
    --run-id $runId `
    --token $token `
    --worker-type claude `
    --cmd "Create a large application"
}

# Let it run for 3 seconds
Start-Sleep -Seconds 3

# Stop it
Stop-Job $job

# Check logs for signal handling
Get-Content .data\runs\$runId\runner.log | Select-String "Sending|SIGINT|SIGKILL|stopped"
```

**Expected**:
- Process stops quickly
- Signal sent successfully
- Clean exit

## Expected Output Examples

### Successful Claude Execution
```
[POLL #1] Retrieved 1 command(s) from gateway
[POLL #1.1] Executing: ID=abc123, Command=__INPUT__:Create a helper function
    Full command: claude --permission-mode acceptEdits --output-format text "Create a helper function"
    Task text: Create a helper function
    ✓ Marked command abc123 as processed for 30 minutes
    ► Starting task execution...
    ✓ Task execution completed after 15234ms
    ✓ Command acknowledged successfully

[POLL #2] Retrieved 1 command(s) from gateway
[POLL #2.1] Command: ID=abc123, Processed=true
[POLL #2.1] ⊘ SKIPPING: Recently processed (still in dedup window)
```

### Deduplication Working
```
✓ 1 new command(s) to execute
⊘ 67 command(s) already processed (in dedup window)
```

### Success Indicators
- No "error" messages
- "Command acknowledged successfully" appears
- "SKIPPING" messages in subsequent polls
- Process exits cleanly
- Output appears in UI

## Common Issues & Solutions

### Issue: Permission Prompt Still Appears
```
Trust this folder? This enables Claude Code to read, edit, and execute files here
❯ 1. Yes, I trust this folder    2. No, exit
```

**Solution**: Verify you're using `--permission-mode acceptEdits` flag
```bash
claude --permission-mode acceptEdits "Your task"  # Should skip prompt
```

### Issue: No Output Appears
```bash
# Test output directly
claude --permission-mode acceptEdits --output-format text "test" > /tmp/claude-test.txt 2>&1
cat /tmp/claude-test.txt

# Should have content
```

### Issue: ai-runner Says Claude Not Found
```bash
# Verify Claude is in PATH
which claude
# If not found, install Claude Code
# Visit: https://claude.ai and follow setup instructions
```

### Issue: Deduplication Not Working
```
[POLL #1] Executing
[POLL #2] Executing (SAME COMMAND ID)  # Should SKIP instead
```

**Check logs**:
```powershell
Get-Content .data\runs\$runId\runner.log | Select-String "DEDUPE|Skipping"
```

## Success Criteria

✓ Claude Code works through ai-runner
✓ `--permission-mode acceptEdits` prevents prompts
✓ Output streams correctly
✓ Deduplication works (seen in logs)
✓ Command acknowledged successfully
✓ No repeated execution
✓ Performance reasonable (< 5 minutes typical tasks)
✓ Matches Rev execution pattern exactly

## Quick Reference Commands

```powershell
# Test Claude directly
claude --permission-mode acceptEdits --output-format text "Create a test file"

# Run through ai-runner
ai-runner start --run-id $id --token $token --worker-type claude --cmd "Your task"

# View logs in real-time
Get-Content .data\runs\$id\runner.log -Tail 50 -Wait

# Analyze test results
.\analyze-test-logs.ps1 $id

# Compare with Rev
# (run same task with both worker types)
```

## Reporting Results

After testing, report:

1. **Manual Tests**: Did Claude execute with proper flags?
2. **Integration**: Did ai-runner execute task correctly?
3. **Deduplication**: Did SKIP messages appear for duplicate polls?
4. **Comparison**: How does Claude compare to Rev?
5. **Issues**: Any problems or unexpected behavior?

## Next Steps

1. ✅ Run Phase 1 (manual Claude test)
2. ✅ Run Phase 2 (ai-runner integration)
3. ✅ Run Phase 3 (comparison with Rev)
4. ✅ Run Phase 4 (edge cases)
5. 📋 Document findings
6. 🎯 Make deployment decision

---

**Ready to test Claude Code with correct flags!**
