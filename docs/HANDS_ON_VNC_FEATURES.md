# VNC Agent Wrapper and Hands-On AI Runner

## Overview

This implementation adds two critical fallback mechanisms to the AI Remote Coder system:

1. **VNC Runner** - Full remote desktop access via VNC when agents fail
2. **Hands-On Runner** - Interactive shell with complete manual control as the ultimate fallback

These features enable users to take full manual control when automated agents encounter issues or need human intervention.

## VNC Runner (Remote Desktop Access)

### Features
- **Full Screen Sharing** - Stream entire desktop to remote user via VNC
- **Window-Specific Mode** - Option to share specific windows only
- **Real-time Control** - Remote mouse and keyboard control
- **Persistent Connection** - Keeps VNC server running for continuous access
- **Fallback Safety** - Automatically available when other agents fail

### Configuration

#### Launch via CLI
```bash
claude start --worker-type vnc --cwd /path/to/project
```

#### Runner Options
```typescript
interface VncRunnerOptions extends RunnerOptions {
  vncPort?: number;                      // VNC port (default: 5900)
  displayMode?: 'screen' | 'window';     // Full screen or selected window
  windowTitle?: string;                  // For window mode
  resolution?: string;                   // e.g., "1920x1080"
}
```

### How It Works

1. VNC Runner extends `BaseRunner` to manage VNC server lifecycle
2. Supports `x11vnc` (preferred - no Xvfb needed) or `vncserver` (TigerVNC/TightVNC)
3. Spawns VNC server listening on localhost
4. Streams desktop display to connected clients
5. Integrates with gateway for remote connection management
6. Capabilities advertised: `["vnc_access", "remote_desktop", "mouse_control", "keyboard_control"]`

### VNC Server Selection

The runner automatically detects available VNC servers:
1. Tries `x11vnc` first (preferred for existing X display)
2. Falls back to `vncserver` if x11vnc not available
3. Returns error if neither is installed

### Key Files
- `wrapper/src/services/vnc-runner.ts` - VNC runner implementation (230 lines)

## Hands-On Runner (Manual Control)

### Features
- **Full Interactive Shell** - Complete bash/zsh/fish shell access
- **Filesystem Control** - Full read/write access to project files
- **Process Management** - Launch any command or debug process
- **Real-time Interaction** - Bidirectional stdin/stdout/stderr
- **Complete Logging** - All commands logged and streamed to gateway
- **Fallback Trigger** - Can be launched from any failing agent

### Configuration

#### Launch via CLI
```bash
claude start --worker-type hands-on --cwd /path/to/project
```

#### Runner Options
```typescript
interface HandsOnRunnerOptions extends RunnerOptions {
  reason?: string;              // Why hands-on mode was triggered
  shell?: string;               // Shell to use (bash, zsh, fish)
  fallbackFrom?: string;        // Agent type that failed (claude, gemini, etc.)
}
```

### How It Works

1. Hands-On Runner extends `BaseRunner` for process lifecycle management
2. Spawns an interactive shell with inherited stdin for real-time input
3. Captures stdout/stderr and streams to gateway
4. Maintains current working directory state
5. Executes all CLI commands sent from gateway as __INPUT__ commands
6. Logs all activity for audit trail
7. Capabilities advertised: `["manual_control", "full_shell_access", "filesystem_control", "process_execution", "keyboard_input"]`

### Use Cases

1. **Agent Failed** - When Claude, Gemini, or other agents encounter unsolvable errors
2. **Complex Debugging** - When automated debugging tools can't identify the issue
3. **Emergency Control** - Immediate manual access when agents are stuck
4. **Validation Testing** - Manual verification of changes before committing
5. **Advanced Operations** - Tasks requiring interactive input or complex logic

### Key Files
- `wrapper/src/services/hands-on-runner.ts` - Hands-on runner implementation (200 lines)

## Fallback Mechanism

### Triggering Hands-On from Other Runners

Any runner can trigger hands-on mode by receiving the special command:

```
__LAUNCH_HANDS_ON__:reason text here
```

### Implementation Details

1. **Command Handler** - Added to `BaseRunner.executeCommand()` in base-runner.ts
2. **Event Emission** - Emits `launch-hands-on` event with `{ reason, fallbackFrom }`
3. **Gateway Integration** - Gateway can send `__LAUNCH_HANDS_ON__:` command to any run
4. **Graceful Transition** - Current runner acknowledges before handing off

### Flow Example

```
1. Claude Runner encounters error
   ↓
2. User sends command: __LAUNCH_HANDS_ON__:Claude failed with error X
   ↓
3. Claude Runner receives special command in executeCommand()
   ↓
4. Sends acknowledgment to gateway
   ↓
5. Emits 'launch-hands-on' event with reason and fallback info
   ↓
6. Gateway can use this signal to launch Hands-On Runner
   ↓
7. User now has full manual control
```

## Worker Registry Updates

### New Worker Types Added

