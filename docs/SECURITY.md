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
2. **Authenticated users** - May attempt privilege escalation
3. **Compromised wrappers** - Wrappers with valid auth tokens but malicious intent
4. **External API callers** - Attempting to access gateway endpoints without proper authorization

### Security Assumptions
1. TLS is terminated at the edge (Cloudflare Workers)
2. Database access is secured and not directly exposed
3. Wrapper hosts run in trusted environments
4. Admin credentials are stored securely (hashed passwords, encrypted TOTP secrets)

## Authentication Mechanisms

The gateway implements two primary authentication middleware functions in `gateway/src/middleware/auth.ts`:

### 1. Wrapper Authentication (`wrapperAuth`)

Used for agent-to-gateway communication with HMAC signature verification and replay protection.

**Required Headers:**
- `X-Signature`: HMAC signature of the request
- `X-Timestamp`: Unix timestamp for replay prevention
- `X-Nonce`: Unique value for replay protection
- `X-Run-ID` (optional): Run identifier for capability-based authorization
- `X-Capability-Token` (optional): Token authorizing access to a specific run

**Validation Steps:**
1. Verifies all required authentication headers are present
2. Checks timestamp validity (within configured tolerance for clock skew)
3. Validates nonce against database to prevent replay attacks
4. Calculates SHA-256 hash of request body
5. Verifies HMAC signature using shared secrets
6. If run ID and capability token provided, validates against stored run data
7. Stores nonce in database to prevent future reuse

**Signature Computation:**
The signature is verified using cryptographic utilities that hash the request body and validate the HMAC signature against expected values including:
- HTTP method
- Request path
- Body hash (SHA-256)
- Timestamp
- Nonce
- Run ID (if provided)
- Capability token (if provided)

**User Context:**
Authenticated wrapper requests receive user context:
```typescript
{
  id: 'wrapper',
  username: 'wrapper',
  role: 'operator',
  source: 'wrapper'
}
```

### 2. UI Authentication (`uiAuth`)

Supports both Cloudflare Access and local session-based authentication for web UI access.

**Cloudflare Access Flow:**
1. Checks for `CF-Access-Authenticated-User-Email` header
2. Checks for `CF-Access-Jwt-Assertion` header
3. If Cloudflare Access team is configured and headers present, trusts the authentication
4. User receives role 'operator' (configurable per-user in production)

**Session-based Flow:**
1. Checks for session cookie or `Authorization: Bearer <token>` header
2. Queries database for valid session:
   ```sql
   SELECT s.*, u.username, u.role
   FROM sessions s
   JOIN users u ON s.user_id = u.id
   WHERE s.id = ? AND s.expires_at > unixepoch()
   ```
3. Validates session hasn't expired
4. Retrieves user information from joined users table
5. Attaches user context to request

**User Context:**
```typescript
{
  id: string,           // User ID from database or cf:email format
  username: string,     // Username or email
  role: 'admin' | 'operator' | 'viewer',
  source: 'cloudflare' | 'session'
}
```

### Authenticated Request Interface

All authenticated requests extend the FastifyRequest interface:

```typescript
interface AuthenticatedRequest extends FastifyRequest {
  user?: {
    id: string;
    username: string;
    role: 'admin' | 'operator' | 'viewer';
    source: 'cloudflare' | 'session' | 'wrapper';
  };
  runAuth?: {
    runId: string;
    capabilityToken: string;
  };
}
```

### Role-Based Authorization

The `requireRole()` function provides role-based access control:

```typescript
requireRole('admin', 'operator')  // Allows admin or operator
requireRole('admin')              // Admin only
```

- Returns a middleware function that checks `request.user.role`
- Returns 401 if user not authenticated
- Returns 403 if user role not in allowed roles

### Audit Logging

The `logAudit()` function records security-relevant events:

```typescript
logAudit(
  userId,           // User ID or undefined
  action,           // Action performed
  targetType,       // Type of resource affected
  targetId,         // ID of resource affected
  details,          // Additional context object
  ipAddress         // Request IP address
)
```

Events are stored in the `audit_log` table for security monitoring and compliance.

### Raw Body Plugin

The `rawBodyPlugin` captures request bodies for signature verification:

- Registers a content type parser for `application/json`
- Stores raw body string on request object for HMAC computation
- Parses JSON normally for route handlers
- Required for wrapper authentication signature verification

## Authentication Middleware Implementation

### Middleware Components

The authentication middleware (`gateway/src/middleware/auth.ts`) provides:

