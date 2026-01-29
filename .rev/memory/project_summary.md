# Project Memory (Rev)

This file is maintained automatically by Rev.
It is intentionally concise and operational.

## What This Repo Is
- Rev: agentic CI/CD + refactoring assistant focused on safe, verifiable changes.

## Current Architecture
- Execution modes: linear executor and sub-agent orchestrator.
- WorkspaceResolver: canonical path validation for tools/verifiers.
- ContextBuilder: Select pipeline (code/docs/tools/memory) with tool retrieval.
- Artifacts: tool outputs persisted under `.rev/artifacts/` (redacted).
- CompressionPolicy: centralized tool-output compression knobs.

## Known Failure Modes + Fixes
- (none recorded)

## Conventions
- Prefer package exports (`__init__.py`) over mass explicit imports.
- Don’t re-run tests unless something changed; prefer smoke imports for import-only validation.

## Recently Changed Files
- (none recorded)
