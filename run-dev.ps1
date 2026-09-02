<#
Starts the PostgreSQL container and runs the SecMyNet backend locally.
Requires Docker Desktop or Docker Engine with docker-compose support.
#>

Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

function Write-ErrorAndExit($message) {
    Write-Host $message -ForegroundColor Red
    exit 1
}

$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerCmd) {
    Write-ErrorAndExit "Docker is not installed or not available on PATH. Please install Docker Desktop and try again."
}

Write-Host "Starting PostgreSQL container..."
$composeResult = docker compose up -d postgres 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host $composeResult
    Write-ErrorAndExit "Failed to start PostgreSQL container."
}

Write-Host "PostgreSQL container started."

if (-not (Test-Path .env)) {
    Write-Host "Creating .env from .env.example..."
    Copy-Item -Path .env.example -Destination .env -Force
}

Write-Host "Ensuring dependencies are installed..."
npm install
if ($LASTEXITCODE -ne 0) {
    Write-ErrorAndExit "npm install failed."
}

Write-Host "Starting SecMyNet backend..."
npm start
