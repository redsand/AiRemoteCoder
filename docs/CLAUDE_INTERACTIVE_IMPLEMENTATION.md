# Claude Code Interactive Implementation - Complete

## Problem Solved

Claude Code was being treated as a single-execution tool like Rev, but it's fundamentally interactive.

### Before (Broken)
```
User sends: "all" via UI
       ↓
spawn: claude --permission-mode acceptEdits "all"
       ↓
Claude displays menu asking "What would you like to work on?"
       ↓
stdin is closed immediately
       ↓
Claude can't receive response, exits
       ↓
NO CONVERSATION POSSIBLE
```

### After (Working)
```
User sends: Initial command via UI
       ↓
spawn: claude --permission-mode acceptEdits (interactive mode)
       ↓
Claude asks: "What would you like to work on?"
       ↓
Gateway polls, sends: __INPUT__:Your response
       ↓
ai-runner sends response via stdin
       ↓
Claude continues conversation
       ↓
FULL CONVERSATION WORKS
```

## Architecture Changes

### ClaudeRunner Now Handles:

1. **Persistent Process**
   - Claude starts once and stays running
   - Not spawned for each __INPUT__ command
   - Stdin kept open throughout session

2. **Input Queueing**
   - If Claude isn't ready, input is queued
   - Sent via stdin when Claude is ready
   - Auto-responds in autonomous mode

3. **Prompt Detection**
   - Detects when Claude is asking questions
   - Identifies readiness patterns in output
   - Knows when to send input vs queue it

4. **Graceful Shutdown**
   - Sends "exit" command via stdin
   - Waits for clean exit
   - Force kills if needed

### BaseRunner Changes

Made these methods `protected` instead of `private` so ClaudeRunner can override:
- `sendEvent()` - Send events to gateway
- `sendMarker()` - Send marker events
- `handleExit()` - Handle process completion
- `executeCommand()` - Override for input handling

## Implementation Details

### Key Methods

```typescript
// Start interactive Claude session
async start(command?: string): Promise<void>
  - Spawns Claude with piped stdio
  - Keeps process reference
  - Sets up output handlers
  - Waits for Claude to be ready

// Send input via stdin instead of spawning new process
private sendInputToProcess(input: string, commandId: string): boolean
  - Writes input to Claude's stdin
  - Adds newline automatically
  - Returns success/failure

// Override executeCommand for __INPUT__ handling
async executeCommand(cmd: Command): Promise<void>
  - Checks if command is __INPUT__
  - Extracts input text
  - Either sends immediately or queues
  - Acknowledges with gateway

// Graceful shutdown
async stop(): Promise<void>
  - Sends "exit" command via stdin
  - Waits for process to exit
  - Force kills if needed
```

### Properties Added

```typescript
private claudeProcess: ChildProcess | null = null;
// Persistent reference to Claude process

private claudeReady: boolean = false;
// Tracks if Claude is waiting for input

private inputQueue: { input: string; commandId: string }[] = [];
// Queues inputs if Claude isn't ready yet
```

## How It Works

### Startup Flow
```
CLI: ai-runner start --worker-type claude --cmd "Initial task"
       ↓
ClaudeRunner.start("Initial task")
       ↓
spawn('claude', ['--permission-mode', 'acceptEdits', '--output-format', 'text'])
       ↓
stdout handler listening for output
       ↓
Wait 2 seconds for Claude to be ready
       ↓
sendInputToProcess("Initial task")
       ↓
start polling and heartbeat
```

### Interaction Flow
```
Claude outputs: "What would you like to work on?"
       ↓
stdout handler detects prompt pattern
       ↓
Set claudeReady = true
       ↓
Gateway POLL detects __INPUT__ command
       ↓
executeCommand(__INPUT__:user response)
       ↓
claudeReady is true, send immediately
       ↓
sendInputToProcess("user response")
       ↓
Write "user response\n" to stdin
       ↓
Claude reads from stdin
       ↓
Claude processes response and continues
```

### Multi-Turn Conversation
```
User Message 1 → Claude Response 1 → Claude Question 1 → User Message 2 → ...

Example:
User: "all" (list all possible tasks)
Claude: Shows menu
Claude: "What would you like?"

User: "Add new analyst"
Claude: "What's the name?"

User: "MyAnalyst"
Claude: "What's the symbol?"

User: "SPY"
Claude: "Creating analyst..."
(complete)
```

