# Hunt Engine installer for Windows. Run from the repo folder:  powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Write-Host "Missing: $cmd. $hint" -ForegroundColor Yellow; return $false }
  return $true
}

$ok = (Need node 'Install Node 24 LTS from https://nodejs.org') -and (Need claude 'Install Claude Code: https://claude.com/claude-code') -and (Need uv 'Install uv: https://docs.astral.sh/uv/getting-started/installation/')
if (-not $ok) { Write-Host 'Install the missing tools, then run this again.'; exit 1 }
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 24) { Write-Host "Node $((node -v)) is too old; Hunt Engine needs Node 24 or newer."; exit 1 }

Write-Host 'Installing the engine...'
npm install --no-audit --no-fund
npm link
Write-Host 'Installing the dashboard...'
npm --prefix dashboard install --no-audit --no-fund
npm --prefix dashboard run build

Write-Host 'Adding the Claude Code plugin...'
claude plugin marketplace add "$root"
claude plugin install hunt-engine@hunt-engine

Write-Host ''
he doctor
Write-Host ''
Write-Host 'Last step, in this window: he rules seal' -ForegroundColor Green
Write-Host 'Then open Claude Code and run /hunt-engine:job-hunt (or freelance-hunt, lead-research).'
