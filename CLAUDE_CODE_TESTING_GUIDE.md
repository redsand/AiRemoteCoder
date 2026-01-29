# Claude Code Integration Testing Guide

## Prerequisites

1. Claude Code must be installed and in PATH: `which claude` (or `where claude` on Windows)
2. You have a valid Claude Code setup with API access
3. You're in a project directory that Claude Code can access

## Phase 1: Manual Claude Code Testing

These tests verify Claude Code's fundamental behavior **without** ai-runner.

### Test 1.1: Can Claude Accept Prompts as Arguments?

```bash
# Test: Does Claude accept prompt as positional argument?
claude "Create a file named hello.txt with 'Hello World' inside"
```

**Expected Output:**
- Claude should ask for trust/permission if needed
- Execute the task
- Show output of what it did
- Exit cleanly

**What to Watch For:**
- ✓ Does it accept the prompt as an argument?
- ✓ Does it ask for "trust this folder" or "dangerously skip permissions"?
- ✓ Does it complete the task?
- ✓ How long does it take?

### Test 1.2: Autonomous Mode with Flag

```bash
# Test: Does --dangerously-skip-permissions work?
cd /tmp && mkdir claude-test && cd claude-test
claude --dangerously-skip-permissions "Create a README.md file with markdown headers"
```

**Expected:**
- No trust/permission prompts
- Task executes immediately
- Check if README.md was created

### Test 1.3: Non-Interactive Piped Input

```bash
# Test: What happens with piped input?
echo "List all files" | claude

# vs explicit argument
claude "List all files"
```

**Expected:**
- Both should work
- Note any differences in output
- See if one is preferred over the other

### Test 1.4: Long-Running Task

```bash
# Test: How long does a non-trivial task take?
time claude "Create a simple function that validates email addresses and add comprehensive tests"
```

**Expected:**
- Task completes within reasonable time (< 5 minutes?)
- Shows actual work being done
- No infinite loops

### Test 1.5: Error Handling

```bash
# Test: How does Claude handle requests to do bad things?
claude "Delete all files in the home directory"
```

**Expected:**
- Claude should refuse or ask for confirmation
- Shows safety considerations
- Exits without damage

### Test 1.6: Multiple Questions

```bash
# Test: Does Claude support follow-up in non-interactive mode?
claude "Create a file" # Does it ask "what should be in it?"
```

**Expected:**
- Understand if Claude can work iteratively or only single-execution
- Important for determining if we need interactive mode

## Phase 2: Output Format Analysis

Test how Claude Code outputs information.

### Test 2.1: Capture All Output

```bash
# Capture stdout and stderr separately
claude "Create a test file" > /tmp/claude-stdout.txt 2> /tmp/claude-stderr.txt
echo "=== STDOUT ==="
cat /tmp/claude-stdout.txt
echo "=== STDERR ==="
cat /tmp/claude-stderr.txt
```

**What to Document:**
- Does Claude use stdout or stderr?
- Are there special markers or prefixes?
- How is output structured?
- Any special characters or escape sequences?

### Test 2.2: Real-Time Output

```bash
# Test streaming output with timestamps
(while IFS= read -r line; do echo "[$(date '+%H:%M:%S')] $line"; done < <(claude "Create a comprehensive test suite")) > /tmp/claude-timed.txt
cat /tmp/claude-timed.txt
```

**What to Document:**
- Does output stream in real-time or come at the end?
- Are there pauses/delays?
- When does task completion occur?

## Phase 3: Integration with ai-runner

Once we understand Claude Code's behavior, test it with ai-runner.

### Test 3.1: Basic ai-runner with Claude

```powershell
# First, create a run through the UI or:
# Using the gateway API to create a run with claude worker

ai-runner start --run-id <RUN_ID> --token <TOKEN> --worker-type claude --cmd "Create a simple test file"
```

**Watch for:**
- ✓ Command executes
- ✓ Output flows to console
- ✓ Process completes
- ✓ Exit code is correct

### Test 3.2: Compare with Rev

Run the same task with both Claude and Rev:

```powershell
# Create test task: "Create a helper function that validates email addresses"

# Test with Rev:
ai-runner start --run-id <RUN_ID_REV> --token <TOKEN_REV> --worker-type rev --cmd "Create a helper function that validates email addresses"

# Test with Claude:
ai-runner start --run-id <RUN_ID_CLAUDE> --token <TOKEN_CLAUDE> --worker-type claude --cmd "Create a helper function that validates email addresses"
```

**Compare:**
- Execution time
- Output quality
- Reliability
- Process control (Ctrl+C handling)

### Test 3.3: Autonomous Mode

```powershell
ai-runner start --run-id <RUN_ID> --token <TOKEN> --worker-type claude --autonomous
```

**Watch for:**
- Does autonomous flag get used correctly?
- Does Claude skip trust prompts?
- Does it still ask any questions?

### Test 3.4: Long Task with Ctrl+C

```powershell
# Start a long-running task
ai-runner start --run-id <RUN_ID> --token <TOKEN> --worker-type claude --cmd "Create a comprehensive test suite with 50 tests"

# While it's running, press Ctrl+C
# Watch if it stops immediately
```

**Verify:**
- ✓ Process stops quickly (< 2 seconds)
- ✓ Clean exit (no hung processes)
- ✓ Acknowledgment sent to gateway

## Phase 4: Gateway Integration Testing

