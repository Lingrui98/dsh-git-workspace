/**
 * @dsh-external/dsh-git-workspace — host 半。
 *
 * 给浏览器半提供本地回环 HTTP 路由，把指定 GitHub 仓库拉到磁盘并回报绝对路径。
 * 工作区的注册由 ui-workspace 的洞所有者完成，本插件不碰工作区注册表。
 *
 * 路由：
 *   POST /gh-workspace/clone        { repo, branch?, parentDir?, token? } -> { jobId }
 *   GET  /gh-workspace/job?id=xxx   -> { state, percent, detail, path?, error? }
 *   POST /gh-workspace/job/cancel   { id } -> { cancelled }
 *   GET  /gh-workspace/jobs         -> 进行中的任务列表（供角落浮层恢复）
 *
 * 克隆是后台任务：请求立即返回 jobId，进度通过轮询读取，不阻塞调用方。
 * 凭据走 GIT_CONFIG_* 环境变量注入，不进入命令行参数（避免 ps 泄露）。
 *
 * 拉取走两级：优先 git clone（本机 git 不在 PATH，必须按候选路径探测），
 * git 不可用或失败时退到 codeload tarball + 系统 tar。tarball 结果没有 .git。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export const name = 'dsh-git-workspace'
export const inject = ['webServer']

const ROUTE_PREFIX = '/gh-workspace'
const MAX_BODY_BYTES = 64 * 1024
const DEFAULT_CLONE_TIMEOUT_MS = 900_000
const MAX_TARBALL_BYTES = 256 * 1024 * 1024
/** 同时进行的克隆任务上限：每个任务都会下载上百 MB。 */
const MAX_CONCURRENT_JOBS = 3
/** 完成的任务保留多久（毫秒），够客户端取一次结果即可。 */
const JOB_RETENTION_MS = 10 * 60 * 1000

interface ServerResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string | Uint8Array): void
}

interface WebServerService {
  register(spec: {
    kind: 'prefix' | 'exact'
    path: string
    handler: (req: any, res: ServerResponse) => void | Promise<void>
  }): () => void
}

type AppContext = {
  webServer: WebServerService
  effect: (fn: () => unknown, label?: string) => () => void
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void }
}

interface ParsedRepo {
  /** 界面展示用的来源标识（host/path 或 owner/repo） */
  label: string
  /** GitHub 的 owner；非 GitHub 为空串 */
  owner: string
  /** 目标目录名（地址尾段，去掉 .git） */
  repo: string
  /** 原样交给 git clone 的地址 */
  url: string
  /** 小写主机名，用于凭据注入 */
  host: string
  /** 只有 GitHub 能走 codeload tarball 兜底 */
  isGitHub: boolean
}

type JobState = 'running' | 'done' | 'failed' | 'cancelled'

interface CloneJob {
  id: string
  repo: string
  dest: string
  state: JobState
  percent: number
  detail: string
  path?: string
  method?: string
  error?: string
  startedAt: number
  finishedAt?: number
}

interface RunningJob {
  job: CloneJob
  child?: { kill: () => void }
  cancelled: boolean
}

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/
const PATH_CHARS_RE = /^[A-Za-z0-9._/-]+$/

function lastSegment(path: string): string | null {
  const parts = path.split('/').filter((part) => part !== '')
  const last = parts[parts.length - 1]
  if (last === undefined) return null
  const name = last.endsWith('.git') ? last.slice(0, -4) : last
  if (name === '' || name === '.' || name === '..') return null
  if (!REPO_NAME_RE.test(name)) return null
  return name
}

/**
 * 解析任意 Git 仓库地址：
 *   - 短格式 `owner/repo`（默认 github.com，保持旧行为）
 *   - 协议地址 `https://host/path`、`ssh://git@host/path`、`git://host/path`
 *   - SCP 风格 `git@host:path`
 *
 * 明确拒绝本地路径与 file://：这不是「clone 本地目录」的入口，
 * 放开等于把读取本地文件系统的能力暴露给调用方。
 */
