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
$useSqlite = $false
if ($dockerCmd) {
    Write-Host "Starting PostgreSQL container..."
    $composeResult = docker compose up -d postgres 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "PostgreSQL container started."
    } else {
        Write-Host $composeResult
        Write-Host "PostgreSQL could not be started; using the local SQLite database." -ForegroundColor Yellow
        $useSqlite = $true
    }
} else {
    Write-Host "Docker is not available; using the local SQLite database." -ForegroundColor Yellow
    $useSqlite = $true
}

if (-not (Test-Path .env)) {
    Write-Host "Creating .env from .env.example..."
    Copy-Item -Path .env.example -Destination .env -Force
}

if ($useSqlite) {
    $databaseLine = Get-Content .env | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
    if ($databaseLine -match 'localhost|127\.0\.0\.1') {
        $env:DATABASE_URL = ''
    }
}

Write-Host "Ensuring dependencies are installed..."
npm install
if ($LASTEXITCODE -ne 0) {
    Write-ErrorAndExit "npm install failed."
}

Write-Host "Starting SecMyNet backend..."
npm start
