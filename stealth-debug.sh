#!/usr/bin/env sh
# Open one browser and record the session to logs/.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required and was not found on PATH."
  exit 1
fi

exec node src/index.js --debug "$@"
