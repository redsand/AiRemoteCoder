# Claude Code Integration Analysis

## Current State

### Architecture
- **ClaudeRunner**: Separate from GenericRunner, inherits from BaseRunner
- **Location**: `wrapper/src/services/claude-runner.ts`
- **Status**: Implemented but not yet tested in this workflow

### Current Implementation Pattern

```typescript
// Claude is currently handled separately
if (workerType === 'claude') {
  runner = new ClaudeRunner({
    runId, capabilityToken, workingDir, autonomous
  });
} else {
  // Rev, Gemini, Codex, Ollama-Launch handled by GenericRunner
  runner = createGenericRunner(workerType, { ... });
}
```

### Claude Command Building (Current)

```typescript
buildCommand(command?: string, autonomous?: boolean): WorkerCommandResult {
  if (autonomous) {
    // Autonomous mode: ['--dangerously-skip-permissions']
    return { args: ['--dangerously-skip-permissions'], ... };
  } else if (command) {
    // Interactive mode with prompt: [command]
    return { args: [command], ... };
  } else {
    // No args - just 'claude' command
    return { args: [], ... };
  }
}
```

## Key Questions We Need to Answer

### 1. **How does Claude Code expect to receive input?**

**What we know:**
- Claude Code is Anthropic's official CLI tool
- It's different from Rev - it's designed for interactive code development
- Current implementation passes commands as positional arguments

**What we need to verify:**
- ✓ Does `claude "Your prompt here"` work?
- ✓ Does it accept input via stdin when piped?
- ✓ How does it handle non-interactive environments?
- ✓ What is the behavior with `--dangerously-skip-permissions`?

### 2. **What are Claude Code's expected modes?**

Based on the implementation, there appear to be three modes:

**Mode A: Autonomous**
```bash
claude --dangerously-skip-permissions
# Starts Claude in full autonomous mode without prompts for trust
# Expects TTY for interactive use
```

**Mode B: Interactive with Prompt**
```bash
claude "Your task here"
# Starts Claude with initial prompt
# Likely enters interactive loop
# May ask follow-up questions
```

**Mode C: Interactive Without Prompt**
```bash
claude
# Starts Claude in interactive mode
# Waits for user to type
```

### 3. **How does output flow differ from Rev?**

**Rev** (task executor):
- Non-interactive by default
- Accepts prompt as positional argument
- Single execution, then exits
- Useful for one-off tasks

**Claude Code** (interactive assistant):
- Interactive by default
- Maintains a conversation loop
- Can work on multiple related tasks
- May require TTY detection

### 4. **What about stdin/stdout handling?**

**Current Challenge from Rev Testing:**
- We pipe stdin: `stdio: ['pipe', 'pipe', 'pipe']`
- This prevents TTY detection
- Claude may have similar requirements

**Options:**
- Option A: Inherit stdin for TTY detection (hard to send input programmatically)
- Option B: Use piped stdin (may break interactivity)
- Option C: Run in different mode (non-interactive)

### 5. **Input Command Strategy**

When the gateway sends `__INPUT__:Your prompt here`, Claude should:

**Current Approach (from Rev):**
- Parse the command as positional argument
- Spawn: `claude "Your prompt here"`
- Close stdin immediately
- Wait for process to complete

**Alternative Approaches:**
1. **Interactive Loop**: Keep process running, send input via stdin
2. **Single Execution**: Each `__INPUT__` spawns new Claude process
3. **Autonomous Mode**: Trust everything, let Claude work freely

## What We Should Test

### Test 1: Basic Claude Functionality

```bash
# Test if Claude accepts positional arguments
claude "Create a file named test.txt"
```

**Expected:** Claude creates the file and exits (or asks for confirmation)

### Test 2: Autonomous Mode

```bash
# Test if autonomous flag skips trust prompts
claude --dangerously-skip-permissions "Create a file"
```

**Expected:** No prompts for directory trust, direct execution

### Test 3: TTY Detection

```bash
# Test Claude behavior with piped input
echo "Create a file" | claude

# vs without piping
claude "Create a file"
```

