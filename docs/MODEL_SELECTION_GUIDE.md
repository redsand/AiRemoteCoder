# Model Selection Guide

All workers support model selection via the `--model` flag.

## Claude Code Models

```powershell
# Claude 3.5 Sonnet (Recommended for most tasks)
ai-runner start --worker-type claude --model "claude-3-5-sonnet" --cmd "Your task"

# Claude 3 Opus (Most capable, slower/more expensive)
ai-runner start --worker-type claude --model "claude-3-opus" --cmd "Your task"

# Claude 3 Haiku (Fast, cheaper, less capable)
ai-runner start --worker-type claude --model "claude-3-haiku" --cmd "Your task"

# Claude 4 (when available)
ai-runner start --worker-type claude --model "claude-4" --cmd "Your task"

# No model specified - uses Claude's default
ai-runner start --worker-type claude --cmd "Your task"
```

## Google Gemini Models

```powershell
# Gemini 2.5 Pro (Latest, most capable)
ai-runner start --worker-type gemini --model "gemini-2.5-pro" --cmd "Your task"

# Gemini 2.5 Flash (Latest fast variant)
ai-runner start --worker-type gemini --model "gemini-2.5-flash" --cmd "Your task"

# Gemini 3 (when available)
ai-runner start --worker-type gemini --model "gemini-3" --cmd "Your task"

# Gemini 1.5 Pro (Stable)
ai-runner start --worker-type gemini --model "gemini-1.5-pro" --cmd "Your task"

# Gemini 1.5 Flash (Fast)
ai-runner start --worker-type gemini --model "gemini-1.5-flash" --cmd "Your task"

# Gemini Pro (Original)
ai-runner start --worker-type gemini --model "gemini-pro" --cmd "Your task"

# No model specified - uses Gemini's default
ai-runner start --worker-type gemini --cmd "Your task"
```

## Custom Rev Tool Models

```powershell
# Ollama models
ai-runner start --worker-type rev --model "qwen:7b" --cmd "Your task"
ai-runner start --worker-type rev --model "llama2:7b" --cmd "Your task"
ai-runner start --worker-type rev --model "mistral:7b" --cmd "Your task"
```

## Autonomous Mode with Models

```powershell
# Create autonomous run with Claude Opus
ai-runner create --worker-type claude --model "claude-3-opus" --autonomous

# Create autonomous run with Gemini 2.5
ai-runner create --worker-type gemini --model "gemini-2.5-pro" --autonomous

# Create autonomous run with Rev
ai-runner create --worker-type rev --model "qwen:7b" --autonomous
```

## Model Selection in Code

The model is passed to the runner and included in command building:

```typescript
// In CLI - passed to runner
runner = new ClaudeRunner({
  runId: options.runId,
  capabilityToken: options.token,
  model: options.model,  // "claude-3-5-sonnet"
  workingDir: options.cwd,
  autonomous: options.autonomous
});

// In buildCommand() - included in CLI args
buildCommand(command?: string) {
  const args = [];
  args.push('--permission-mode', 'acceptEdits');
  if (this.model) {
    args.push('--model', this.model);  // Passed to Claude
  }
  // Result: claude --permission-mode acceptEdits --model claude-3-5-sonnet
}
```

## How Model Selection Works

1. **CLI Option**: User specifies `--model "model-name"`
2. **Passed to Runner**: Model stored in runner's `this.model` property
3. **Built into Command**: Model included in CLI args when spawning worker
4. **Executed**: Worker receives model flag and uses it

## Default Models (if not specified)

### Claude
- Uses Claude's default model (typically latest stable)
- Can be configured via environment: `CLAUDE_DEFAULT_MODEL`

### Gemini
- Default from config: `config.geminiModel`
- Can be set via environment: `GEMINI_MODEL=gemini-2.5-pro`

### Rev
- No default model (provider-specific)
- Must specify or use Rev's default

## Examples

### Quick Start with Specific Models
```powershell
# Fast, cheap Gemini
ai-runner start --run-id $id --token $token --worker-type gemini --model "gemini-2.5-flash" --cmd "Quick analysis"

# Most capable Claude
ai-runner start --run-id $id --token $token --worker-type claude --model "claude-3-opus" --cmd "Complex code review"

# Balanced Sonnet
ai-runner start --run-id $id --token $token --worker-type claude --model "claude-3-5-sonnet" --cmd "Your task"
```

### Testing Different Models
```powershell
# Compare models on same task
$task = "Review this code for bugs"

"Claude Haiku" {
  ai-runner start --worker-type claude --model "claude-3-haiku" --cmd $task
}

"Claude Sonnet" {
  ai-runner start --worker-type claude --model "claude-3-5-sonnet" --cmd $task
}

"Claude Opus" {
  ai-runner start --worker-type claude --model "claude-3-opus" --cmd $task
}

"Gemini Flash" {
  ai-runner start --worker-type gemini --model "gemini-2.5-flash" --cmd $task
}

"Gemini Pro" {
  ai-runner start --worker-type gemini --model "gemini-2.5-pro" --cmd $task
}
```

## Recommendations

### For Speed & Cost
- **Claude**: `claude-3-haiku`
- **Gemini**: `gemini-2.5-flash`

### For Balanced Performance
- **Claude**: `claude-3-5-sonnet` (Recommended)
- **Gemini**: `gemini-2.5-pro`

### For Best Quality
- **Claude**: `claude-3-opus`
- **Gemini**: `gemini-2.5-pro`

### For Latest Features
- **Claude**: `claude-3-5-sonnet` (latest stable)
- **Gemini**: `gemini-2.5-pro` (latest)

## Checking Available Models

### Claude Models
```bash
# Check installed Claude Code version
claude --version

# List available models (if Claude supports it)
# May vary by installation
```

### Gemini Models
```bash
# Check installed Gemini CLI
gemini-cli --version

# Models depend on your Google AI API access
```

### Rev Models
```bash
# List available Ollama models (if using Ollama)
ollama list

# Or check Rev's documentation for available providers
```

## Troubleshooting

### "Model not found" Error
- Verify model name is correct
- Check that you have access to the model
- Ensure the AI tool is properly installed

### Performance Issues with Large Models
- Try smaller models for testing: `claude-3-haiku`, `gemini-2.5-flash`
- Use larger models only for complex tasks

### Cost Concerns
- Use faster models for simple tasks (haiku, flash)
- Save expensive models (opus, pro) for complex work

## Summary

Model selection is built-in and easy:
```powershell
ai-runner start --worker-type claude --model "claude-3-5-sonnet" --cmd "Your task"
ai-runner start --worker-type gemini --model "gemini-2.5-pro" --cmd "Your task"
ai-runner start --worker-type rev --model "qwen:7b" --cmd "Your task"
```

Try different models to find the best balance of speed, cost, and quality for your use case!