function parseRepo(input: unknown): ParsedRepo | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (raw === '') return null

  // 本地路径 / file:// 一律拒绝
  if (/^file:/i.test(raw)) return null
  if (raw.startsWith('/') || raw.startsWith('\\') || raw.startsWith('.') || raw.startsWith('~')) return null
  if (/^[A-Za-z]:[\\/]/.test(raw)) return null

  // 1) 协议地址
  const withScheme = /^(https?|ssh|git):\/\/([^/]+)\/(.+)$/.exec(raw)
  if (withScheme !== null) {
    const scheme = withScheme[1].toLowerCase()
    const authority = withScheme[2]
    const at = authority.lastIndexOf('@')
    const hostPort = at >= 0 ? authority.slice(at + 1) : authority
    const path = withScheme[3].replace(/\/+$/, '')
    if (!HOST_RE.test(hostPort)) return null
    if (!PATH_CHARS_RE.test(path) || path.includes('..')) return null
    const repo = lastSegment(path)
    if (repo === null) return null
    const host = hostPort.split(':')[0].toLowerCase()
    const parts = path.split('/').filter((part) => part !== '')
    return {
      label: `${host}/${parts.join('/')}`,
      owner: host === 'github.com' && parts.length >= 2 ? parts[0] : '',
      repo,
      url: scheme === 'http' ? raw : raw,
      host,
      isGitHub: host === 'github.com',
    }
  }

  // 2) SCP 风格 user@host:path
  const scp = /^([A-Za-z0-9_.-]+)@([A-Za-z0-9.-]+):(.+)$/.exec(raw)
  if (scp !== null) {
    const host = scp[2].toLowerCase()
    const path = scp[3].replace(/\/+$/, '')
    if (!PATH_CHARS_RE.test(path) || path.includes('..')) return null
    const repo = lastSegment(path)
    if (repo === null) return null
    const parts = path.split('/').filter((part) => part !== '')
    return {
      label: `${host}/${parts.join('/')}`,
      owner: host === 'github.com' && parts.length >= 2 ? parts[0] : '',
      repo,
      url: raw,
      host,
      isGitHub: host === 'github.com',
    }
  }

  // 3) 短格式 owner/repo → github.com
  const short = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(raw)
  if (short !== null) {
    const owner = short[1]
    const repo = short[2]
    if (!SEGMENT_RE.test(owner) || !REPO_NAME_RE.test(repo) || repo === '.' || repo === '..') return null
    return {
      label: `${owner}/${repo}`,
      owner,
      repo,
      url: `https://github.com/${owner}/${repo}.git`,
      host: 'github.com',
      isGitHub: true,
    }
  }

  return null
}

function isLoopback(req: any): boolean {
  const addr: unknown = req?.socket?.remoteAddress
  if (typeof addr !== 'string') return false
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function hostnameOf(hostHeader: unknown): string {
  if (typeof hostHeader !== 'string' || hostHeader === '') return ''
  const trimmed = hostHeader.trim()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end > 0 ? trimmed.slice(0, end + 1) : trimmed
  }
  const colon = trimmed.lastIndexOf(':')
  return colon > 0 ? trimmed.slice(0, colon) : trimmed
}

/**
 * 回环地址只挡「非本机连接」，挡不住本机浏览器里的恶意页面：
 * 任何站点都能向 127.0.0.1:<port> 发一个 text/plain 的跨站 POST，
 * 触发任意目录写入；DNS rebinding 还能把任意域名解析到回环，
 * 让攻击页同源读取 /jobs、/job 的任务与路径信息。
 *
 * 三道防线：
 *   1. Host 必须是回环主机名 —— 挡住 DNS rebinding。
 *   2. POST 必须是 application/json —— 非简单请求，跨站会先发 preflight，
 *      而本服务不响应 preflight，浏览器就不会真正发出请求。
 *   3. Origin 存在时必须是回环源 —— 兜住同源策略覆盖不到的场景。
 */
