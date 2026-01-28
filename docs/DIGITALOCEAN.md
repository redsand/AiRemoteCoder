# DigitalOcean Deployment Guide

Deploy the Connect-Back Gateway on DigitalOcean for remote monitoring of Claude Code sessions. This guide covers Debian/Ubuntu and Oracle Linux droplets with Cloudflare Tunnel for secure remote access (no domain required).

## Architecture Overview

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  Phone/Browser  │◄────►│ Cloudflare Tunnel │◄────►│   DO Droplet    │
│     (You)       │ HTTPS│   (No domain)     │ WSS  │   (Gateway)     │
└─────────────────┘      └──────────────────┘      └────────┬────────┘
                                                            │
                                                   Connect-back (outbound)
                                                            │
                                                   ┌────────▼────────┐
                                                   │  Your Machine   │
                                                   │  Claude Wrapper │
                                                   └─────────────────┘
```

**Key Points:**
- Gateway runs on DigitalOcean droplet
- Cloudflare Tunnel provides secure HTTPS access (no domain needed)
- Your local machine connects **outbound** to the gateway (connect-back)
- No inbound ports needed on your development machine

---

## Droplet Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| RAM | 1 GB | 2 GB |
| vCPUs | 1 | 2 |
| Storage | 25 GB | 50 GB |
| Cost | ~$6/month | ~$12/month |

---

## Step 1: Create Droplet

### Option A: Debian/Ubuntu (Recommended)

1. Log in to [DigitalOcean](https://cloud.digitalocean.com)
2. Click **Create > Droplets**
3. Choose:
   - **Region**: Closest to you
   - **Image**: Ubuntu 24.04 LTS or Debian 12
   - **Size**: Basic $6/month (1 GB RAM, 1 vCPU)
   - **Authentication**: SSH key (recommended) or password
4. Click **Create Droplet**

### Option B: Oracle Linux

1. Same process but select **Oracle Linux 9** from Marketplace
2. Oracle Linux uses `dnf` instead of `apt`

---

## Step 2: Initial Server Setup

SSH into your droplet:

```bash
ssh root@YOUR_DROPLET_IP
```

### Debian/Ubuntu

```bash
# Update system
apt update && apt upgrade -y

# Install dependencies
apt install -y curl git build-essential sqlite3

# Install Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Verify
node --version  # Should be 20+
npm --version
```

### Oracle Linux

```bash
# Update system
dnf update -y

# Enable EPEL and install dependencies
dnf install -y epel-release
dnf install -y curl git gcc gcc-c++ make sqlite

# Install Node.js 20+
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs

# Verify
node --version  # Should be 20+
npm --version
```

---

## Step 3: Create Service User

```bash
# Create non-root user for the gateway
useradd -m -s /bin/bash aigateway
```

---

## Step 4: Install the Gateway

```bash
# Switch to service user
su - aigateway

# Clone the repository
git clone https://github.com/redsand/AiRemoteCoder.git
cd AiRemoteCoder

# Run setup (generates secrets, builds all components)
./run.sh
```

The first run will:
- Generate secure `HMAC_SECRET` and `AUTH_SECRET`
- Install dependencies
- Build gateway, wrapper, and UI
- Generate self-signed TLS certificates
- Start the gateway

Press `Ctrl+C` to stop the gateway after verifying it starts.

---

## Step 5: Install Cloudflare Tunnel

Cloudflare Tunnel provides secure remote access without exposing ports or buying a domain.

### Debian/Ubuntu

```bash
# As root
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i cloudflared.deb
```

### Oracle Linux

```bash
# As root
curl -L --output cloudflared.rpm https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-x86_64.rpm
rpm -i cloudflared.rpm
```

---

## Step 6: Configure Cloudflare Tunnel

### Option A: Quick Tunnel (No Account Required)

For testing, use a temporary tunnel:

```bash
# As aigateway user
su - aigateway
cd AiRemoteCoder

# Start quick tunnel (gives you a random *.trycloudflare.com URL)
cloudflared tunnel --url https://localhost:3100
```

Copy the generated URL (e.g., `https://random-name.trycloudflare.com`).

**Note:** Quick tunnels are temporary and change on restart. Use Option B for persistence.

### Option B: Named Tunnel (Recommended for Production)

1. Create a free Cloudflare account at https://dash.cloudflare.com
2. Authenticate cloudflared:

```bash
cloudflared tunnel login
```

3. Create a named tunnel:

```bash
# Create tunnel (save the tunnel ID)
cloudflared tunnel create aigateway

# Note the tunnel ID and credentials file path shown
```

4. Create tunnel config:

```bash
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: YOUR_TUNNEL_ID
credentials-file: /home/aigateway/.cloudflared/YOUR_TUNNEL_ID.json

ingress:
  - service: https://localhost:3100
    originRequest:
      noTLSVerify: true
EOF
```

5. Get your tunnel hostname:

```bash
# Your tunnel will be accessible at:
# https://YOUR_TUNNEL_ID.cfargotunnel.com
# Or route a domain to it (optional)
```

---

## Step 7: Add Cloudflare Access (Optional but Recommended)

Add authentication in front of your tunnel:

1. Go to https://one.dash.cloudflare.com
2. Navigate to **Access > Applications**
3. Click **Add an Application > Self-hosted**
4. Configure:
   - **Application name**: AI Gateway
   - **Session duration**: 24 hours
   - **Application domain**: `YOUR_TUNNEL_ID.cfargotunnel.com`
5. Add an Access Policy:
   - **Policy name**: Allow Me
   - **Action**: Allow
   - **Include**: Emails ending in `@yourdomain.com` or specific emails
6. Save and note the **Application Audience (AUD)** tag

