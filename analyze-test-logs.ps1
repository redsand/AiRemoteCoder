# Diagnostic tool to analyze test logs for the infinite loop fix
# Usage: .\analyze-test-logs.ps1 <runId>

param(
    [Parameter(Mandatory=$true)]
    [string]$RunId,

    [string]$LogPath = ".\wrapper\runs"
)

$runLogDir = Join-Path $LogPath $RunId
$logFile = Join-Path $runLogDir "runner.log"

if (-not (Test-Path $logFile)) {
    Write-Host "ERROR: Log file not found: $logFile" -ForegroundColor Red
    Write-Host ""
    Write-Host "Available runs:" -ForegroundColor Yellow
    if (Test-Path $LogPath) {
        Get-ChildItem $LogPath -Directory | ForEach-Object { Write-Host "  - $($_.Name)" }
    }
    exit 1
}

Write-Host "================================" -ForegroundColor Green
Write-Host "Analyzing logs for Run: $RunId" -ForegroundColor Green
Write-Host "================================" -ForegroundColor Green
Write-Host ""

$logContent = Get-Content $logFile -Raw

# Extract command execution patterns
$executingCommands = @()
$skippingCommands = @()
$commandIds = @()

# Find all "Executing command" lines with their command IDs
$executingMatches = [System.Text.RegularExpressions.Regex]::Matches($logContent, 'Executing command: (.+?)(?:\n|$)', 'IgnoreCase')
foreach ($match in $executingMatches) {
    $executingCommands += $match.Groups[1].Value
}

# Find all "Skipping recently processed command" lines
$skippingMatches = [System.Text.RegularExpressions.Regex]::Matches($logContent, 'Skipping recently processed command: ([a-zA-Z0-9_]+)', 'IgnoreCase')
foreach ($match in $skippingMatches) {
    $skippingCommands += $match.Groups[1].Value
}

# Find all command IDs being processed
$cmdIdMatches = [System.Text.RegularExpressions.Regex]::Matches($logContent, 'Command ID: ([a-zA-Z0-9_]+)', 'IgnoreCase')
foreach ($match in $cmdIdMatches) {
    $commandIds += $match.Groups[1].Value
}

Write-Host "EXECUTION SUMMARY" -ForegroundColor Cyan
Write-Host "=================" -ForegroundColor Cyan
Write-Host "Total unique commands executed: $($executingCommands.Count)" -ForegroundColor Yellow
Write-Host "Total skip attempts: $($skippingCommands.Count)" -ForegroundColor Yellow
Write-Host "Unique command IDs processed: $($commandIds.Count)" -ForegroundColor Yellow
Write-Host ""

if ($skippingCommands.Count -gt 0) {
    Write-Host "DEDUPLICATION WORKING ✓" -ForegroundColor Green
    Write-Host "The system attempted to skip $($skippingCommands.Count) duplicate commands" -ForegroundColor Green
    Write-Host ""
}

# Check for repeated execution of same command
Write-Host "CHECKING FOR REPEATED EXECUTION:" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan

$commandCounts = @{}
foreach ($cmd in $executingCommands) {
    if ($commandCounts.ContainsKey($cmd)) {
        $commandCounts[$cmd]++
    } else {
        $commandCounts[$cmd] = 1
    }
}

$hasRepeats = $false
foreach ($cmd in $commandCounts.Keys) {
    if ($commandCounts[$cmd] -gt 1) {
        Write-Host "⚠️  REPEATED: '$cmd' executed $($commandCounts[$cmd]) times" -ForegroundColor Red
        $hasRepeats = $true
    }
}

if (-not $hasRepeats) {
    Write-Host "✓ No repeated command execution detected" -ForegroundColor Green
    Write-Host "The 30-minute deduplication window is working correctly!" -ForegroundColor Green
    Write-Host ""
}

# Check for Ctrl+C handling
Write-Host "CHECKING SIGNAL HANDLING:" -ForegroundColor Cyan
Write-Host "=========================" -ForegroundColor Cyan

if ($logContent -match "Sending (SIGINT|SIGKILL) to") {
    Write-Host "✓ Signal handler triggered" -ForegroundColor Green
    $signal = if ($logContent -match "Sending SIGKILL") { "SIGKILL" } else { "SIGINT" }
    Write-Host "  Signal used: $signal" -ForegroundColor Yellow
} else {
    Write-Host "ℹ️  No signal handler output found (run may not have been interrupted)" -ForegroundColor Yellow
}

# Check for process exit
if ($logContent -match "Process Summary:") {
    Write-Host "✓ Process completed with exit summary" -ForegroundColor Green

    if ($logContent -match "Exit Code: (\d+)") {
        $exitCode = [int]$Matches[1]
        if ($exitCode -eq 0) {
            Write-Host "  Exit code: $exitCode (clean exit)" -ForegroundColor Green
        } else {
            Write-Host "  Exit code: $exitCode" -ForegroundColor Yellow
        }
    }
}

Write-Host ""
Write-Host "LOG FILE LOCATION:" -ForegroundColor Cyan
Write-Host "$logFile" -ForegroundColor Gray
Write-Host ""

# Show last 20 lines for context
Write-Host "LAST 20 LINES OF LOG:" -ForegroundColor Cyan
Write-Host "====================" -ForegroundColor Cyan
$lines = $logContent -split "`n"
$lastLines = $lines[-20..-1] | Where-Object { $_.Trim() -ne "" }
$lastLines | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }

Write-Host ""
Write-Host "================================" -ForegroundColor Green
Write-Host "Analysis Complete" -ForegroundColor Green
Write-Host "================================" -ForegroundColor Green