function isTrustedRequest(req: any): boolean {
  if (!isLoopback(req)) return false

  const hostname = hostnameOf(req.headers?.host)
  if (!LOOPBACK_HOSTS.has(hostname.toLowerCase())) return false

  if (req.method === 'POST') {
    const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) return false
  }

  const origin: unknown = req.headers?.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      const parsed = new URL(origin)
      if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return false
    } catch {
      return false
    }
  }

  return true
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req: any): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buf.length
    if (total > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(buf)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const isWindows = process.platform === 'win32'

/** 某个裸命令能否执行（--version 探测，5 秒超时）。 */
function commandWorks(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolvePromise(ok)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    } catch {
      resolvePromise(false)
      return
    }
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      finish(false)
    }, 5000)
    child.on('error', () => finish(false))
    child.on('close', (code: number | null) => finish(code === 0))
  })
}

/**
 * git 可执行文件定位，顺序为：环境变量覆盖 → 各平台常见安装路径 →
 * PATH 里的裸 `git`（Web/Linux 部署通常只在 PATH 里）。
 */
async function resolveGitExecutable(): Promise<string | null> {
  const override = process.env.DSH_GIT_EXE
  if (override && (await fileExists(override))) return override

  const candidates = isWindows
    ? [
        'C:\\Program Files\\Git\\cmd\\git.exe',
        'C:\\Program Files\\Git\\bin\\git.exe',
        'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
        join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'cmd', 'git.exe'),
      ]
    : ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git']

  for (const candidate of candidates) {
    if (candidate !== '' && (await fileExists(candidate))) return candidate
  }

  // 回退到 PATH：Web 端（Linux 容器、nix、自编译）常见 git 只在 PATH 里。
  if (await commandWorks('git', ['--version'])) return 'git'
  return null
}

/** 系统 tar：Windows 自带 bsdtar，类 Unix 走 PATH 里的 tar。 */
function resolveTarExecutable(): string {
  return isWindows ? 'C:\\Windows\\System32\\tar.exe' : 'tar'
}

/**
 * git 的凭据相关环境：
 * - GIT_TERMINAL_PROMPT=0 让缺少凭据时立刻失败，而不是等交互输入到超时。
 * - token 走 GIT_CONFIG_* 环境变量而不是命令行参数，这样 token 不会出现在
 *   进程列表里，也不会写进 .git/config。
 */
function authEnv(token: string, host: string): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' }
  if (token === '' || host === '') return env
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    ...env,
    GIT_CONFIG_COUNT: '1',
    // 按实际主机匹配，GitHub / GitLab / 自建服务器都能用同一个 token。
    GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  }
}

interface ProcessResult {
  ok: boolean
  stderr: string
  cancelled: boolean
}

/**
 * 杀整棵进程树。Windows 上 git.exe 会派生 git-remote-https.exe，
 * 只 kill 父进程不会终止子树，stderr 管道继续被占用，close 永不触发，
 * 任务就永远停在 running。
 */
function killTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid
  if (pid === undefined) return
  if (isWindows) {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      return
    } catch {
      /* 回退到单进程 kill */
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  options: {
    env?: Record<string, string>
    onStderr?: (text: string) => void
    onSpawn?: (child: { kill: () => void }) => void
    isCancelled?: () => boolean
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelPoll: ReturnType<typeof setInterval> | undefined
    const finish = (ok: boolean, stderr: string, cancelled = false): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (cancelPoll !== undefined) clearInterval(cancelPoll)
      resolvePromise({ ok, stderr, cancelled })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, ...(options.env ?? {}) },
      })
    } catch (error) {
      finish(false, error instanceof Error ? error.message : String(error))
      return
    }
    options.onSpawn?.({ kill: () => killTree(child) })

    // 超时与取消都杀整棵树，并各留一个兜底 finish：树杀后 close 仍可能
    // 因为管道被占用而不触发，没有兜底 job 会永远停在 running。
    timer = setTimeout(() => {
      killTree(child)
      setTimeout(() => finish(false, `命令超时（${timeoutMs}ms）`), 3000)
    }, timeoutMs)

    if (options.isCancelled !== undefined) {
      cancelPoll = setInterval(() => {
        if (options.isCancelled?.() !== true) return
        if (cancelPoll !== undefined) clearInterval(cancelPoll)
        cancelPoll = undefined
        killTree(child)
        setTimeout(() => finish(false, '已取消', true), 3000)
      }, 500)
    }

    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (stderr.length < 20000) stderr += text
      options.onStderr?.(text)
    })
    child.on('error', (error: Error) => finish(false, `无法执行 ${command}：${error.message}`))
    child.on('close', (code: number | null) => {
      const cancelled = options.isCancelled?.() === true
      finish(code === 0 && !cancelled, stderr.trim(), cancelled)
    })
  })
}

