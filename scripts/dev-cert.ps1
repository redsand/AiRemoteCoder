#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$CertDir = Join-Path $ProjectRoot ".data\certs"

New-Item -ItemType Directory -Force -Path $CertDir | Out-Null

Write-Host "Generating development TLS certificates..."

# Check if OpenSSL is available
$openssl = Get-Command openssl -ErrorAction SilentlyContinue
if (-not $openssl) {
    Write-Host "OpenSSL not found. Using PowerShell to generate certificate..." -ForegroundColor Yellow

    # Use PowerShell's New-SelfSignedCertificate
    $cert = New-SelfSignedCertificate `
        -Subject "CN=localhost" `
        -DnsName "localhost" `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -NotAfter (Get-Date).AddDays(365) `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -FriendlyName "AiRemoteCoder Dev"

    # Export to PFX
    $pfxPath = Join-Path $CertDir "server.pfx"
    $password = ConvertTo-SecureString -String "dev" -Force -AsPlainText
    Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $password | Out-Null

    # Convert to PEM using openssl if available, otherwise provide instructions
    Write-Host "Certificate generated as PFX." -ForegroundColor Green
    Write-Host "To convert to PEM format, install OpenSSL and run:" -ForegroundColor Yellow
    Write-Host "  openssl pkcs12 -in $pfxPath -out $CertDir\server.crt -clcerts -nokeys -password pass:dev"
    Write-Host "  openssl pkcs12 -in $pfxPath -out $CertDir\server.key -nocerts -nodes -password pass:dev"

} else {
    # Generate using OpenSSL
    $keyPath = Join-Path $CertDir "server.key"
    $crtPath = Join-Path $CertDir "server.crt"

    # Generate private key
    openssl genrsa -out $keyPath 2048

    # Generate certificate
    openssl req -new -x509 `
        -key $keyPath `
        -out $crtPath `
        -days 365 `
        -subj "/C=US/ST=Dev/L=Dev/O=AiRemoteCoder/CN=localhost" `
        -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

    Write-Host "Certificates generated:" -ForegroundColor Green
    Write-Host "  Key:  $keyPath"
    Write-Host "  Cert: $crtPath"
}

Write-Host
Write-Host "Note: These are self-signed certificates for development." -ForegroundColor Yellow
Write-Host "For production, use certificates from a trusted CA or Let's Encrypt."
