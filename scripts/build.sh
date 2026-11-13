#!/bin/bash
# Build dsh-github-workspace: compile src/index.ts → lib/ with the locally
# installed TypeScript. The host half deliberately has no third-party runtime
# dependency, so no junction links into a DSH checkout are needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"

TSC="node_modules/typescript/bin/tsc"
if [ ! -f "$TSC" ]; then
  echo "build: typescript not installed — run npm install in $ROOT" >&2
  exit 1
fi

echo "=== Compiling src → lib (tsc $(node "$TSC" --version)) ==="
node "$TSC" -p tsconfig.json
echo "=== Build complete ==="
