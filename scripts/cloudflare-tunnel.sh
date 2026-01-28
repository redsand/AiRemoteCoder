#!/usr/bin/env bash
set -euo pipefail

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         Cloudflare Tunnel Setup                               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo

# Check for cloudflared
if ! command -v cloudflared &> /dev/null; then
    echo "cloudflared is not installed."
    echo
    echo "Install instructions:"
    echo "  macOS:   brew install cloudflared"
    echo "  Linux:   See https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation"
    echo "  Windows: winget install Cloudflare.cloudflared"
    echo
    exit 1
fi

# Check if authenticated
if ! cloudflared tunnel list &> /dev/null 2>&1; then
    echo "Not authenticated with Cloudflare. Running login..."
    cloudflared tunnel login
fi

TUNNEL_NAME="airemotecoder-$(hostname)"
LOCAL_URL="https://localhost:3100"

echo "Checking for existing tunnel..."

# Check if tunnel exists
TUNNEL_ID=$(cloudflared tunnel list --output json 2>/dev/null | grep -o "\"id\":\"[^\"]*\"" | head -1 | cut -d'"' -f4 || true)

if [ -z "$TUNNEL_ID" ]; then
    echo "Creating new tunnel: $TUNNEL_NAME"
    cloudflared tunnel create "$TUNNEL_NAME"
    TUNNEL_ID=$(cloudflared tunnel list --output json | grep -o "\"id\":\"[^\"]*\"" | head -1 | cut -d'"' -f4)
fi

echo "Tunnel ID: $TUNNEL_ID"
echo

# Get tunnel URL
echo "Starting tunnel..."
echo "Your gateway will be available at the URL shown below."
echo
echo "To add Cloudflare Access protection:"
echo "  1. Go to https://one.dash.cloudflare.com"
echo "  2. Navigate to Access > Applications"
echo "  3. Create an application for your tunnel hostname"
echo "  4. Set up your identity provider and access policies"
echo

# Run the tunnel
cloudflared tunnel --url "$LOCAL_URL" run "$TUNNEL_NAME"
