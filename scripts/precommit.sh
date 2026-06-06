#!/bin/bash
# Pre-commit hook: run typecheck before allowing the commit.
# If you want to also run tests, change the body to:
#   npm test
#   npx tsc --noEmit
set -e
echo "[pre-commit] running tsc --noEmit..."
npx tsc --noEmit
echo "[pre-commit] tsc passed, allowing commit"
