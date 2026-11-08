#!/bin/sh
# install-hooks.sh -- point this repo's Git at .githooks/ (the dependency-free
# alternative to husky). Idempotent and safe to re-run.
#
#   npm run hooks        # or: bash scripts/install-hooks.sh, make hooks

set -e
cd "$(dirname "$0")/.."

# The hook must be executable on Unix; on Windows Git-for-Windows runs hooks via
# sh regardless, but keep the bit correct for everyone else.
chmod +x .githooks/pre-commit 2>/dev/null || true

git config core.hooksPath .githooks
echo "Git hooks installed: core.hooksPath = .githooks"
echo "The pre-commit gate will now run syntax + control-byte checks."
