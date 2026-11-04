# One-time setup of the free transcription worker on Windows.
# Run from the project folder:  powershell -ExecutionPolicy Bypass -File scripts\setup-worker.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Install Node.js 22+ from https://nodejs.org first." }
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw "Install Python 3.10+ from https://python.org first (tick 'Add to PATH')." }

Write-Host "Installing Node packages..."
npm ci

if (-not (Test-Path worker\.venv)) {
  Write-Host "Creating Python environment..."
  python -m venv worker\.venv
}
Write-Host "Installing Whisper + yt-dlp (a few minutes)..."
worker\.venv\Scripts\python.exe -m pip install --upgrade pip --quiet
worker\.venv\Scripts\python.exe -m pip install -r worker\requirements.txt --quiet

Write-Host "Downloading the Whisper model (about 1.6 GB, once)..."
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
worker\.venv\Scripts\python.exe -c "from faster_whisper import WhisperModel; WhisperModel('large-v3-turbo', device='cpu', compute_type='int8')"

if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Write-Host "Created .env - fill in API_URL and WORKER_SECRET, then run start-worker.cmd" -ForegroundColor Yellow
} else {
  Write-Host "Setup done. Run start-worker.cmd" -ForegroundColor Green
}