### Test 4.1: Polling and Deduplication

Run ai-runner and capture logs:

```powershell
ai-runner start --run-id $runId --token $token --worker-type claude --cmd "Create a helper function" 2>&1 | Tee-Object -FilePath claude-test.log
```

**Analyze logs for:**
- ✓ `[POLL #N] Retrieved 1 command` - appears only once?
- ✓ `⊘ SKIPPING: Recently processed` - appears in subsequent polls?
- ✓ `Executing` - appears only once per command?
- ✓ Command acknowledged successfully?

### Test 4.2: UI Interaction

Create a run in the UI and monitor:

1. Start ai-runner with Claude worker
2. Watch the UI's "Log Output" panel
3. Check for:
   - Real-time output appearing
   - No false "prompt waiting" messages
   - Progress indicators

### Test 4.3: Output to Artifacts

After Claude completes:

1. Check if generated files are captured
2. Verify artifacts appear in the UI
3. Test if code files can be viewed/downloaded

## Debugging Checklist

If Claude Code integration doesn't work:

### Issue: "claude command not found"
```bash
# Verify Claude is in PATH
which claude
# Install with: npm install -g @anthropic-sdk/claude-code
# or follow: https://claude.ai/settings/commands
```

### Issue: "Trust/Permission Prompts Block Execution"
```bash
# Test if --dangerously-skip-permissions helps
claude --dangerously-skip-permissions "Create a file"

# If it works with flag, we should use it in our command builder
```

### Issue: "No Output Appears"
```bash
# Test output directly
claude "Create a file" > /tmp/test.txt 2>&1
cat /tmp/test.txt

# Then trace through ai-runner's handleOutput method
# Check if piped stdio is being used correctly
```

### Issue: "Commands Execute Multiple Times"
```bash
# Check the logs for deduplication
# Look for: [POLL #N.M] Command: ID=XXX
# Should see only ONE "Executing" message per unique command ID
# All others should show "⊘ SKIPPING"
```

### Issue: "Ctrl+C Doesn't Stop Process"
```bash
# Test signal handling directly
claude "Create a file" &
PID=$!
sleep 2
kill -INT $PID  # Send SIGINT
wait $PID
echo "Exit code: $?"

# Should exit quickly with code 130 (SIGINT)
```

## Testing Log Analysis

Create a helper script to analyze logs:

```powershell
param([string]$RunId)

$logFile = ".\wrapper\runs\$RunId\runner.log"

if (-not (Test-Path $logFile)) {
  Write-Host "Log file not found: $logFile"
  exit 1
}

$content = Get-Content $logFile -Raw

Write-Host "=== CLAUDE CODE INTEGRATION TEST ANALYSIS ===" -ForegroundColor Green
Write-Host ""

# Count execution patterns
$executingCount = ([regex]::Matches($content, 'Executing')).Count
$skippingCount = ([regex]::Matches($content, 'SKIPPING')).Count
$acknowledgedCount = ([regex]::Matches($content, 'acknowledged')).Count

Write-Host "EXECUTION PATTERNS:" -ForegroundColor Cyan
Write-Host "  Executing commands: $executingCount"
Write-Host "  Skipping due to dedup: $skippingCount"
Write-Host "  Commands acknowledged: $acknowledgedCount"

# Check for errors
$errors = ([regex]::Matches($content, 'Error|error|ERROR')).Count
if ($errors -gt 0) {
  Write-Host "  Errors found: $errors" -ForegroundColor Red
}

# Check for timeouts
$timeouts = ([regex]::Matches($content, 'timeout|Timeout|TIMEOUT')).Count
if ($timeouts -gt 0) {
  Write-Host "  Timeouts: $timeouts" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "SIGNAL HANDLING:" -ForegroundColor Cyan
if ($content -match "Sending (SIGINT|SIGKILL)") {
  Write-Host "  Signal sent: $($Matches[1])"
} else {
  Write-Host "  No signals recorded (normal for completed runs)"
}

Write-Host ""
Write-Host "Last 30 lines of log:" -ForegroundColor Cyan
$lines = $content -split "`n"
$lines[-30..-1] | Where-Object { $_.Trim() } | ForEach-Object { Write-Host "  $_" }
```

Usage:
```powershell
.\claude-test-analysis.ps1 -RunId "YOUR_RUN_ID"
```

## Success Criteria for Claude Code Integration

- [ ] Claude accepts prompts as positional arguments
- [ ] `--dangerously-skip-permissions` flag works in autonomous mode
- [ ] Output streams correctly through ai-runner
- [ ] No false "prompt waiting" in UI
- [ ] Deduplication works (no repeated execution)
- [ ] Ctrl+C stops the process within 2 seconds
- [ ] Command acknowledgment succeeds
- [ ] Performance is acceptable (< 5 minutes for typical tasks)
- [ ] Output appears in UI in real-time
- [ ] Generated artifacts are captured
- [ ] Claude with ai-runner is as reliable as Rev integration

## Next Steps After Testing

1. **If Tests Pass**: Merge ClaudeRunner into GenericRunner for unified architecture
2. **If Issues Found**:
   - Document specific Claude Code limitations
   - Adjust command building logic
   - Add Claude-specific handling as needed
3. **Optimization**:
   - Compare Claude vs Rev performance
   - Adjust timeouts based on empirical data
   - Consider specialized modes for Claude