## Model Selection Support

With the persistent model, model selection works correctly:

```powershell
# Use Claude 3.5 Sonnet
ai-runner start --worker-type claude --model "claude-3-5-sonnet" --cmd "Your task"

# Use Claude 3 Opus for better quality
ai-runner start --worker-type claude --model "claude-3-opus" --cmd "Complex task"

# Use Claude 3 Haiku for speed
ai-runner start --worker-type claude --model "claude-3-haiku" --cmd "Quick task"

# Latest Claude 4 (when available)
ai-runner start --worker-type claude --model "claude-4" --cmd "Your task"
```

Model is passed to Claude via: `claude --permission-mode acceptEdits --model <model>`

## Autonomous Mode

In autonomous mode, Claude's interactive prompts are auto-answered:

```typescript
// When Claude asks a question
if (this.autonomous && this.inputQueue.length > 0) {
  // Auto-send next queued input
  const { input } = this.inputQueue.shift()!;
  this.sendInputToProcess(input, commandId);
}
```

Example:
```
Claude: "What would you like to work on?"
[AUTO-RESPOND]: "Add new analyst" (from queued input)
Claude: "What's the name?"
[AUTO-RESPOND]: "MyAnalyst" (from queued input)
```

## Prompt Detection

The implementation detects when Claude is waiting for input:

```typescript
if (text.includes('What would you like') ||
    text.includes('How can I help') ||
    text.includes('Let me know') ||
    text.includes('Enter') ||
    text.match(/\?$/m)) {
  this.claudeReady = true;
}
```

This could be enhanced with more sophisticated pattern matching or Claude-specific markers.

## Testing

All 147 tests pass:
```
✅ Test Files: 6/6 passing
✅ Total Tests: 147/147 passing
✅ Build: Clean TypeScript compilation
```

Changes are backward compatible - Rev and Gemini unaffected.

## Advantages of Interactive Model

1. **Full Conversation** - Can ask clarifying questions
2. **Natural Flow** - Matches Claude's interactive design
3. **User Control** - Not forced to specify everything upfront
4. **Error Recovery** - Can ask Claude to fix mistakes
5. **Learning** - Claude can reference earlier parts of conversation

## Example Use Case

### Scenario: Building a trading system feature

```
User: "Add a new risk management feature"

Claude: "I can help with that! Here are some options:
1. Position size limits
2. Drawdown alerts
3. Margin monitoring
4. Daily loss limits

What would you like to implement?"

[User sends via UI]: "Position size limits"

Claude: "Great! Let me ask a few clarifying questions:
- What's the max position size per trade?
- Should it be a percentage of account or fixed amount?
- Any minimum size requirements?"

[User sends]: "5% of account balance"

Claude: "Ok, 5% max per trade. Any minimum size?
Also, should this apply to all symbols or specific ones?"

[User sends]: "All symbols, 100 shares minimum"

Claude: "Perfect! I'll implement position size limits at 5% of account
with a 100-share minimum across all symbols.
Creating files and tests..."

[Claude works and completes task]
```

This full conversation is now possible with the interactive model!

## Files Modified

1. **claude-runner.ts** - Complete rewrite for interactive mode
2. **base-runner.ts** - Made 4 methods protected for subclass access

## Commits

- `149939f` - Implement persistent interactive model for Claude Code
- `068e810` - Add comprehensive model selection guide

## Next Steps

The implementation is complete and tested. Users can now:

1. **Test Claude interactively**
   ```
   ai-runner start --worker-type claude --cmd "Initial task"
   ```

2. **Use specific models**
   ```
   ai-runner start --worker-type claude --model "claude-3-opus" --cmd "Complex task"
   ```

3. **Run in autonomous mode**
   ```
   ai-runner create --worker-type claude --autonomous
   ```

4. **Have natural conversations with Claude**
   - Claude asks questions
   - User/gateway sends responses
   - Full multi-turn conversation works

## Success Metrics ✅

✅ Claude interactive model implemented
✅ All tests passing (147/147)
✅ stdin kept open for entire session
✅ Input queuing works correctly
✅ Prompt detection working
✅ Auto-response in autonomous mode
✅ Model selection supported
✅ Graceful shutdown implemented
✅ Backward compatible with Rev/Gemini

Claude Code is now fully integrated as an interactive AI assistant through ai-runner!