/** 从 git 的 --progress 输出里取百分比；Receiving/Resolving 段都算。 */
function parseGitPercent(text: string): number | undefined {
  const matches = [...text.matchAll(/(\d{1,3})%/g)]
  if (matches.length === 0) return undefined
  const last = Number(matches[matches.length - 1][1])
  if (!Number.isFinite(last)) return undefined
  return Math.max(0, Math.min(100, last))
}

async function cloneWithGit(
  git: string,
  url: string,
  dest: string,
  branch: string,
  timeoutMs: number,
  token: string,
  host: string,
  hooks: {
    onProgress?: (percent: number, detail: string) => void
    onSpawn?: (child: { kill: () => void }) => void
    isCancelled?: () => boolean
  },
): Promise<ProcessResult> {
  const args = ['clone', '--depth', '1', '--progress']
  if (branch !== '') args.push('--branch', branch)
  args.push(url, dest)

  let lastPercent = 0
  const result = await runProcess(git, args, timeoutMs, {
    env: authEnv(token, host),
    onSpawn: hooks.onSpawn,
    isCancelled: hooks.isCancelled,
    onStderr: (text) => {
      const percent = parseGitPercent(text)
      if (percent === undefined) return
      if (percent < lastPercent) return
      lastPercent = percent
      hooks.onProgress?.(percent, '正在接收对象')
    },
  })

  if (!result.ok && !result.cancelled) {
    // 半途失败会留下残目录，清掉才能让 tarball 兜底或重试。
    await rm(dest, { recursive: true, force: true }).catch(() => {})
  }
  return result
}

/** 无 git 或 git 失败时用 codeload tarball：下载 → 系统 tar 解压并剥掉顶层目录。 */
async function cloneWithTarball(
  parsed: ParsedRepo,
  dest: string,
  branch: string,
  timeoutMs: number,
  token: string,
  hooks: {
    onProgress?: (percent: number, detail: string) => void
    onSpawn?: (child: { kill: () => void }) => void
    isCancelled?: () => boolean
  },
): Promise<{ ok: boolean; error: string; cancelled: boolean }> {
  const ref = branch === '' ? 'HEAD' : `refs/heads/${branch}`
  const url = `https://codeload.github.com/${parsed.owner}/${parsed.repo}/tar.gz/${ref}`

  let bytes: Buffer
  try {
    const headers: Record<string, string> = {}
    if (token !== '') headers.authorization = `Bearer ${token}`
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) {
      return { ok: false, error: `下载失败：HTTP ${response.status}（${url}）`, cancelled: false }
    }
    hooks.onProgress?.(15, '正在下载压缩包')

    const chunks: Uint8Array[] = []
    let received = 0
    const reader = response.body?.getReader()
    if (reader === undefined) {
      const array = await response.arrayBuffer()
      bytes = Buffer.from(array)
    } else {
      for (;;) {
        if (hooks.isCancelled?.() === true) {
          await reader.cancel().catch(() => {})
          return { ok: false, error: '已取消', cancelled: true }
        }
        const next = await reader.read()
        if (next.done) break
        chunks.push(next.value)
        received += next.value.byteLength
        if (received > MAX_TARBALL_BYTES) {
          await reader.cancel().catch(() => {})
          return { ok: false, error: `仓库压缩包超过上限 ${MAX_TARBALL_BYTES} 字节`, cancelled: false }
        }
        // 有 content-length 时按字节算，没有就停在 90% 直到解压。
        const total = Number(response.headers.get('content-length') ?? '0')
        const percent = total > 0 ? Math.min(90, 15 + Math.round((received / total) * 75)) : 50
        hooks.onProgress?.(percent, '正在下载压缩包')
      }
      bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)))
    }
    if (bytes.byteLength > MAX_TARBALL_BYTES) {
      return { ok: false, error: `仓库压缩包超过上限 ${MAX_TARBALL_BYTES} 字节`, cancelled: false }
    }
  } catch (error) {
    return {
      ok: false,
      error: `下载失败：${error instanceof Error ? error.message : String(error)}`,
      cancelled: hooks.isCancelled?.() === true,
    }
  }

  const tarball = join(tmpdir(), `dsh-gh-${Date.now()}-${parsed.repo}.tar.gz`)
  try {
    await writeFile(tarball, bytes)
    await mkdir(dest, { recursive: true })
    hooks.onProgress?.(92, '正在解压')
    const result = await runProcess(
      resolveTarExecutable(),
      ['--strip-components=1', '-xzf', tarball, '-C', dest],
      timeoutMs,
      { onSpawn: hooks.onSpawn, isCancelled: hooks.isCancelled },
    )
    if (!result.ok) {
      return {
        ok: false,
        error: result.stderr === '' ? 'tar 解压失败' : result.stderr,
        cancelled: result.cancelled,
      }
    }
    hooks.onProgress?.(100, '完成')
    return { ok: true, error: '', cancelled: false }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), cancelled: false }
  } finally {
    await rm(tarball, { force: true }).catch(() => {})
  }
}

