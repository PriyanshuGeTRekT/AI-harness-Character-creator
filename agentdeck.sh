#!/bin/sh
# Starts AgentDeck in its own window. On macOS, AgentDeck.command does the same on double-click.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "AgentDeck needs Node.js 18 or later: https://nodejs.org"
  exit 1
fi
exec node server.js "$@"