```typescript
// In worker-registry.ts

type WorkerType = 'claude' | 'ollama-launch' | 'codex' | 'gemini' | 'rev' | 'vnc' | 'hands-on';

WORKER_CONFIGS = {
  // ... existing configs ...
  vnc: {
    type: 'vnc',
    command: 'x11vnc',
    displayName: 'VNC Remote Desktop',
    description: 'Full remote desktop access via VNC - fallback when agents fail'
  },
  'hands-on': {
    type: 'hands-on',
    command: 'bash',
    displayName: 'Hands-On Control',
    description: 'Interactive shell for manual control and debugging'
  }
};
```

## CLI Integration

### Updated CLI Commands

```bash
# Start a VNC session
claude start --run-id <id> --token <token> --worker-type vnc

# Start hands-on manual control
claude start --run-id <id> --token <token> --worker-type hands-on

# With working directory
claude start --run-id <id> --token <token> --worker-type vnc --cwd /path/to/project
```

### Changes to CLI
- `wrapper/src/cli.ts` - Added VNC and Hands-On runner instantiation
- Both quick-create and explicit start commands support new worker types

## Database Schema

No schema changes needed. Existing fields provide flexibility:

- `runs.worker_type` - Already stores worker type (supports new types)
- `runs.metadata` - Stores worker-specific data (VNC port, display mode, shell type, etc.)
- `clients.capabilities` - Lists supported capabilities (already used for feature detection)

Example metadata:
```json
// VNC Run
{
  "vncPort": 5900,
  "displayMode": "screen",
  "resolution": "1920x1080"
}

// Hands-On Run
{
  "shell": "/bin/bash",
  "reason": "Previous agent failed",
  "fallbackFrom": "claude"
}
```

## File Structure

```
wrapper/src/
├── services/
│   ├── base-runner.ts          (updated: added __LAUNCH_HANDS_ON__ command handler)
│   ├── vnc-runner.ts           (new: VNC server management)
│   ├── hands-on-runner.ts      (new: Interactive shell management)
│   └── worker-registry.ts      (updated: added vnc and hands-on types)
├── cli.ts                       (updated: runner instantiation for new types)
└── index.ts                     (updated: exports for new runners)

gateway/src/
└── services/
    └── database.ts             (no changes needed - schema flexible)
```

## Architecture Benefits

### 1. **Modular Design**
- Each runner extends `BaseRunner` with specialized behavior
- Clean separation of concerns
- Easy to add more runners in future

### 2. **Gateway Integration**
- Runners register with capabilities list
- Gateway can intelligently offer features based on capabilities
- Real-time event streaming to UI
- Command polling for operator input

### 3. **Safety & Logging**
- All operations logged to gateway
- Audit trail of all manual commands
- Graceful shutdown mechanisms
- Error handling and reporting

### 4. **Fallback Chain**
```
Automated Agent (Claude)
        ↓ (error)
        ↓
  Fallback Attempt
        ↓ (if needed)
        ↓
   Hands-On Mode
        ↓ (if needed)
        ↓
   VNC Remote Desktop
```

## Future Enhancements

1. **VNC Encryption** - Add SSL/TLS for secure remote connections
2. **Display Format Options** - Support different VNC encodings
3. **Recording** - Record VNC sessions for audit/debugging
4. **Multi-window Support** - Track and switch between windows
5. **Advanced Debugging** - GDB, lldb, debugger integration
6. **Container Support** - Execute in Docker containers
7. **Keyboard Macros** - Predefined automation sequences
8. **Session Replay** - Replay recorded sessions

## Usage Scenarios

### Scenario 1: Quick Fix
```
1. Claude starts running a complex task
2. Task hits an edge case Claude can't handle
3. User sends __LAUNCH_HANDS_ON__:Claude stuck on error X
4. Hands-On runner takes over
5. User quickly fixes the issue manually
6. Resumes with next task
```

### Scenario 2: Emergency Access
```
1. System in problematic state
2. Need immediate manual control
3. Launch hands-on directly via: claude start --worker-type hands-on
4. Full shell access available immediately
5. Fix issues directly
```

### Scenario 3: Remote Collaboration
```
1. Developer in different location needs help
2. Launch VNC runner
3. Expert can see and control desktop
4. Guide developer through complex procedures
5. Real-time collaboration and debugging
```

## Testing

The implementation includes:
- Unit tests for runner lifecycle (start, stop, exit)
- Integration tests with gateway communication
- Command execution tests
- Error handling scenarios

Run tests:
```bash
cd wrapper
npm test
```

## Backward Compatibility

- All existing agent runners (Claude, Gemini, Rev, Codex, Ollama) remain unchanged
- Default worker type still 'claude'
- New runners are opt-in features
- CLI maintains backward compatibility

## Security Considerations

1. **VNC Access** - Only accessible via localhost (no network exposure)
2. **Shell Access** - Inherits from parent process security model
3. **Command Validation** - Hands-on runner still respects allowlist for special commands
4. **Logging** - All actions logged for audit trail
5. **Process Isolation** - Each run has isolated process and working directory

## Performance

- **VNC** - Efficient screen sharing with x11vnc (minimal CPU overhead)
- **Hands-On** - Native shell performance (no extra layers)
- **Memory** - Minimal additional memory footprint
- **Network** - Gateway handles compression/optimization
