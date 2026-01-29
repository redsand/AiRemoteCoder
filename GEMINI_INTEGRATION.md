# Google Gemini Integration - Complete

## Quick Summary

Gemini has been integrated into ai-runner following the same patterns as Claude and Rev, with one key difference:

**Gemini uses named `--prompt` flag instead of positional arguments**

```bash
# Gemini format (different from Claude/Rev)
gemini --output-format text --model gemini-1.5-pro --prompt "Create a test" --approval-mode yolo

# Compare with Claude (positional)
claude --permission-mode acceptEdits --output-format text --model claude-3-5-sonnet "Create a test"

# Compare with Rev (positional)
rev --trust-workspace --model qwen:7b "Create a test"
```

## Command Structure

### Gemini
```
Usage: gemini [options]

Key flags:
  --output-format text              # Use text output (not JSON)
  --model <model>                   # Specify model (e.g., gemini-1.5-pro)
  --prompt "<prompt>"               # The task/prompt (named flag!)
  --approval-mode yolo              # Auto-approve changes (equivalent to --trust-workspace)
```

### Implementation
```typescript
buildGeminiCommand(command?: string, autonomous?: boolean): WorkerCommandResult {
  const args: string[] = [];

  // Use text output format
  args.push('--output-format', 'text');

  // Add model
  const model = this.model || config.geminiModel;
  args.push('--model', model);

  // Add prompt as named flag
  if (command) {
    args.push('--prompt', command);
  }

  // In autonomous mode, auto-approve changes
  if (autonomous) {
    args.push('--approval-mode', 'yolo');
  }

  return { args, fullCommand: `${this.getCommand()} ${args.join(' ')}` };
}
```

## Flag Mapping: Gemini vs Claude vs Rev

| Purpose | Gemini | Claude | Rev |
|---------|--------|--------|-----|
| **Skip Permission Prompts** | `--approval-mode yolo` | `--permission-mode acceptEdits` | `--trust-workspace` |
| **Select Model** | `--model <model>` | `--model <model>` | `--model <model>` |
| **Specify Prompt** | `--prompt "text"` | `"text"` (positional) | `"text"` (positional) |
| **Output Format** | `--output-format text` | `--output-format text` | (stdout) |

## Why Gemini Uses Named Prompt Flag

Unlike Claude and Rev which accept prompts as positional arguments, Gemini requires the prompt to be passed via `--prompt` named flag. This is how Google designed Gemini CLI.

**This is still compatible with ai-runner** because:
1. We build the command in `buildGeminiCommand()`
2. We pass command as `--prompt "text"` instead of positional
3. The flow remains identical to Claude/Rev
4. Process spawning still works the same way

## Implementation Details

### Location
**File**: `wrapper/src/services/generic-runner.ts`
**Method**: `buildGeminiCommand()` (lines ~176-205)

### Command Building Logic
```
Input:  command='Create a test', autonomous=false

buildGeminiCommand() generates:
├─ --output-format text           (consistent output)
├─ --model gemini-1.5-pro         (from options or default)
├─ --prompt "Create a test"       (NAMED FLAG, not positional)
└─ (no --approval-mode yolo)      (only in autonomous mode)

Output: ['--output-format', 'text', '--model', 'gemini-1.5-pro', '--prompt', 'Create a test']
Full:   gemini-cli --output-format text --model gemini-1.5-pro --prompt "Create a test"
```

### Test Verification
**Test File**: `wrapper/src/services/generic-runner.test.ts`
**Test**: `should build Gemini command with model` (line 231)
**Status**: ✅ Passing

## Execution Flow: Identical to Claude/Rev

```
User Input: ai-runner start --worker-type gemini --model "gemini-1.5-pro" --cmd "Create a test"
                ↓
Parse args: workerType='gemini', model='gemini-1.5-pro', cmd='Create a test'
                ↓
Create GenericRunner with options
                ↓
Gateway sends: __INPUT__:Create a test
                ↓
buildCommand() → buildGeminiCommand()
                ↓
Generate: ['--output-format', 'text', '--model', 'gemini-1.5-pro', '--prompt', 'Create a test']
                ↓
Spawn: gemini-cli --output-format text --model gemini-1.5-pro --prompt "Create a test"
                ↓
Process executes without permission prompts (--approval-mode yolo in autonomous mode)
                ↓
Output captured via stdout/stderr
                ↓
Events sent to gateway
                ↓
30-minute deduplication prevents re-execution
```

## CLI Integration

### Create Command
```powershell
ai-runner create --worker-type gemini --model "gemini-1.5-pro" --autonomous
```

### Start Command
```powershell
ai-runner start \
  --run-id $runId \
  --token $token \
  --worker-type gemini \
  --model "gemini-1.5-pro" \
  --cmd "Create a comprehensive test suite"
```

### Autonomous Mode
```powershell
ai-runner start \
  --run-id $runId \
  --token $token \
  --worker-type gemini \
  --autonomous
  # Will use --approval-mode yolo automatically
```

## Model Selection

### Available Models (Examples)
```
--model "gemini-pro"              # Original model
--model "gemini-pro-vision"       # Vision capabilities
--model "gemini-1.5-pro"          # Latest 1.5 Pro
--model "gemini-1.5-flash"        # Fast variant
```

