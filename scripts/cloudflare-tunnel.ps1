#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

function Resolve-CloudflaredPath {
    $command = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $fallbackPaths = @(
        "C:\Program Files\cloudflared\cloudflared.exe",
        "C:\Program Files (x86)\cloudflared\cloudflared.exe",
        "$env:LOCALAPPDATA\Programs\cloudflared\cloudflared.exe"
    )

    foreach ($path in $fallbackPaths) {
        if (Test-Path $path) {
            return $path
        }
    }

    return $null
}

function Invoke-Cloudflared {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [switch]$AllowFailure,
        [switch]$Quiet
    )

    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()

    try {
        & $script:cloudflared @Arguments 1> $stdoutPath 2> $stderrPath
        $exitCode = $LASTEXITCODE
        $stdout = if (Test-Path $stdoutPath) { [System.IO.File]::ReadAllText($stdoutPath) } else { "" }
        $stderr = if (Test-Path $stderrPath) { [System.IO.File]::ReadAllText($stderrPath) } else { "" }
    } finally {
        Remove-Item $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }

    $stdout = $stdout.Trim()
    $stderr = $stderr.Trim()

    if (-not $AllowFailure -and -not $Quiet) {
        foreach ($line in @($stdout, $stderr)) {
            if ($line) {
                foreach ($text in ($line -split "`r?`n")) {
                    if ($text -and $text.Trim() -ne "null" -and -not $text.TrimStart().StartsWith('{')) {
                        Write-Host $text
                    }
                }
            }
        }
    }

    if ($exitCode -ne 0 -and -not $AllowFailure) {
        if ($stderr) {
            throw $stderr
        }

        throw "cloudflared exited with code $exitCode"
    }

    return @{
        Stdout = $stdout
        Stderr = $stderr
        ExitCode = $exitCode
    }
}

Write-Host "+------------------------------------------------------------+" -ForegroundColor Blue
Write-Host "| Cloudflare Tunnel Setup                                    |" -ForegroundColor Blue
Write-Host "+------------------------------------------------------------+" -ForegroundColor Blue
Write-Host

# Check for cloudflared
$cloudflared = Resolve-CloudflaredPath
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
$originCertPath = Join-Path $HOME ".cloudflared\cert.pem"
if (-not (Test-Path $originCertPath)) {
    Write-Host "Not authenticated with Cloudflare. Running login..." -ForegroundColor Yellow
    Invoke-Cloudflared -Arguments @("tunnel", "--loglevel", "error", "login")
}

$TunnelName = "airemotecoder-$env:COMPUTERNAME"
$LocalUrl = "https://localhost:3100"

Write-Host "Checking for existing tunnel..."

# Get tunnel list
$tunnelListOutput = Invoke-Cloudflared -Arguments @("tunnel", "--loglevel", "error", "list", "--output", "json") -Quiet
$tunnelListJson = $tunnelListOutput.Stdout.Trim()

if ($tunnelListJson -eq "null" -or [string]::IsNullOrWhiteSpace($tunnelListJson)) {
    $tunnels = @()
} else {
    $tunnels = $tunnelListJson | ConvertFrom-Json
}
$existingTunnel = $tunnels | Where-Object { $_.name -eq $TunnelName } | Select-Object -First 1

if (-not $existingTunnel) {
    Write-Host "Creating new tunnel: $TunnelName" -ForegroundColor Green
    Invoke-Cloudflared -Arguments @("tunnel", "--loglevel", "error", "create", $TunnelName)
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
Invoke-Cloudflared -Arguments @("tunnel", "--loglevel", "error", "--url", $LocalUrl, "run", $TunnelName)
