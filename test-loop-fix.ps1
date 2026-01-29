# Test script to verify the infinite loop fix
# This tests that commands are not re-executed after deduplication

Write-Host "================================" -ForegroundColor Green
Write-Host "Testing Infinite Loop Fix" -ForegroundColor Green
Write-Host "================================" -ForegroundColor Green
Write-Host ""

# Check if ai-runner is available
try {
    $version = ai-runner -V
    Write-Host "ai-runner version: $version" -ForegroundColor Cyan
} catch {
    Write-Host "ERROR: ai-runner not found. Please run: npm install -g ./wrapper" -ForegroundColor Red
    exit 1
}

# You need to provide a run ID and token from your gateway
# Example: PS> .\test-loop-fix.ps1 -RunId "YOUR_RUN_ID" -Token "YOUR_TOKEN"

if (-not $args[0] -or -not $args[1]) {
    Write-Host ""
    Write-Host "USAGE:" -ForegroundColor Yellow
    Write-Host "  .\test-loop-fix.ps1 <runId> <token> [workerType] [prompt]" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "EXAMPLE:" -ForegroundColor Yellow
    Write-Host '  .\test-loop-fix.ps1 "YOUR_RUN_ID" "YOUR_TOKEN" "rev" "Ensure our documentation is up to date"' -ForegroundColor Yellow
    Write-Host ""
    Write-Host "TESTING NOTES:" -ForegroundColor Cyan
    Write-Host "1. Watch the console output for command execution"
    Write-Host "2. Look for 'Skipping recently processed command' messages"
    Write-Host "3. The same command should NOT execute again within 30 minutes"
    Write-Host "4. Test Ctrl+C by pressing it - the process should stop immediately"
    Write-Host ""
    exit 0
}

$runId = $args[0]
$token = $args[1]
$workerType = if ($args[2]) { $args[2] } else { "rev" }
$prompt = if ($args[3]) { $args[3] } else { "Check the test duration and ensure all tests pass" }

Write-Host "Starting test..." -ForegroundColor Green
Write-Host "  Run ID: $runId" -ForegroundColor Cyan
Write-Host "  Worker Type: $workerType" -ForegroundColor Cyan
Write-Host "  Prompt: $prompt" -ForegroundColor Cyan
Write-Host ""
Write-Host "WATCHING FOR DUPLICATE EXECUTION:" -ForegroundColor Yellow
Write-Host "  ✓ Commands should be marked processed for 30 minutes"
Write-Host "  ✓ 'Executing command' should appear only ONCE per unique command"
Write-Host "  ✓ 'Skipping recently processed command' means deduplication is working"
Write-Host ""

# Start ai-runner with the provided parameters
$cmdArgs = @(
    "start",
    "--run-id", $runId,
    "--token", $token,
    "--worker-type", $workerType,
    "--cmd", $prompt
)

Write-Host "Running: ai-runner $($cmdArgs -join ' ')" -ForegroundColor Gray
Write-Host ""
Write-Host "Press Ctrl+C to test signal handling..." -ForegroundColor Yellow
Write-Host ""

try {
    & ai-runner @cmdArgs
} catch {
    Write-Host "Process terminated: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "================================" -ForegroundColor Green
Write-Host "Test Complete" -ForegroundColor Green
Write-Host "================================" -ForegroundColor Green
