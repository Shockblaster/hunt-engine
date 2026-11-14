#!/bin/sh
# Hunt Engine installer for macOS (and Linux). Run from the repo folder:  sh install.sh
set -e
cd "$(dirname "$0")"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1. $2"; missing=1; }; }
missing=0
need node "Install Node 24 LTS from https://nodejs.org"
need claude "Install Claude Code: https://claude.com/claude-code"
need uv "Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh"
[ "$missing" = 1 ] && { echo "Install the missing tools, then run this again."; exit 1; }
major=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$major" -lt 24 ] && { echo "Node $(node -v) is too old; Hunt Engine needs Node 24 or newer."; exit 1; }

echo "Installing the engine..."
npm install --no-audit --no-fund
npm link
echo "Installing the dashboard..."
npm --prefix dashboard install --no-audit --no-fund
npm --prefix dashboard run build

echo "Adding the Claude Code plugin..."
claude plugin marketplace add "$(pwd)"
claude plugin install hunt-engine@hunt-engine

echo
he doctor
echo
echo "Last step, in this terminal: he rules seal"
echo "Then open Claude Code and run /hunt-engine:job-hunt (or freelance-hunt, lead-research)."
