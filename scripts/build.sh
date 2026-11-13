#!/bin/bash
# Build dsh-git-workspace: compile src/index.ts → lib/ with the locally
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

# 在 Git Bash 里 PATH 通常不含 Windows 的 node，回退到标准安装位置，
# 否则 `npm run build` / prepublishOnly 会在发布机器上直接失败。
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for candidate in "/c/Program Files/nodejs/node.exe" "/c/Program Files/nodejs/node"; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "build: node not found on PATH or in the default install location" >&2
  exit 1
fi

echo "=== Compiling src → lib (tsc $("$NODE_BIN" "$TSC" --version)) ==="
"$NODE_BIN" "$TSC" -p tsconfig.json
echo "=== Build complete ==="
