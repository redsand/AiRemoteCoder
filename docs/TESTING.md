# Test Coverage Plan

## Overview

This document outlines the comprehensive test coverage for the Connect-Back Gateway.

## Running Tests

```bash
# All tests
npm test

# Gateway tests only
npm test -w gateway

# Wrapper tests only
npm test -w wrapper

# With coverage report
npm test -- --coverage
```

## Test Structure

```
gateway/
├── src/
│   ├── utils/
│   │   └── crypto.test.ts       # HMAC, hashing, nonces, redaction
│   ├── services/
│   │   └── database.test.ts     # Schema, CRUD, cascades
│   ├── middleware/
│   │   └── auth.test.ts         # Signature verification, RBAC
│   └── routes/
│       └── runs.test.ts         # Command allowlist validation

wrapper/
├── src/
│   ├── utils/
│   │   └── crypto.test.ts       # Client-side signing
│   └── services/
│       ├── gateway-client.test.ts  # HTTP client, error handling
│       └── claude-runner.test.ts   # Process management, commands
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
| Wrapper HMAC auth | ✅ Valid requests, header validation |
| Timestamp validation | ✅ Expired, future, within skew |
| Replay protection | ✅ Nonce tracking, expiry |
| Capability tokens | ✅ Per-run validation |
| UI session auth | ✅ Session lookup, expiry |
| Cloudflare Access | ✅ Header extraction |
| Role-based access | ✅ Admin, operator, viewer |

**Key Test Cases:**
- Tampered requests rejected (method, path, body)
- Replay attacks detected
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

### 5. Gateway Client (`wrapper/src/services/gateway-client.ts`)

| Feature | Test Coverage |
|---------|--------------|
| Request signing | ✅ All required headers |
| Run auth headers | ✅ runId, capabilityToken |
| Event types | ✅ All 6 types validated |
| Error handling | ✅ HTTP errors, network errors, timeout |
| Health check | ✅ Success/failure detection |

**Key Test Cases:**
- Headers properly formatted
- Body hash included in signature
- Marker events structured correctly
- Graceful error handling

### 6. Claude Runner (`wrapper/src/services/claude-runner.ts`)

| Feature | Test Coverage |
|---------|--------------|
| Command validation | ✅ Allowlist check |
| Output processing | ✅ stdout/stderr chunks |
| Secret redaction | ✅ Before sending |
| Lifecycle events | ✅ start/finish markers |
| Event sequencing | ✅ Incremental sequence |
| Stop handling | ✅ Graceful vs force |
| Log files | ✅ Path construction, format |
| Working directory | ✅ Validation, safety |
| Tmate assist | ✅ URL parsing |
| Result handling | ✅ Capture, truncation |

**Key Test Cases:**
- Non-allowlisted commands blocked
- Secrets redacted from output
- Exit codes properly reported
- Path traversal prevented

---

## Security Test Matrix

| Threat | Test File | Assertions |
|--------|-----------|------------|
| HMAC forgery | crypto.test.ts | Signature tampering detected |
| Replay attack | auth.test.ts | Nonce reuse blocked |
| Clock manipulation | crypto.test.ts | Timestamp bounds enforced |
| Command injection | runs.test.ts | Metacharacters blocked |
| Secret leakage | crypto.test.ts | Patterns redacted |
| Path traversal | claude-runner.test.ts | Outside-project paths blocked |
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
# Example GitHub Actions workflow
test:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: '20'
    - run: npm ci
    - run: npm test
    - run: npm run test -- --coverage
    - uses: codecov/codecov-action@v3
```
