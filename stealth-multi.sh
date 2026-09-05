#!/usr/bin/env sh
# Ask how many browsers to open, then open them side by side.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required and was not found on PATH."
  exit 1
fi

count=$1
if [ -z "$count" ]; then
  printf 'How many browsers? [3] '
  read -r count
fi
[ -z "$count" ] && count=3

exec node src/index.js --count "$count"