1. **Cloudflare Access Authentication**
   - Validates CF Access JWT tokens
   - Extracts user identity from token claims
   - Maps to internal user roles

2. **Session Authentication**
   - Validates session cookies
   - Checks session expiration
   - Retrieves user from database

3. **Wrapper Authentication**
   - Verifies HMAC signatures on request bodies
   - Validates timestamps to prevent replay attacks
   - Authorizes specific run access

4. **Role-based Authorization**
   - Enforces role-based access control
   - Maps roles to endpoint permissions

### Request Flow

```
Incoming Request
    ↓
[Auth Middleware]
    ↓
┌─────────────────┬─────────────────┬─────────────────┐
│ Cloudflare Auth │ Session Auth    │ Wrapper Auth    │
└────────┬────────┴────────┬────────┴────────┬────────┘
         ↓                 ↓                 ↓
   Verify JWT        Verify Cookie     Verify HMAC
   Extract User      Check Session     Check Timestamp
   Map Role          Get User Data     Authorize Run
         ↓                 ↓                 ↓
         └─────────────────┴─────────────────┘
                     ↓
            [Attach user to request]
                     ↓
              [Role-based checks]
                     ↓
              Route Handler
```

### Security Features

#### Signature Verification
- Requests from wrappers must include HMAC signatures
- Signatures computed over request body using shared secrets
- Prevents request tampering and spoofing

#### Timestamp Validation
- All wrapper requests include timestamps
- Rejects requests outside configurable time window
- Prevents replay attacks

#### Role-based Access Control (RBAC)
- **Admin**: Full access to all resources and settings
- **Operator**: Can create and manage runs, view results
- **Viewer**: Read-only access to runs and results

#### Rate Limiting
- Per-IP rate limits on authentication endpoints
- Prevents brute force attacks
- Configurable limits per route

## Authorization Model

### User Roles

#### Admin
- Create and manage users
- Configure system settings
- View all runs and operations
- Access admin endpoints
- Manage authentication secrets

#### Operator
- Create and manage runs
- View run results and logs
- Execute commands within authorized runs
- Manage wrapper connections

#### Viewer
- View run results and logs
- Monitor system status
- No write access to resources

### Run Authorization

Run-level authorization provides scoped access for wrapper communication:

```typescript
interface RunAuthorization {
  runId: string;           // Specific run identifier
  capabilities: string[];  // Allowed actions:
                           // - 'read': Read run state
                           // - 'update': Update run status
                           // - 'command': Execute commands
                           // - 'output': Send code output
}
```

### Endpoint Permissions

| Endpoint | Admin | Operator | Viewer | Wrapper |
|----------|-------|----------|--------|---------|
| GET /api/runs | ✓ | ✓ | ✓ | ✗ |
| POST /api/runs | ✓ | ✓ | ✗ | ✗ |
| GET /api/runs/:id | ✓ | ✓ | ✓ | ✓ (if authorized) |
| PUT /api/runs/:id | ✓ | ✓ | ✗ | ✓ (if authorized) |
| DELETE /api/runs/:id | ✓ | ✗ | ✗ | ✗ |
| POST /api/runs/:id/command | ✓ | ✓ | ✗ | ✓ (if authorized) |
| POST /api/runs/:id/output | ✗ | ✗ | ✗ | ✓ (if authorized) |
| GET /api/users | ✓ | ✗ | ✗ | ✗ |
| POST /api/users | ✓ | ✗ | ✗ | ✗ |
| GET /api/settings | ✓ | ✗ | ✗ | ✗ |
| PUT /api/settings | ✓ | ✗ | ✗ | ✗ |

## Cryptographic Implementation

### Hash Functions
- **Body Hashing**: SHA-256 for request body integrity
- **Password Hashing**: bcrypt with configurable cost factor
- **Signature Generation**: HMAC-SHA256 for wrapper authentication

### Key Management
- **Wrapper Secrets**: Stored encrypted in database
- **Session Secrets**: Environment-specific, rotated regularly
- **TOTP Secrets**: Encrypted at rest, used for 2FA

### Secure Headers
All responses include security headers via Fastify Helmet:
- `Content-Security-Policy`
- `X-Frame-Options`
- `X-Content-Type-Options`
- `Referrer-Policy`
- `Permissions-Policy`

## Configuration

### Environment Variables

