# Operations Guide

## Directory Structure

```
.data/
├── db.sqlite          # SQLite database
├── certs/             # TLS certificates
│   ├── server.crt
│   └── server.key
├── artifacts/         # Uploaded artifacts per run
│   └── <run-id>/
│       └── <artifact-id>_<filename>
└── runs/              # Local run logs
    └── <run-id>/
        └── claude.log
```

All runtime data is stored under `.data/` in the project root.

---

## Database

### Location
`.data/db.sqlite`

### Schema
- `runs` - Run records (id, status, timestamps, exit code)
- `events` - Log events (stdout, stderr, markers)
- `commands` - Queued commands from UI
- `artifacts` - Uploaded file metadata
- `nonces` - Replay protection (auto-pruned)
- `users` - Local user accounts
- `sessions` - Active sessions (auto-pruned)
- `audit_log` - Operator actions

### Backup
```bash
# Stop gateway first for consistency
sqlite3 .data/db.sqlite ".backup .data/backup.sqlite"
```

### Restore
```bash
cp .data/backup.sqlite .data/db.sqlite
```

---

## Retention and Cleanup

### Automatic Pruning
Run periodically:
```bash
npm run prune
# or
node scripts/prune.mjs
```

This removes:
- Completed/failed runs older than `RUN_RETENTION_DAYS`
- Associated artifacts and events
- Orphaned directories
- Expired nonces and sessions

### Manual Cleanup
```bash
# Delete specific run
sqlite3 .data/db.sqlite "DELETE FROM runs WHERE id = 'xxx'"

# Clear all data (careful!)
rm -rf .data/db.sqlite .data/artifacts/* .data/runs/*
```

### Disk Usage Monitoring
```bash
du -sh .data/
du -sh .data/artifacts/
du -sh .data/runs/
```

---

## Secret Rotation

### HMAC_SECRET
Used for wrapper authentication. To rotate:

1. Generate new secret:
   ```bash
   openssl rand -hex 32
   ```

2. Update `.env` with new `HMAC_SECRET`

3. Restart gateway

4. Update all wrappers with new secret

5. All existing runs will fail authentication (expected)

### AUTH_SECRET
Used for session cookies. To rotate:

1. Update `.env` with new `AUTH_SECRET`

2. Restart gateway

3. All existing sessions invalidated (users must re-login)

### User Passwords
```bash
# Via UI (admin only)
# Or directly in database (emergency):
sqlite3 .data/db.sqlite "DELETE FROM users WHERE username = 'xxx'"
# Then re-run setup or create user via API
```

### TOTP Secret
If a user loses their authenticator:
```bash
sqlite3 .data/db.sqlite "UPDATE users SET totp_secret = NULL WHERE username = 'xxx'"
```
User must then set up TOTP again.

---

## TLS Certificate Management

### Development Certificates
```bash
./scripts/dev-cert.sh
```
Self-signed, valid for 365 days.

### Production (Let's Encrypt)
```bash
# Using certbot
certbot certonly --standalone -d your-domain.com

# Copy to project
cp /etc/letsencrypt/live/your-domain.com/fullchain.pem .data/certs/server.crt
cp /etc/letsencrypt/live/your-domain.com/privkey.pem .data/certs/server.key

# Set permissions
chmod 600 .data/certs/server.key
```

### Certificate Renewal
```bash
certbot renew
# Then copy new certs and restart gateway
```

---

## Monitoring

### Health Check
```bash
curl -k https://localhost:3100/api/health
```

Response:
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:00:00.000Z",
  "connections": {
    "clients": 2,
    "subscriptions": 1
  }
}
```

### Audit Log
```bash
# Recent actions
sqlite3 .data/db.sqlite "SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 50"

# Actions by user
sqlite3 .data/db.sqlite "SELECT * FROM audit_log WHERE user_id = 'xxx'"

# Failed logins
sqlite3 .data/db.sqlite "SELECT * FROM audit_log WHERE action LIKE 'login.failed%'"
```

### Active Runs
```bash
sqlite3 .data/db.sqlite "SELECT id, status, created_at FROM runs WHERE status = 'running'"
```

---

## Scaling Considerations

### Single Instance (Default)
- SQLite works well for single-node deployment
- WebSocket connections maintained in memory
- Suitable for personal/small team use

### Multi-Instance (Future)
If scaling beyond single node:
1. Replace SQLite with PostgreSQL
2. Use Redis for WebSocket pub/sub
3. Use shared storage (S3/NFS) for artifacts
4. Deploy gateway behind load balancer

---

## Troubleshooting

### Gateway won't start
```bash
# Check port in use
lsof -i :3100

# Check logs
LOG_LEVEL=debug npm run start -w gateway
```

### Wrapper can't connect
```bash
# Test connectivity
./wrapper/claude-runner test-connection

# Check gateway URL
./wrapper/claude-runner info
```

### Database locked
```bash
# Check for stale locks
fuser .data/db.sqlite

# Force close (careful with data loss)
kill -9 $(fuser .data/db.sqlite)
```

### Certificate errors
```bash
# Regenerate development certs
rm -f .data/certs/*
./scripts/dev-cert.sh

# Check certificate
openssl x509 -in .data/certs/server.crt -text -noout
```

---

## Upgrading

### Standard Upgrade
```bash
git pull
npm install
npm run build
# Restart gateway
```

### Database Migrations
Currently no migration system. For breaking changes:
1. Backup database
2. Delete `.data/db.sqlite`
3. Restart (new schema created automatically)
4. Historical data will be lost

---

## Disaster Recovery

### Full Backup
```bash
tar -czf backup-$(date +%Y%m%d).tar.gz \
  .env \
  .data/db.sqlite \
  .data/certs/ \
  .data/artifacts/
```

### Full Restore
```bash
tar -xzf backup-YYYYMMDD.tar.gz
npm install
npm run build
./run.sh
```
