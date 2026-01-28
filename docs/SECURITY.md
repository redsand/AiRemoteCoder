# Security Model

## Threat Model

### Assets to Protect
1. **Claude Code output** - May contain sensitive code, secrets, or business logic
2. **Gateway authentication** - Prevents unauthorized access to runs and commands
3. **Command execution** - Prevents arbitrary code execution on the wrapper host
4. **User credentials** - Admin passwords and TOTP secrets
5. **Session tokens** - Prevents session hijacking

### Threat Actors
1. **Network attackers** - Can intercept traffic, attempt MITM
2. **Unauthorized users** - Attempt to access UI without credentials
3. **Compromised wrapper** - Attacker gains access to a wrapper's credentials
4. **Replay attackers** - Capture and replay valid requests

---

## Security Controls

### 1. Transport Layer Security (TLS)

**Threat**: Network eavesdropping, MITM attacks

**Mitigations**:
- All gateway communications use HTTPS/WSS
- Self-signed certificates for development
- Production should use trusted CA certificates
- HSTS headers enforced

**Configuration**:
```env
TLS_ENABLED=true
```

---

### 2. Wrapper Authentication (Connect-Back)

**Threat**: Unauthorized wrapper connections, request forgery

**Mitigations**:
- HMAC-SHA256 signature over:
  - HTTP method
  - Request path
  - Body hash (SHA256)
  - Unix timestamp
  - Random nonce
  - Run ID
  - Capability token
- Clock skew limited to ±5 minutes
- Nonce stored in SQLite with TTL (prevents replay)
- Per-run capability tokens (limits blast radius)

**Request Headers**:
```
X-Signature: <hmac-hex>
X-Timestamp: <unix-seconds>
X-Nonce: <random-hex>
X-Run-Id: <run-id>
X-Capability-Token: <token>
```

**Verification Algorithm**:
```
message = method + "\n" + path + "\n" + sha256(body) + "\n" + timestamp + "\n" + nonce + "\n" + runId + "\n" + capabilityToken
expected = hmac_sha256(secret, message)
valid = timing_safe_equal(signature, expected)
```

---

### 3. UI Authentication

**Threat**: Unauthorized UI access

**Mitigations**:

#### Option A: Cloudflare Access (Recommended)
- Zero-trust identity verification
- SSO with Google, GitHub, etc.
- Access policies per application
- Headers validated by gateway:
  - `Cf-Access-Authenticated-User-Email`
  - `Cf-Access-Jwt-Assertion`

#### Option B: Local Authentication
- Password hashed with Argon2id:
  - Memory: 64 MB
  - Iterations: 3
  - Parallelism: 4
- Optional TOTP two-factor authentication
- Session tokens: 48 random bytes
- Session duration: 24 hours
- HTTPOnly, Secure, SameSite=Strict cookies

---

### 4. Authorization

**Threat**: Privilege escalation

**Mitigations**:
- Role-based access control:
  - `admin`: Full access, user management
  - `operator`: Start/stop runs, send commands
  - `viewer`: Read-only access to runs and logs
- Role checked on every protected endpoint
- Audit log of all operator actions

---

### 5. Command Safety

**Threat**: Arbitrary code execution via commands

**Mitigations**:
- **Allowlist-only execution**: Only pre-approved commands run
- Default allowlist:
  ```
  npm test, npm run test
  pnpm test, pnpm run test
  yarn test
  pytest, pytest -v
  go test ./...
  cargo test
  git diff, git diff --cached
  git status
  git log --oneline -10
  ls -la, pwd
  ```
- Commands run in repo working directory only
- No shell metacharacters (commands are not passed through shell)
- Configurable via `EXTRA_ALLOWED_COMMANDS`

---

### 6. Secret Redaction

**Threat**: Secrets leaked in logs

**Mitigations**:
- Output scanned before transmission
- Redaction patterns:
  - API keys, tokens, passwords (common formats)
  - OpenAI keys: `sk-[a-zA-Z0-9]{20,}`
  - GitHub tokens: `ghp_`, `ghs_`
  - NPM tokens: `npm_`
  - PEM private keys
- Configurable patterns in config
- Redaction also applied on gateway side

---

### 7. Rate Limiting

**Threat**: DoS, brute force attacks

**Mitigations**:
- 100 requests per minute per IP
- Uses Cloudflare headers for true client IP
- Configurable limits

---

### 8. Input Validation

**Threat**: Injection attacks, malformed input

**Mitigations**:
- Zod schema validation on all endpoints
- Maximum body size: 10 MB
- Maximum artifact size: 50 MB
- File type restrictions for uploads
- Path traversal prevention for artifacts

---

## Security Checklist for Production

### Required
- [ ] Use production TLS certificates (Let's Encrypt or CA-signed)
- [ ] Set strong, unique HMAC_SECRET (32+ random bytes)
- [ ] Set strong, unique AUTH_SECRET (32+ random bytes)
- [ ] Enable Cloudflare Access or strong local auth
- [ ] Review and restrict allowlisted commands
- [ ] Set appropriate RUN_RETENTION_DAYS

### Recommended
- [ ] Run gateway behind reverse proxy (nginx, Caddy)
- [ ] Enable Cloudflare Access with MFA requirement
- [ ] Restrict gateway network access (firewall)
- [ ] Monitor audit logs
- [ ] Set up log aggregation
- [ ] Regular security updates (npm audit)

### Network
- [ ] Wrapper connects outbound only (no inbound ports)
- [ ] Gateway exposed only through Cloudflare Tunnel
- [ ] No direct exposure to internet if possible

---

## Incident Response

### Compromised Wrapper Token
1. Immediately invalidate the run in the database
2. Rotate HMAC_SECRET
3. Kill any running processes
4. Review audit logs for unauthorized commands

### Compromised User Account
1. Delete/disable the user account
2. Rotate AUTH_SECRET to invalidate all sessions
3. Review audit logs
4. Reset TOTP if applicable

### Suspected Data Breach
1. Disable gateway access
2. Export and review audit logs
3. Check for unauthorized data access
4. Notify affected parties as required