### Configuration
```bash
# Via environment variable
export GEMINI_MODEL="gemini-1.5-pro"

# Via command line
ai-runner start --worker-type gemini --model "gemini-1.5-pro" --cmd "Your task"
```

## Key Differences from Claude/Rev

| Aspect | Gemini | Claude/Rev |
|--------|--------|-----------|
| **Prompt Argument** | Named flag: `--prompt "text"` | Positional: `"text"` |
| **Permission Mode** | `--approval-mode yolo` | Claude: `--permission-mode acceptEdits` / Rev: `--trust-workspace` |
| **Output Format** | Optional: `--output-format text` | Claude: `--output-format text` / Rev: stdout |
| **Implementation** | GenericRunner (shared) | Claude: ClaudeRunner / Rev: GenericRunner |

## Test Coverage

✅ **Test File**: `wrapper/src/services/generic-runner.test.ts`
✅ **Gemini-Specific Test**: "should build Gemini command with model" (line 231)
✅ **Status**: Passing (147/147 tests)

**What's Tested**:
- Model selection works
- Prompt passed as named flag
- Command building generates correct args
- Full command string matches expected format

## Worker Registry

**Registered As**: `'gemini'` type in `WORKER_CONFIGS`

```typescript
gemini: {
  type: 'gemini',
  command: config.geminiCommand,
  displayName: 'Gemini CLI',
  icon: '',
  defaultModel: config.geminiModel,
  supportsModelSelection: true,
  description: 'Google Gemini CLI for AI assistance'
}
```

## Configuration

**Environment Variable**:
```bash
GEMINI_COMMAND=gemini-cli    # Path to gemini binary
GEMINI_MODEL=gemini-1.5-pro  # Default model
```

**Runtime Override**:
```powershell
ai-runner start --worker-type gemini --model "gemini-1.5-pro" ...
```

## Examples

### Example 1: Simple Task
```powershell
ai-runner start \
  --run-id run-123 \
  --token token-abc \
  --worker-type gemini \
  --model "gemini-pro" \
  --cmd "Create a helper function"
```

**Generated Command**:
```bash
gemini-cli --output-format text --model gemini-pro --prompt "Create a helper function"
```

### Example 2: Autonomous Mode
```powershell
ai-runner start \
  --run-id run-456 \
  --token token-xyz \
  --worker-type gemini \
  --model "gemini-1.5-pro" \
  --autonomous
```

**Generated Command** (waits for gateway input):
```bash
gemini-cli --output-format text --model gemini-1.5-pro --approval-mode yolo
```

### Example 3: Default Model
```powershell
ai-runner start \
  --run-id run-789 \
  --token token-123 \
  --worker-type gemini \
  --cmd "Check the code quality"
```

**Generated Command** (uses configured default):
```bash
gemini-cli --output-format text --model gemini-1.5-pro --prompt "Check the code quality"
```

## Comparison Summary

### All Three Workers Now Supported

| Worker | Status | Pattern | Permission | Prompt |
|--------|--------|---------|-----------|--------|
| **Claude** | ✅ Complete | `claude [flags] "prompt"` | `--permission-mode acceptEdits` | Positional |
| **Rev** | ✅ Complete | `rev [flags] "prompt"` | `--trust-workspace` | Positional |
| **Gemini** | ✅ Complete | `gemini-cli [flags]` | `--approval-mode yolo` | `--prompt "text"` |

### Unified Architecture Benefits

1. **Same Gateway Integration**: All three workers use identical polling, deduplication, output handling
2. **Same CLI Interface**: All support `--model` flag and autonomous mode
3. **Same Testing**: All tested with same test suite (147 tests)
4. **Same Execution Flow**: All follow identical process spawning and lifecycle
5. **Flexible**: Each worker has optimized command building for its specific CLI

## Next Steps for Testing

1. **Manual Test Gemini**:
   ```bash
   gemini-cli --output-format text --model gemini-1.5-pro --prompt "Create a test file" --approval-mode yolo
   ```

2. **Integration Test**:
   ```powershell
   ai-runner start --run-id $id --token $token --worker-type gemini --cmd "Your task"
   ```

3. **Compare with Claude/Rev**:
   - Same task, three different workers
   - Compare output quality, timing, reliability

4. **Verify Deduplication**:
   ```powershell
   .\analyze-test-logs.ps1 $id
   ```

## Deployment Status

✅ **Implementation**: Complete
✅ **Tests**: All 147 passing (including Gemini tests)
✅ **CLI Integration**: Full support
✅ **Documentation**: Complete
✅ **Ready for**: Manual testing & comparison

## Summary

Gemini integration is **complete and identical in functionality** to Claude and Rev, with the only difference being:

- **Named prompt flag**: `--prompt "text"` instead of positional
- **Approval mode**: `--approval-mode yolo` instead of other permission flags
- **Output format**: Explicitly set to `--output-format text`

All other aspects (model selection, autonomous mode, deduplication, signal handling, output streaming) work exactly the same as Claude and Rev.

**All 147 tests pass. Ready for production testing.**
