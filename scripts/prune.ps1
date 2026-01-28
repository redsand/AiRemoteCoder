#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Prune old runs and artifacts based on retention policy

.DESCRIPTION
    This script removes completed/failed runs older than RUN_RETENTION_DAYS,
    cleans up associated artifacts, and vacuums the database.

.PARAMETER Days
    Override the default retention days (from .env or 30)
#>

param(
    [int]$Days = 0
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$DataDir = Join-Path $ProjectRoot ".data"
$DbPath = Join-Path $DataDir "db.sqlite"
$ArtifactsDir = Join-Path $DataDir "artifacts"
$RunsDir = Join-Path $DataDir "runs"

# Load retention days from .env or use default
$RetentionDays = $Days
if ($RetentionDays -eq 0) {
    $envFile = Join-Path $ProjectRoot ".env"
    if (Test-Path $envFile) {
        $envContent = Get-Content $envFile
        $match = $envContent | Select-String "RUN_RETENTION_DAYS=(\d+)"
        if ($match) {
            $RetentionDays = [int]$match.Matches[0].Groups[1].Value
        }
    }
}
if ($RetentionDays -eq 0) {
    $RetentionDays = 30
}

Write-Host "Pruning runs older than $RetentionDays days..." -ForegroundColor Blue

if (-not (Test-Path $DbPath)) {
    Write-Host "No database found. Nothing to prune." -ForegroundColor Yellow
    exit 0
}

# Calculate cutoff timestamp
$Cutoff = [int][DateTimeOffset]::UtcNow.AddDays(-$RetentionDays).ToUnixTimeSeconds()

# We need sqlite3 CLI for this
$sqlite = Get-Command sqlite3 -ErrorAction SilentlyContinue
if (-not $sqlite) {
    Write-Host "sqlite3 not found. Please install SQLite CLI tools." -ForegroundColor Red
    Write-Host "  Windows: winget install SQLite.SQLite"
    Write-Host "  Or run: node scripts/prune.mjs"
    exit 1
}

# Get old runs
$oldRunsQuery = "SELECT id FROM runs WHERE created_at < $Cutoff AND status IN ('done', 'failed');"
$oldRuns = (sqlite3 $DbPath $oldRunsQuery) -split "`n" | Where-Object { $_ }

Write-Host "Found $($oldRuns.Count) runs to prune"

$artifactsDeleted = 0
$dirsDeleted = 0

foreach ($runId in $oldRuns) {
    if (-not $runId) { continue }

    Write-Host "  Pruning run: $runId"

    # Delete run artifact directory
    $runArtifactDir = Join-Path $ArtifactsDir $runId
    if (Test-Path $runArtifactDir) {
        $files = (Get-ChildItem $runArtifactDir -File).Count
        Remove-Item $runArtifactDir -Recurse -Force
        $artifactsDeleted += $files
        $dirsDeleted++
    }

    # Delete run logs directory
    $runLogsDir = Join-Path $RunsDir $runId
    if (Test-Path $runLogsDir) {
        Remove-Item $runLogsDir -Recurse -Force
        $dirsDeleted++
    }

    # Delete from database
    sqlite3 $DbPath "DELETE FROM runs WHERE id = '$runId';"
}

# Clean orphaned directories
Write-Host "Cleaning orphaned directories..."

if (Test-Path $ArtifactsDir) {
    Get-ChildItem $ArtifactsDir -Directory | ForEach-Object {
        $exists = sqlite3 $DbPath "SELECT id FROM runs WHERE id = '$($_.Name)';"
        if (-not $exists) {
            Write-Host "  Cleaning orphaned: $($_.Name)"
            Remove-Item $_.FullName -Recurse -Force
            $dirsDeleted++
        }
    }
}

if (Test-Path $RunsDir) {
    Get-ChildItem $RunsDir -Directory | ForEach-Object {
        $exists = sqlite3 $DbPath "SELECT id FROM runs WHERE id = '$($_.Name)';"
        if (-not $exists) {
            Write-Host "  Cleaning orphaned: $($_.Name)"
            Remove-Item $_.FullName -Recurse -Force
            $dirsDeleted++
        }
    }
}

# Clean old nonces
$noncesCutoff = $Cutoff - 3600
$noncesResult = sqlite3 $DbPath "DELETE FROM nonces WHERE created_at < $noncesCutoff; SELECT changes();"
Write-Host "Cleaned $noncesResult expired nonces"

# Clean old sessions
$now = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$sessionsResult = sqlite3 $DbPath "DELETE FROM sessions WHERE expires_at < $now; SELECT changes();"
Write-Host "Cleaned $sessionsResult expired sessions"

# Vacuum database
Write-Host "Vacuuming database..."
sqlite3 $DbPath "VACUUM;"

Write-Host
Write-Host "Prune complete:" -ForegroundColor Green
Write-Host "  Runs deleted: $($oldRuns.Count)"
Write-Host "  Artifacts deleted: $artifactsDeleted"
Write-Host "  Directories cleaned: $dirsDeleted"
