#!/usr/bin/env sh
# Open the control panel: settings and launcher in one window.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required and was not found on PATH."
  echo "Install it from https://nodejs.org and run this again."
  exit 1
fi

exec node src/index.js --app "$@"
