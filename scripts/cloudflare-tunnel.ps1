#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Blue
Write-Host "║         Cloudflare Tunnel Setup                               ║" -ForegroundColor Blue
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Blue
Write-Host

# Check for cloudflared
$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflared) {
    Write-Host "cloudflared is not installed." -ForegroundColor Red
    Write-Host
    Write-Host "Install with:"
    Write-Host "  winget install Cloudflare.cloudflared"
    Write-Host
    Write-Host "Or download from:"
    Write-Host "  https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation"
    exit 1
}

# Check if authenticated
try {
    cloudflared tunnel list 2>&1 | Out-Null
} catch {
    Write-Host "Not authenticated with Cloudflare. Running login..." -ForegroundColor Yellow
    cloudflared tunnel login
}

$TunnelName = "airemotecoder-$env:COMPUTERNAME"
$LocalUrl = "https://localhost:3100"

Write-Host "Checking for existing tunnel..."

# Get tunnel list
$tunnels = cloudflared tunnel list --output json 2>$null | ConvertFrom-Json
$existingTunnel = $tunnels | Where-Object { $_.name -eq $TunnelName } | Select-Object -First 1

if (-not $existingTunnel) {
    Write-Host "Creating new tunnel: $TunnelName" -ForegroundColor Green
    cloudflared tunnel create $TunnelName
}

Write-Host
Write-Host "Starting tunnel..." -ForegroundColor Green
Write-Host "Your gateway will be available at the URL shown below."
Write-Host
Write-Host "To add Cloudflare Access protection:" -ForegroundColor Yellow
Write-Host "  1. Go to https://one.dash.cloudflare.com"
Write-Host "  2. Navigate to Access > Applications"
Write-Host "  3. Create an application for your tunnel hostname"
Write-Host "  4. Set up your identity provider and access policies"
Write-Host

# Run the tunnel
cloudflared tunnel --url $LocalUrl run $TunnelName
