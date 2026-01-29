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

## Authentication Architecture

### Authentication Sources

The gateway supports three authentication sources, each with different trust levels and use cases:

#### 1. Cloudflare Access (cloudflare)
- **Trust Level**: High
- **Use Case**: Admin/operator access via web UI
- **Mechanism**: JWT tokens signed by Cloudflare
- **Validation**: Token signature verification, audience/issuer checks
- **User Info**: Extracted from CF Access JWT (email, user identity)

#### 2. Session-based (session)
- **Trust Level**: Medium
- **Use Case**: Web UI sessions after initial login
- **Mechanism**: HTTP cookies with encrypted session tokens
- **Validation**: Session token verification against database
- **User Info**: Retrieved from active session record

#### 3. Wrapper Authentication (wrapper)
- **Trust Level**: Conditional (depends on run authorization)
- **Use Case**: Wrapper-to-gateway communication for run updates
- **Mechanism**: Shared secret + HMAC signatures
- **Validation**: Signature verification, timestamp validation
- **User Info**: Limited to run-specific authorization context

### Authenticated Request Interface

All authenticated requests extend the FastifyRequest interface with user information:

```typescript
interface AuthenticatedRequest extends FastifyRequest {
  user?: {
    id: string;           // Unique user identifier
    username: string;     // Display username/email
    role: 'admin' | 'operator' | 'viewer';  // User role
    source: 'cloudflare' | 'session' | 'wrapper';  // Auth source
  };
  runAuth?: {
    runId: string;        // Authorized run identifier
    capabilities: string[];  // Permitted actions
  };
}
```

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