#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         Claude Code Connect-Back Gateway                      ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo

# Check Node.js version
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed${NC}"
    echo "Please install Node.js 20+ from https://nodejs.org"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo -e "${RED}Error: Node.js 20+ required (found v${NODE_VERSION})${NC}"
    exit 1
fi

# Check for .env file
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}Creating .env file with secure defaults...${NC}"
    cat > .env << 'EOF'
# Gateway Configuration
GATEWAY_PORT=3100
GATEWAY_HOST=0.0.0.0

# Security (auto-generated if not set)
HMAC_SECRET=
AUTH_SECRET=

# TLS (generate with: ./scripts/dev-cert.sh)
TLS_ENABLED=true

# Cloudflare Access (optional)
# CF_ACCESS_TEAM=your-team
# CF_ACCESS_AUD=your-aud

# Retention
RUN_RETENTION_DAYS=30

# Wrapper Configuration
GATEWAY_URL=https://localhost:3100
ALLOW_SELF_SIGNED=true
EOF

    # Generate secrets
    HMAC_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p | tr -d '\n')
    AUTH_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p | tr -d '\n')

    sed -i.bak "s/^HMAC_SECRET=$/HMAC_SECRET=${HMAC_SECRET}/" .env
    sed -i.bak "s/^AUTH_SECRET=$/AUTH_SECRET=${AUTH_SECRET}/" .env
    rm -f .env.bak

    echo -e "${GREEN}Generated .env with secure secrets${NC}"
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo -e "${BLUE}Installing dependencies...${NC}"
    npm install
fi

# Build if needed
if [ ! -d "gateway/dist" ] || [ ! -d "ui/dist" ]; then
    echo -e "${BLUE}Building...${NC}"
    npm run build
fi

# Generate dev certs if needed
if [ ! -f ".data/certs/server.crt" ]; then
    echo -e "${YELLOW}Generating development TLS certificates...${NC}"
    ./scripts/dev-cert.sh
fi

# Create data directories
mkdir -p .data/{db,artifacts,runs,certs}

echo
echo -e "${GREEN}Starting gateway server...${NC}"
echo -e "Gateway: ${BLUE}https://localhost:3100${NC}"
echo -e "WebSocket: ${BLUE}wss://localhost:3100/ws${NC}"
echo
echo -e "${YELLOW}To expose via Cloudflare Tunnel:${NC}"
echo -e "  ./scripts/cloudflare-tunnel.sh"
echo
echo -e "${YELLOW}To start a Claude Code run:${NC}"
echo -e "  1. Create a run from the UI (get run-id and token)"
echo -e "  2. Run: ./wrapper/claude-runner start --run-id <id> --token <token>"
echo

# Start gateway
exec npm run start -w gateway