```bash
# Authentication
AUTH_CF_AUDIENCE=your-audience
AUTH_CF_ISSUER=https://your.cloudflare-access.com
AUTH_CF_TEAM_DOMAIN=your-team.cloudflareaccess.com

# Session Management
SESSION_SECRET=your-secret-key-min-32-chars
SESSION_MAX_AGE=86400  # 24 hours

# Wrapper Authentication
WRAPPER_SECRET_ENCRYPTION_KEY=your-encryption-key
AUTH_TIMESTAMP_TOLERANCE=300  # 5 minutes

# Rate Limiting
RATE_LIMIT_MAX=100
RATE_LIMIT_TIME_WINDOW=60  # seconds
```

### Security Best Practices

1. **Secret Management**
   - Use environment variables for all secrets
   - Rotate secrets regularly
   - Never commit secrets to version control
   - Use secret management services in production

2. **TLS Configuration**
   - Always use HTTPS in production
   - Configure TLS 1.2+ only
   - Use strong cipher suites
   - Enable HSTS

3. **Session Security**
   - Use `HttpOnly` and `Secure` flags on cookies
   - Implement proper session expiration
   - Invalidate sessions on password changes
   - Use short session timeouts for high-risk operations

4. **Wrapper Authentication**
   - Use unique secrets per wrapper
   - Rotate wrapper secrets periodically
   - Monitor for failed authentication attempts
   - Implement IP allowlisting if possible

5. **Monitoring and Logging**
   - Log all authentication attempts
   - Alert on repeated failures
   - Monitor for suspicious patterns
   - Implement audit logging for sensitive operations

## Deployment Considerations

### Production Checklist

- [ ] All secrets stored in secure vault
- [ ] TLS/HTTPS enabled
- [ ] Security headers configured
- [ ] Rate limiting enabled
- [ ] Input validation on all endpoints
- [ ] Database connections encrypted
- [ ] CORS properly configured
- [ ] Session cookies use Secure flag
- [ ] Logging enabled for security events
- [ ] Monitoring and alerting configured

### Cloudflare Access Integration

1. Create Cloudflare Access application
2. Configure allowed email domains or identities
3. Set up JWT audience and issuer
4. Configure CORS for your domain
5. Test authentication flow end-to-end

### Database Security

- Use connection pooling with TLS
- Implement least-privilege database user
- Encrypt sensitive fields at rest
- Regular database backups
- Enable database audit logging

## Incident Response

### Security Event Categories

1. **Failed Authentication Attempts**
   - Threshold: 10 failures per IP per hour
   - Response: Temporary IP block, alert admin

2. **Suspicious Request Patterns**
   - Unusual timing or request rates
   - Invalid signature attempts
   - Response: Investigate, potential blocking

3. **Unauthorized Access Attempts**
   - Access to restricted endpoints
   - Privilege escalation attempts
   - Response: Immediate alert, session invalidation

### Response Procedures

1. **Immediate Actions**
   - Block malicious IPs
   - Invalidate compromised sessions
   - Rotate exposed secrets
   - Enable enhanced logging

2. **Investigation**
   - Review access logs
   - Identify affected accounts
   - Determine attack vector
   - Assess data exposure

3. **Recovery**
   - Patch vulnerabilities
   - Update authentication mechanisms
   - Notify affected users
   - Document lessons learned

## Compliance

### Data Protection
- Encrypt sensitive data at rest
- Encrypt data in transit
- Implement data retention policies
- Provide data export/deletion capabilities

### Audit Trail
- Log all authentication events
- Track user actions
- Maintain immutable logs
- Regular audit reviews

### Access Control
- Principle of least privilege
- Regular access reviews
- Prompt access revocation
- Role separation where possible

## Testing Security

### Authentication Testing
```bash
# Test Cloudflare authentication
curl -H "Cf-Access-Jwt-Assertion: <token>" https://gateway.example.com/api/runs

# Test session authentication
curl -H "Cookie: session=<token>" https://gateway.example.com/api/runs

# Test wrapper authentication
curl -H "X-Wrapper-Signature: <hmac>" \
     -H "X-Wrapper-Timestamp: <ts>" \
     -d '{"runId":"..."}' \
     https://gateway.example.com/api/runs/:id/output
```

### Security Testing Checklist
- [ ] SQL injection testing
- [ ] XSS testing
- [ ] CSRF testing
- [ ] Authentication bypass testing
- [ ] Authorization testing
- [ ] Rate limit testing
- [ ] Input validation testing
- [ ] Error handling testing

## Additional Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Cloudflare Access Documentation](https://developers.cloudflare.com/cloudflare-one/)
- [Fastify Security Best Practices](https://www.fastify.io/docs/latest/Guides/Security-Guidelines/)
- [Node.js Security Checklist](https://github.com/lirantal/nodejs-security-checklist)