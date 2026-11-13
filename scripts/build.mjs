#!/usr/bin/env node
/**
 * Build the host half: compile src/index.ts → lib/ with the locally installed
 * TypeScript.
 *
 * 刻意不经过 bash：本机 `bash` 是 WSL 的 bash，非登录 shell 里 PATH 不含
 * Windows 的 node，`npm run build` 会在发布机器上直接失败。直接跑 node 脚本
 * 可以跨 Windows / WSL / Git Bash / Linux，不依赖任何 shell 的 PATH 约定。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')

if (!existsSync(tsc)) {
  console.error(`build: typescript not installed — run npm install in ${root}`)
  process.exit(1)
}

console.log('=== Compiling src → lib ===')
execFileSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json')], {
  cwd: root,
  stdio: 'inherit',
})
console.log('=== Build complete ===')