async function directoryIsNonEmpty(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path)
    return entries.length > 0
  } catch {
    return false
  }
}

export function apply(ctx: AppContext): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const defaultRoot = process.env.DSH_GITHUB_WORKSPACE_ROOT || join(dshHome, 'github-workspaces')
  const timeoutMs = DEFAULT_CLONE_TIMEOUT_MS
  const jobs = new Map<string, RunningJob>()

  const sweepJobs = (): void => {
    const now = Date.now()
    for (const [id, running] of jobs) {
      const finished = running.job.finishedAt
      if (finished !== undefined && now - finished > JOB_RETENTION_MS) jobs.delete(id)
    }
  }

  /** 后台跑一次拉取；进度写进 job，客户端轮询读取。 */
  const runJob = async (
    running: RunningJob,
    parsed: ParsedRepo,
    dest: string,
    branchRaw: string,
    parentDir: string,
    token: string,
  ): Promise<void> => {
    const { job } = running
    const progress = (percent: number, detail: string): void => {
      job.percent = Math.max(job.percent, percent)
      job.detail = detail
    }

    try {
      await mkdir(parentDir, { recursive: true })
    } catch (error) {
      job.state = 'failed'
      job.error = `无法创建父目录：${error instanceof Error ? error.message : String(error)}`
      job.finishedAt = Date.now()
      return
    }

    const git = await resolveGitExecutable()
    let gitError = ''

    if (git !== null && !running.cancelled) {
      ctx.logger?.info?.(`[dsh-git-workspace] git clone ${parsed.label} -> ${dest}`)
      progress(3, '正在连接')
      const attempt = await cloneWithGit(
        git,
        parsed.url,
        dest,
        branchRaw,
        timeoutMs,
        token,
        parsed.host,
        {
          onProgress: progress,
          onSpawn: (child) => {
            running.child = child
          },
          isCancelled: () => running.cancelled,
        },
      )
      if (attempt.ok) {
        job.state = 'done'
        job.percent = 100
        job.detail = '完成'
        job.path = dest
        job.method = 'git'
        job.finishedAt = Date.now()
        return
      }
      if (attempt.cancelled || running.cancelled) {
        job.state = 'cancelled'
        job.detail = '已取消'
        job.finishedAt = Date.now()
        await rm(dest, { recursive: true, force: true }).catch(() => {})
        return
      }
      gitError = attempt.stderr
      ctx.logger?.warn?.(`[dsh-git-workspace] git clone 失败：${gitError.slice(0, 200)}`)
      progress(10, '准备兜底')
    } else if (git === null) {
      ctx.logger?.warn?.('[dsh-git-workspace] 未找到 git 可执行文件')
    }

    // git 分支可能已被取消：进入下载前先早退，别让 tarball 白跑一趟。
    if (running.cancelled) {
      job.state = 'cancelled'
      job.detail = '已取消'
      job.finishedAt = Date.now()
      await rm(dest, { recursive: true, force: true }).catch(() => {})
      return
    }

    // 只有 GitHub 有 codeload 归档接口；其他主机的唯一路径就是 git。
    if (!parsed.isGitHub) {
      job.state = 'failed'
      job.error =
        git === null
          ? `未找到 git，且 ${parsed.host} 没有可用的归档兜底。请安装 git 或设置 DSH_GIT_EXE。`
          : `git clone 失败，且 ${parsed.host} 没有可用的归档兜底。git 输出：${gitError.slice(0, 600)}`
      job.finishedAt = Date.now()
      await rm(dest, { recursive: true, force: true }).catch(() => {})
      return
    }

    const fallback = await cloneWithTarball(parsed, dest, branchRaw, timeoutMs, token, {
      onProgress: progress,
      onSpawn: (child) => {
        running.child = child
      },
      isCancelled: () => running.cancelled,
    })
    if (fallback.ok) {
      job.state = 'done'
      job.percent = 100
      job.detail = '完成'
      job.path = dest
      job.method = 'tarball'
      job.finishedAt = Date.now()
      return
    }
    if (fallback.cancelled || running.cancelled) {
      job.state = 'cancelled'
      job.detail = '已取消'
      job.finishedAt = Date.now()
    } else {
      job.state = 'failed'
      // 认证类失败单独给出可操作的提示：本机凭据没覆盖这个仓库时，让用户填令牌。
      const authLike =
        /(Authentication failed|could not read Username|terminal prompts disabled|Invalid username or password|Repository not found|403)/i.test(
          gitError,
        )
      job.error = authLike
        ? `看起来是权限问题：本机 git 凭据（credential.helper）没有覆盖该仓库。请在「访问令牌」里填入对应的 Personal Access Token 后重试。git 输出：${gitError.slice(0, 400)}；tarball：${fallback.error.slice(0, 300)}`
        : `git clone 与 tarball 均失败。git：${gitError === '' ? '不可用' : gitError.slice(0, 600)}；tarball：${fallback.error.slice(0, 600)}`
      job.finishedAt = Date.now()
    }
    await rm(dest, { recursive: true, force: true }).catch(() => {})
  }

  const handler = async (req: any, res: ServerResponse): Promise<void> => {
    // 三重校验：回环来源 + 回环 Host + JSON content-type（+ Origin 同源）。
    if (!isTrustedRequest(req)) {
      writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: '仅允许本机页面调用' } })
      return
    }

    const url = new URL(req.url ?? '/', 'http://gh-workspace.internal')
    const pathname = url.pathname
    const method = pathname.startsWith(ROUTE_PREFIX + '/')
      ? pathname.slice(ROUTE_PREFIX.length + 1)
      : undefined

    sweepJobs()

    // 进行中任务列表：角落浮层在页面重载后用它恢复显示。
    if (method === 'jobs' && req.method === 'GET') {
      const active = [...jobs.values()]
        .filter((running) => running.job.state === 'running')
        .map((running) => serializeJob(running.job))
      writeJson(res, 200, { ok: true, value: { jobs: active } })
      return
    }

    if (method === 'job' && req.method === 'GET') {
      const id = url.searchParams.get('id') ?? ''
      const running = jobs.get(id)
      if (running === undefined) {
        writeJson(res, 404, { ok: false, error: { code: 'no-job', message: '任务不存在或已过期' } })
        return
      }
      writeJson(res, 200, { ok: true, value: serializeJob(running.job) })
      return
    }

    if (method === 'job/cancel' && req.method === 'POST') {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: '只接受 POST' } })
        return
      }
      let payload: any
      try {
        payload = await readJsonBody(req)
      } catch {
        payload = {}
      }
      const running = jobs.get(String(payload?.id ?? ''))
      if (running === undefined) {
        writeJson(res, 404, { ok: false, error: { code: 'no-job', message: '任务不存在或已过期' } })
        return
      }
      running.cancelled = true
      try {
        running.child?.kill()
      } catch {
        /* 已退出 */
      }
      writeJson(res, 200, { ok: true, value: { cancelled: true } })
      return
    }

    if (method !== 'clone') {
      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: '未知方法' } })
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: { code: 'method-error', message: '只接受 POST' } })
      return
    }

    let payload: any
    try {
      payload = await readJsonBody(req)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeJson(res, 400, { ok: false, error: { code: 'bad-json', message } })
      return
    }

    const parsed = parseRepo(payload?.repo)
    if (!parsed) {
      writeJson(res, 400, {
        ok: false,
        error: { code: 'bad-repo', message: '仓库格式应为 owner/repo 或 https://github.com/owner/repo' },
      })
      return
    }

    const branchRaw = typeof payload?.branch === 'string' ? payload.branch.trim() : ''
    if (branchRaw !== '' && (!BRANCH_RE.test(branchRaw) || branchRaw.includes('..'))) {
      writeJson(res, 400, { ok: false, error: { code: 'bad-branch', message: '分支名不合法' } })
      return
    }

    const parentRaw = typeof payload?.parentDir === 'string' ? payload.parentDir.trim() : ''
    let parentDir: string
    if (parentRaw === '') {
      parentDir = defaultRoot
    } else if (!isAbsolute(parentRaw)) {
      writeJson(res, 400, { ok: false, error: { code: 'bad-parent', message: '父目录必须是绝对路径' } })
      return
    } else {
      // 用户指定的父目录必须已存在且是目录：不替调用方创建任意路径，
      // 把「往哪写」限制在用户事先建好的位置。
      const info = await stat(parentRaw).catch(() => null)
      if (info === null || !info.isDirectory()) {
        writeJson(res, 400, {
          ok: false,
          error: { code: 'bad-parent', message: `父目录不存在或不是目录：${parentRaw}` },
        })
        return
      }
      parentDir = parentRaw
    }

    // 并发上限：每个任务都会下载上百 MB，不设上限可被反复提交打满磁盘。
    const runningCount = [...jobs.values()].filter((r) => r.job.state === 'running').length
    if (runningCount >= MAX_CONCURRENT_JOBS) {
      writeJson(res, 429, {
        ok: false,
        error: { code: 'too-many-jobs', message: `同时最多 ${MAX_CONCURRENT_JOBS} 个克隆任务，请等待完成` },
      })
      return
    }

    // 凭据只用于本次任务，不落盘；客户端传的 token 优先，其次读环境变量。
    const tokenRaw = typeof payload?.token === 'string' ? payload.token.trim() : ''
    const token =
      tokenRaw !== ''
        ? tokenRaw
        : (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim()

    const dest = join(parentDir, parsed.repo)

    // 同一目标目录已有在跑的任务：直接返回它，避免两个任务互相覆盖/互删。
    const conflicting = [...jobs.values()].find(
      (running) =>
        running.job.state === 'running' && running.job.dest.toLowerCase() === dest.toLowerCase(),
    )
    if (conflicting !== undefined) {
      writeJson(res, 200, { ok: true, value: serializeJob(conflicting.job) })
      return
    }

    const job: CloneJob = {
      id: randomUUID(),
      repo: parsed.label,
      dest,
      state: 'running',
      percent: 0,
      detail: '排队中',
      startedAt: Date.now(),
    }
    const running: RunningJob = { job, cancelled: false }
    jobs.set(job.id, running)

    // 已存在且有内容：直接标记完成，不重复下载。
    if (await pathExists(dest)) {
      if (await directoryIsNonEmpty(dest)) {
        job.state = 'done'
        job.percent = 100
        job.detail = '已存在，直接复用'
        job.path = dest
        job.method = 'existing'
        job.finishedAt = Date.now()
        writeJson(res, 200, { ok: true, value: serializeJob(job) })
        return
      }
    }

    void runJob(running, parsed, dest, branchRaw, parentDir, token).catch((error: unknown) => {
      job.state = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      job.finishedAt = Date.now()
    })

    writeJson(res, 200, { ok: true, value: serializeJob(job) })
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    'dsh-git-workspace: /gh-workspace routes',
  )

  ctx.logger?.info?.(`[dsh-git-workspace] clone 路由就绪：POST ${ROUTE_PREFIX}/clone`)
}

function serializeJob(job: CloneJob): Record<string, unknown> {
  return {
    id: job.id,
    repo: job.repo,
    state: job.state,
    percent: job.percent,
    detail: job.detail,
    path: job.path,
    method: job.method,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  }
}
