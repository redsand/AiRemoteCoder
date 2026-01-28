#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Blue
Write-Host "║         Claude Code Connect-Back Gateway                      ║" -ForegroundColor Blue
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Blue
Write-Host

# Check Node.js
try {
    $nodeVersion = (node -v) -replace 'v', ''
    $majorVersion = [int]($nodeVersion.Split('.')[0])
    if ($majorVersion -lt 20) {
        Write-Host "Error: Node.js 20+ required (found v$nodeVersion)" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "Error: Node.js is not installed" -ForegroundColor Red
    Write-Host "Please install Node.js 20+ from https://nodejs.org"
    exit 1
}

# Create .env if needed
if (-not (Test-Path ".env")) {
    Write-Host "Creating .env file with secure defaults..." -ForegroundColor Yellow

    $hmacSecret = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
    $authSecret = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })

    $envContent = @"
# Gateway Configuration
GATEWAY_PORT=3100
GATEWAY_HOST=0.0.0.0

# Security
HMAC_SECRET=$hmacSecret
AUTH_SECRET=$authSecret

# TLS (generate with: .\scripts\dev-cert.ps1)
TLS_ENABLED=true

# Cloudflare Access (optional)
# CF_ACCESS_TEAM=your-team
# CF_ACCESS_AUD=your-aud

# Retention
RUN_RETENTION_DAYS=30

# Wrapper Configuration
GATEWAY_URL=https://localhost:3100
ALLOW_SELF_SIGNED=true
"@
    $envContent | Out-File -FilePath ".env" -Encoding utf8

    Write-Host "Generated .env with secure secrets" -ForegroundColor Green
}

# Install dependencies
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Blue
    npm install
}

# Build if needed
if (-not (Test-Path "gateway\dist") -or -not (Test-Path "ui\dist")) {
    Write-Host "Building..." -ForegroundColor Blue
    npm run build
}

# Generate dev certs if needed
if (-not (Test-Path ".data\certs\server.crt")) {
    Write-Host "Generating development TLS certificates..." -ForegroundColor Yellow
    & .\scripts\dev-cert.ps1
}

# Create data directories
New-Item -ItemType Directory -Force -Path ".data\db", ".data\artifacts", ".data\runs", ".data\certs" | Out-Null

Write-Host
Write-Host "Starting gateway server..." -ForegroundColor Green
Write-Host "Gateway: " -NoNewline
Write-Host "https://localhost:3100" -ForegroundColor Blue
Write-Host "WebSocket: " -NoNewline
Write-Host "wss://localhost:3100/ws" -ForegroundColor Blue
Write-Host

Write-Host "To expose via Cloudflare Tunnel:" -ForegroundColor Yellow
Write-Host "  .\scripts\cloudflare-tunnel.ps1"
Write-Host

Write-Host "To start a Claude Code run:" -ForegroundColor Yellow
Write-Host "  1. Create a run from the UI (get run-id and token)"
Write-Host "  2. Run: .\wrapper\claude-runner start --run-id <id> --token <token>"
Write-Host

# Start gateway
npm run start -w gateway