Update your `.env`:

```bash
# Edit as aigateway user
nano /home/aigateway/AiRemoteCoder/.env

# Add:
CF_ACCESS_TEAM=your-team-name
CF_ACCESS_AUD=your-application-aud
```

---

## Step 8: Create Systemd Service

Run as root to create a persistent service:

```bash
cat > /etc/systemd/system/aigateway.service << 'EOF'
[Unit]
Description=AI Remote Coder Gateway
After=network.target

[Service]
Type=simple
User=aigateway
WorkingDirectory=/home/aigateway/AiRemoteCoder
ExecStart=/usr/bin/npm run start -w gateway
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable aigateway
systemctl start aigateway
systemctl status aigateway
```

---

## Step 9: Create Cloudflare Tunnel Service

```bash
cat > /etc/systemd/system/cloudflared.service << 'EOF'
[Unit]
Description=Cloudflare Tunnel
After=network.target aigateway.service

[Service]
Type=simple
User=aigateway
ExecStart=/usr/bin/cloudflared tunnel run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable cloudflared
systemctl start cloudflared
systemctl status cloudflared
```

---

## Step 10: Configure Firewall

### Debian/Ubuntu (UFW)

```bash
# Only allow SSH (Cloudflare handles HTTPS)
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw enable
```

### Oracle Linux (firewalld)

```bash
# Only allow SSH
firewall-cmd --permanent --remove-service=http
firewall-cmd --permanent --remove-service=https
firewall-cmd --permanent --add-service=ssh
firewall-cmd --reload
```

**Note:** No need to open port 3100 - Cloudflare Tunnel handles all inbound traffic.

---

## Step 11: Connect from Your Local Machine

1. Access the gateway UI through Cloudflare:
   ```
   https://YOUR_TUNNEL_ID.cfargotunnel.com
   ```

2. Create an admin account on first visit

3. Create a new run and copy the `run-id` and `token`

4. On your local development machine, set up the wrapper:

```bash
# Clone or copy the wrapper
git clone https://github.com/redsand/AiRemoteCoder.git
cd AiRemoteCoder

# Install and build wrapper only
npm install -w wrapper
npm run build -w wrapper

# Configure environment
cat > .env << EOF
GATEWAY_URL=https://YOUR_TUNNEL_ID.cfargotunnel.com
HMAC_SECRET=copy-from-droplet-.env
ALLOW_SELF_SIGNED=false
EOF

# Start Claude Code with connect-back
./wrapper/claude-runner start \
  --run-id <run-id-from-ui> \
  --token <token-from-ui> \
  --cmd "your prompt here"
```

**Important:** Copy the `HMAC_SECRET` from your droplet's `.env` file to your local machine.

---

## Maintenance

### View Logs

```bash
# Gateway logs
journalctl -u aigateway -f

# Tunnel logs
journalctl -u cloudflared -f
```

### Update Gateway

```bash
su - aigateway
cd AiRemoteCoder
git pull
npm install
npm run build
exit
systemctl restart aigateway
```

### Backup

```bash
# Backup data and config
su - aigateway
cd AiRemoteCoder
tar -czf backup-$(date +%Y%m%d).tar.gz .env .data/
```

### Prune Old Runs

```bash
su - aigateway
cd AiRemoteCoder
npm run prune
```

---

## Troubleshooting

### Gateway won't start

```bash
# Check status
systemctl status aigateway

# View full logs
journalctl -u aigateway -n 100

# Test manually
su - aigateway
cd AiRemoteCoder
LOG_LEVEL=debug npm run start -w gateway
```

### Tunnel connection issues

```bash
# Check tunnel status
cloudflared tunnel info aigateway

# Test tunnel manually
cloudflared tunnel --url https://localhost:3100

# Verify credentials
ls -la ~/.cloudflared/
```

### Wrapper can't connect

```bash
# Test from local machine
curl -k https://YOUR_TUNNEL_ID.cfargotunnel.com/api/health

# Verify HMAC_SECRET matches
# On droplet:
grep HMAC_SECRET /home/aigateway/AiRemoteCoder/.env

# On local machine:
grep HMAC_SECRET .env
```

### "Invalid signature" errors

- Ensure `HMAC_SECRET` is identical on gateway and wrapper
- Check system clock synchronization (within 5 minutes)
- Run `timedatectl status` on both machines

---

## Security Checklist

- [ ] Using named Cloudflare Tunnel (not quick tunnel)
- [ ] Cloudflare Access enabled with email/IdP authentication
- [ ] Firewall blocks all inbound except SSH
- [ ] Gateway running as non-root user
- [ ] Strong `HMAC_SECRET` (32+ random bytes)
- [ ] Strong `AUTH_SECRET` (32+ random bytes)
- [ ] TLS enabled on gateway
- [ ] SSH key authentication (not password)
- [ ] Regular updates applied
- [ ] Backups configured

---

## Cost Summary

| Component | Monthly Cost |
|-----------|-------------|
| DigitalOcean Droplet (1GB) | $6 |
| Cloudflare Tunnel | Free |
| Cloudflare Access (50 users) | Free |
| **Total** | **$6/month** |

---

## Quick Reference

```bash
# Start/stop gateway
systemctl start aigateway
systemctl stop aigateway
systemctl restart aigateway

# Start/stop tunnel
systemctl start cloudflared
systemctl stop cloudflared

# View logs
journalctl -u aigateway -f
journalctl -u cloudflared -f

# Connect wrapper (from local machine)
./wrapper/claude-runner start --run-id <id> --token <token> --cmd "prompt"

# Test connection
./wrapper/claude-runner test-connection

# Health check
curl https://YOUR_TUNNEL.cfargotunnel.com/api/health
```