**Expected:** Understand how Claude detects non-interactive mode

### Test 4: Output Streaming

```bash
# Monitor output in real-time
claude "List files and show details" 2>&1 | head -100
```

**Expected:** Understand output format, timing, and markers

### Test 5: Multi-Step Tasks

```bash
# Does Claude accept follow-ups?
claude "Create a file named app.js"
# Then somehow send: "Add console.log to the file"
```

**Expected:** Understand if Claude runs single-execution or interactive loop

## Comparison with Rev Implementation

### Rev Pattern (What We Know Works)

```typescript
// 1. Gateway sends: __INPUT__:Update documentation
// 2. We build: ['--trust-workspace', 'Update documentation']
// 3. We spawn: rev --trust-workspace "Update documentation"
// 4. Close stdin immediately
// 5. Wait for completion
// 6. Acknowledge and move on

// This works because Rev:
// - Accepts prompts as arguments
// - Runs in single-execution mode
// - Doesn't need interactive TTY
```

### Claude Pattern (Hypothesis)

```typescript
// 1. Gateway sends: __INPUT__:Create a helper function
// 2. Build: ??? Should we use ['--dangerously-skip-permissions']?
// 3. Spawn: claude ??? "Create a helper function"
// 4. Close stdin? Or keep open?
// 5. Wait for completion? How long?
// 6. Acknowledge and move on

// Questions:
// - Does Claude run single-execution or interactive?
// - Does it accept prompts as arguments?
// - Does --dangerously-skip-permissions help in non-interactive mode?
```

## Implementation Decision Points

### Decision 1: Keep Separate or Merge into GenericRunner?

**Option A: Keep ClaudeRunner Separate**
- Pros: Can customize Claude-specific behavior
- Cons: Duplicates code, harder to maintain

**Option B: Merge into GenericRunner**
- Pros: Unified architecture like Rev/Gemini
- Cons: Loses Claude-specific optimizations if needed

### Decision 2: Command Pattern

**Option A: Positional Argument (like Rev)**
```bash
claude "Your task here"
# Clean, simple, works for single-execution
```

**Option B: Interactive with stdin**
```bash
echo "Your task" | claude
# More interactive, but harder to control
```

**Option C: Hybrid (depends on context)**
```bash
# For tasks: claude "Your task"
# For interactive: claude (with piped input)
```

### Decision 3: Timeout Handling

**For Rev:** 5-minute timeout prevents prompt optimization loops

**For Claude:** May need different timeout
- Might be faster (Claude is optimized)
- Or slower (might be more thorough)
- Need empirical testing

## Integration Checklist

- [ ] Understand actual Claude Code command interface
- [ ] Test with positional arguments: `claude "prompt"`
- [ ] Test with `--dangerously-skip-permissions` flag
- [ ] Test non-interactive behavior (no TTY)
- [ ] Measure execution time for typical tasks
- [ ] Check output format and markers
- [ ] Verify stdin/stdout handling
- [ ] Test with ai-runner gateway integration
- [ ] Compare performance vs Rev for same tasks
- [ ] Document success criteria

## Proposed Implementation Path

### Phase 1: Understanding (Current)
1. Deep dive into Claude Code documentation
2. Manual testing to understand behavior
3. Compare patterns with working Rev integration

### Phase 2: Integration (Next)
1. Decide: Keep separate ClaudeRunner or merge to GenericRunner?
2. Update command building logic based on tests
3. Add Claude-specific logging for visibility
4. Test with gateway integration

### Phase 3: Validation
1. Run same test tasks with Rev and Claude
2. Compare output, timing, reliability
3. Verify deduplication works
4. Verify signal handling (Ctrl+C)
5. Document differences and advantages

## Success Criteria

✓ **Claude works through ai-runner**: Tasks execute via gateway commands
✓ **Output flows to UI**: Real-time visibility of Claude's work
✓ **Deduplication works**: No repeated execution of same task
✓ **Control works**: Ctrl+C stops the process
✓ **Speed is comparable**: Claude performs as well or better than Rev
✓ **No false prompts**: UI doesn't show prompts Claude didn't generate
