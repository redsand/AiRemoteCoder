# Quickstart Guide

## Prerequisites

- Node.js 20+
- Claude Code CLI installed and authenticated
- (Optional) Cloudflare account for secure remote access

## Local Development Setup

### 1. Start the Gateway

```bash
# Linux/macOS
./run.sh

# Windows
.\run.ps1
```

This will:
- Generate secure secrets in `.env` (first run)
- Install dependencies
- Build the gateway, wrapper, and UI
- Generate self-signed TLS certificates
- Start the gateway on https://localhost:3100

### 2. Access the UI

Open https://localhost:3100 in your browser.

On first access, you'll be prompted to create an admin account:
1. Choose a username (alphanumeric, 3+ chars)
2. Set a strong password (12+ chars)
3. Optionally enable TOTP two-factor auth

### 3. Create a Run

1. Click "New Run" in the UI
2. Optionally enter a Claude command/prompt
3. Copy the displayed run-id and token

### 4. Start Claude Code

In a terminal on the machine with Claude Code:

```bash
cd /path/to/your/project

# Run the wrapper
./wrapper/claude-runner start \
  --run-id <run-id> \
  --token <token> \
  --cmd "your prompt here"
```

Or to run interactively:
```bash
./wrapper/claude-runner start \
  --run-id <run-id> \
  --token <token>
```

### 5. Monitor from UI

- View real-time output in the log viewer
- Run allowlisted commands (npm test, git diff, etc.)
- Download artifacts (logs, diffs)
- Request graceful stop

---

## Remote Access with Cloudflare Tunnel

For secure access from your phone:

### 1. Install cloudflared

```bash
# macOS
brew install cloudflared

# Linux (Debian/Ubuntu)
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
```

### 2. Start the Tunnel

```bash
./scripts/cloudflare-tunnel.sh
```

First time: Follow the browser prompt to authenticate with Cloudflare.

### 3. Add Cloudflare Access (Recommended)

1. Go to https://one.dash.cloudflare.com
2. Navigate to **Access > Applications**
3. Create a new application:
   - Type: Self-hosted
   - URL: Your tunnel hostname
   - Configure identity provider (Google, GitHub, etc.)
   - Set access policies (who can access)

### 4. Update Gateway Config

Add to `.env`:
```env
CF_ACCESS_TEAM=your-team-name
CF_ACCESS_AUD=your-application-aud
```

The gateway will now validate Cloudflare Access headers.

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GATEWAY_PORT` | Gateway HTTP port | 3100 |
| `GATEWAY_HOST` | Gateway bind address | 0.0.0.0 |
| `HMAC_SECRET` | HMAC signing key (32+ chars) | Auto-generated |
| `AUTH_SECRET` | Session signing key | Auto-generated |
| `TLS_ENABLED` | Enable HTTPS | true |
| `CF_ACCESS_TEAM` | Cloudflare Access team | (none) |
| `CF_ACCESS_AUD` | Cloudflare Access AUD | (none) |
| `RUN_RETENTION_DAYS` | Keep runs for N days | 30 |
| `GATEWAY_URL` | Gateway URL for wrapper | https://localhost:3100 |
| `ALLOW_SELF_SIGNED` | Allow self-signed certs | true |

---

## Assist Sessions (tmate)

For hands-on terminal access:

1. Install tmate:
   ```bash
   # macOS
   brew install tmate

   # Linux
   apt install tmate
   ```

2. From the wrapper:
   ```bash
   ./wrapper/claude-runner assist \
     --run-id <run-id> \
     --token <token>
   ```

3. The session URL will appear in the UI under "Assist Session Active"

---

## Troubleshooting

### "Cannot connect to gateway"
- Check the gateway is running
- Verify GATEWAY_URL in environment
- For self-signed certs, set ALLOW_SELF_SIGNED=true

### "Invalid signature"
- Ensure HMAC_SECRET matches between gateway and wrapper
- Check system clocks are synchronized (within 5 minutes)

### "Authentication required"
- Create an account at /api/auth/setup
- Or configure Cloudflare Access

### TLS certificate errors
- Regenerate certs: `./scripts/dev-cert.sh`
- For production, use Let's Encrypt or a trusted CA
