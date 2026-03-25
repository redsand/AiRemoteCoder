# Test Coverage Plan

## Overview

This document outlines the comprehensive test coverage for the Connect-Back Gateway.

## Running Tests

```bash
# All tests
npm test

# MCP MVP focus
npm run test:mvp

# Run tests for a specific workspace
cd gateway && npm test
cd runner && npm test
cd ui && npm test

# Watch mode (if supported by workspace)
cd gateway && npm run test:watch

# Coverage (if supported by workspace)
cd gateway && npm run test:coverage

# Run tests matching a pattern
cd gateway && npm test -- --grep "pattern"

# Run with verbose output
cd gateway && npm test -- --reporter=verbose
cd wrapper && npm test -- --reporter=verbose

# Run specific test file
cd gateway && npm test -- src/utils/crypto.test.ts
```

Note: The root `npm test` command runs all tests across gateway, runner, and ui workspaces.
For MVP validation, prefer `npm run test:mvp`.
For workspace-specific test options (coverage, watch mode, etc.), navigate to the workspace directory and check its package.json for available scripts.

## Test Structure

```
gateway/
├── src/
│   ├── utils/
│   │   └── crypto.test.ts       # Hashing, tokens, nonces, redaction
│   ├── services/
│   │   └── database.test.ts     # Schema, CRUD, cascades
│   ├── middleware/
│   │   └── auth.test.ts         # Session auth, RBAC
│   └── routes/
│       └── runs.test.ts         # MCP claim/poll/ack/event flow

runner/
├── src/
│   └── worker.test.ts           # App-server execution, polling, ack, events
```

---

## Coverage by Component

### 1. Cryptographic Functions (`gateway/src/utils/crypto.ts`)

| Function | Test Coverage |
|----------|--------------|
| `createSignature()` | ✅ Consistency, all components included |
| `verifySignature()` | ✅ Valid/invalid signatures, timing-safe |
| `hashBody()` | ✅ Strings, buffers, consistency |
| `generateNonce()` | ✅ Uniqueness, format (32 hex chars) |
| `generateCapabilityToken()` | ✅ Uniqueness, format (64 hex chars) |
| `isTimestampValid()` | ✅ Current, within skew, outside skew |
| `redactSecrets()` | ✅ API keys, passwords, tokens, safe content |

**Key Test Cases:**
- Signature changes when any input component changes
- Timing-safe comparison prevents timing attacks
- Clock skew within ±5 minutes accepted
- All secret patterns properly redacted

### 2. Database Schema (`gateway/src/services/database.ts`)

| Table | Test Coverage |
|-------|--------------|
| `runs` | ✅ Create, update status, JSON metadata |
| `events` | ✅ Auto-increment, cascade delete, ordering |
| `commands` | ✅ Insert, status update, ack |
| `artifacts` | ✅ Metadata storage, path handling |
| `nonces` | ✅ Uniqueness constraint, cleanup |
| `users` | ✅ Unique username, password hash storage |
| `sessions` | ✅ Expiry, cascade delete |
| `audit_log` | ✅ Entries, ordering |

**Key Test Cases:**
- Foreign key constraints enforced
- Cascade delete removes child records
- Index performance for common queries
- JSON storage and retrieval

### 3. Authentication Middleware (`gateway/src/middleware/auth.ts`)

| Feature | Test Coverage |
|---------|--------------|
| UI session auth | ✅ Session lookup, expiry |
| Cloudflare Access | ✅ Header extraction |
| Role-based access | ✅ Admin, operator, viewer |

**Key Test Cases:**
- Role permissions enforced correctly
- Session expiry handled

### 4. Command Allowlist (`gateway/src/routes/runs.ts`)

| Category | Test Coverage |
|----------|--------------|
| Test commands | ✅ npm/pnpm/yarn/pytest/go/cargo |
| Git commands | ✅ diff, status, log (read-only) |
| Blocked commands | ✅ rm, curl, git push, etc. |
| Injection attempts | ✅ Semicolons, pipes, backticks |
| Edge cases | ✅ Whitespace, case sensitivity |

**Key Test Cases:**
- Only exact matches or prefix+space allowed
- Dangerous git commands blocked
- Command injection patterns blocked
- Special `__STOP__` command recognized

### 5. MCP Runner (`runner/src/worker.ts`)

| Feature | Test Coverage |
|---------|--------------|
| Claim/poll/ack loop | ✅ Pending run claim, command polling, acknowledgements |
| Codex app-server | ✅ Thread reuse, turn lifecycle, failure propagation |
| Event delivery | ✅ Structured stdout/marker/error events |
| Error handling | ✅ HTTP errors, auth failures, timeout |
| Runner identity | ✅ Explicit runner-id targeting |

**Key Test Cases:**
- Headers properly formatted
- Body hash included in signature
- Marker events structured correctly
- Graceful error handling

## Security Test Matrix

| Threat | Test File | Assertions |
|--------|-----------|------------|
| Command injection | runs.test.ts | Metacharacters blocked |
| Secret leakage | crypto.test.ts | Patterns redacted |
| Privilege escalation | auth.test.ts | Role checks enforced |
| Session hijacking | database.test.ts | Session expiry works |

---

## Performance Considerations

| Area | Test Approach |
|------|---------------|
| Nonce lookup | Database index test |
| Event streaming | Sequence ordering test |
| Log throughput | Chunk handling test |
| Large artifacts | Size limit test |

---

## Running Specific Tests

```bash
# Run tests matching pattern
npm test -w gateway -- --grep "crypto"

# Run single test file
npm test -w gateway -- src/utils/crypto.test.ts

# Run with verbose output
npm test -w gateway -- --reporter=verbose

# Watch mode during development
npm run test:watch -w gateway
```

---

## Adding New Tests

When adding new functionality:

1. **Identify the component** - gateway vs wrapper
2. **Determine test type** - unit vs integration
3. **Follow existing patterns** - see similar tests
4. **Cover edge cases** - empty input, max size, invalid format
5. **Test security implications** - injection, bypass, leakage

### Test Template

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

describe('ComponentName', () => {
  describe('functionName', () => {
    it('should handle normal case', () => {
      // Arrange
      const input = 'valid input';

      // Act
      const result = functionName(input);

      // Assert
      expect(result).toBe('expected output');
    });

    it('should handle edge case', () => {
      expect(() => functionName('')).toThrow();
    });

    it('should reject invalid input', () => {
      expect(functionName('invalid')).toBe(false);
    });
  });
});
```

---

## CI/CD Integration

```yaml
# MVP-first GitHub Actions workflow
test:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: '20'
    - run: npm ci
    - run: npm run build:mvp
    - run: npm run test:mvp

```
