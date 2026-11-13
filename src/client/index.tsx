/**
 * @dsh-external/dsh-git-workspace — client 半。
 *
 * 接管 ui-workspace 声明的两个 directory-flow 单占洞，把原来的目录浏览
 * 对话框换成「本地目录 / GitHub 仓库」双来源对话框。
 *
 * 洞的契约（来自 ui-workspace / directory-picker-browse 实现）：
 *   props: open, busy, onPicked(path), onCancel(), onError(err)
 *   inject: t, listDirectory, createDirectory, pickNativeDirectory
 * 本实现只消费 open / busy / onPicked / onCancel：错误留在对话框内显示，
 * 不驱动 owner 的 onError arm（与内置 browse 一致）。
 *
 * 遮蔽规则来自 dsh-client-ui-slots 的 single 分支：同 priority 二次注册会抛错，
 * 不同 priority 按升序投影取胜者。内置 browse 用默认 0，这里用负数接管。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

const LOCALE_NS = 'github-workspace'
const CLONE_ENDPOINT = '/gh-workspace/clone'
/**
 * 远低于内置 browse（默认 0）与任何已知占用者。实测洞里存在 priority -1 的
 * 注册（error 文案里的 "registered by Gb"），所以 -1 不够低，用 -1000 打底，
 * 每次 apply 再递减一档，既保证胜出也不会撞同优先级。
 */
const DEPTH_PRIORITY = -1000

/**
 * 每次 apply 递减一档。装配器的动态注入与启动自动恢复可能让 apply 跑多遍，
 * 而 single 洞对同优先级二次注册是硬抛错。让每份注册各占一档后：
 * 全部注册成功，投影取最小者渲染；任一份被 dispose 回收，另一份仍然在。
 */
let applyGeneration = 0

const zh = {
  title: '添加工作区',
  tabLocal: '本地目录',
  tabGithub: 'Git 仓库',
  localHint: '填写一个已存在的目录绝对路径，也可以用系统文件夹选择器。',
  localPlaceholder: '例如 D:\\projects\\my-repo',
  pickNative: '选择文件夹…',
  open: '使用此目录',
  repoLabel: '仓库地址',
  repoHint: '支持 owner/repo（默认 GitHub）、https://、ssh:// 与 git@host:path，任意 Git 服务器都可以。',
  repoPlaceholder: 'deepseek-ai/DeepSeek-Harness 或 https://gitlab.com/group/repo',
  branchLabel: '分支',
  branchPlaceholder: '留空使用默认分支',
  parentLabel: '克隆到',
  parentPlaceholder: '留空使用默认目录',
  clone: '克隆并添加',
  cloning: '正在克隆…',
  cancel: '取消',
  errPathRequired: '请先填写目录路径。',
  errRepoRequired: '请先填写仓库。',
  errPickUnavailable: '当前环境没有系统文件夹选择器，请直接填写路径。',
  errClone: '克隆失败。',
  loading: '加载中…',
  emptyDir: '这里没有子目录。',
  cloningTitle: '正在克隆仓库',
  cloneFailed: '克隆失败',
  cancelled: '已取消',
  dismiss: '关闭',
  tokenLabel: '访问令牌',
  tokenHint: '留空则复用本机 git 凭据（如 Windows 凭据管理器的 credential.helper）。需要指定账号时再填该服务器的 Personal Access Token，按仓库地址的主机注入，只用于本次克隆，不保存。',
  tokenPlaceholder: '留空使用本机凭据，或填 ghp_… / glpat-… 等',
}

const en = {
  title: 'Add Workspace',
  tabLocal: 'Local folder',
  tabGithub: 'Git repository',
  localHint: 'Enter an existing absolute folder path, or use the system folder picker.',
  localPlaceholder: 'e.g. D:\\projects\\my-repo',
  pickNative: 'Choose folder…',
  open: 'Use this folder',
  repoLabel: 'Repository',
  repoHint: 'owner/repo (GitHub), https://, ssh:// or git@host:path — any Git server works.',
  repoPlaceholder: 'deepseek-ai/DeepSeek-Harness or https://gitlab.com/group/repo',
  branchLabel: 'Branch',
  branchPlaceholder: 'Leave empty for the default branch',
  parentLabel: 'Clone into',
  parentPlaceholder: 'Leave empty for the default folder',
  clone: 'Clone and add',
  cloning: 'Cloning…',
  cancel: 'Cancel',
  errPathRequired: 'Enter a folder path first.',
  errRepoRequired: 'Enter a repository first.',
  errPickUnavailable: 'No system folder picker in this environment; type the path instead.',
  errClone: 'Clone failed.',
  loading: 'Loading…',
  emptyDir: 'No subfolders here.',
  cloningTitle: 'Cloning repository',
  cloneFailed: 'Clone failed',
  cancelled: 'Cancelled',
  dismiss: 'Dismiss',
  tokenLabel: 'Access token',
  tokenHint: 'Leave empty to reuse the local git credential helper (e.g. Windows Credential Manager). Fill a personal access token for that server only when you need a specific account; it is injected for the repository host, used once, never stored.',
  tokenPlaceholder: 'Empty = local credentials, or ghp_… / glpat-…',
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 4000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.45)',
  } as const,
  dialog: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    width: '560px',
    maxWidth: '92vw',
    maxHeight: '86vh',
    overflowY: 'auto',
    padding: '20px',
    borderRadius: '16px',
    background: 'Canvas',
    color: 'CanvasText',
    boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
    font: 'inherit',
  } as const,
  title: { margin: 0, fontSize: '16px', fontWeight: 600 } as const,
  tabs: { display: 'flex', gap: '6px' } as const,
  tab: (active: boolean) =>
    ({
      appearance: 'none',
      border: '1px solid transparent',
      borderRadius: '8px',
      padding: '6px 14px',
      cursor: 'pointer',
      font: 'inherit',
      fontWeight: active ? 600 : 400,
      color: 'inherit',
      background: active ? 'rgba(127,127,127,0.22)' : 'transparent',
      borderColor: active ? 'rgba(127,127,127,0.35)' : 'transparent',
    }) as const,
  hint: { fontSize: '12px', opacity: 0.62, margin: 0 } as const,
  field: { display: 'flex', flexDirection: 'column', gap: '5px' } as const,
  label: { fontSize: '12px', fontWeight: 600, opacity: 0.78 } as const,
  input: {
    boxSizing: 'border-box',
    width: '100%',
    padding: '8px 10px',
    borderRadius: '8px',
    border: '1px solid rgba(127,127,127,0.36)',
    background: 'Field',
    color: 'FieldText',
    font: 'inherit',
    fontSize: '13px',
  } as const,
  error: {
    margin: 0,
    padding: '8px 10px',
    borderRadius: '8px',
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: '#ff8080',
    background: 'rgba(255,80,80,0.12)',
  } as const,
  footer: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } as const,
  listBox: {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '240px',
    overflowY: 'auto',
    border: '1px solid rgba(127,127,127,0.28)',
    borderRadius: '10px',
  } as const,
  listRow: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    appearance: 'none',
    border: 0,
    borderBottom: '1px solid rgba(127,127,127,0.14)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: '13px',
    padding: '8px 12px',
    cursor: 'pointer',
  } as const,
  listMeta: { fontSize: '11px', opacity: 0.6, padding: '8px 12px' } as const,
  floating: {
    position: 'fixed',
    right: '18px',
    bottom: '18px',
    zIndex: 4001,
    width: '330px',
    maxWidth: '90vw',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '14px 16px',
    borderRadius: '12px',
    background: 'Canvas',
    color: 'CanvasText',
    border: '1px solid rgba(127,127,127,0.28)',
    boxShadow: '0 12px 36px rgba(0,0,0,0.35)',
    fontSize: '13px',
  } as const,
  floatingHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } as const,
  floatingTitle: { fontWeight: 600, fontSize: '13px' } as const,
  floatingClose: {
    appearance: 'none',
    border: 0,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '16px',
    lineHeight: 1,
    opacity: 0.65,
    padding: 0,
  } as const,
  floatingRepo: { fontSize: '12px', opacity: 0.72, wordBreak: 'break-word' } as const,
  progressTrack: {
    height: '6px',
    borderRadius: '3px',
    background: 'rgba(127,127,127,0.25)',
    overflow: 'hidden',
  } as const,
  progressFill: {
    height: '100%',
    background: '#4a7dff',
    transition: 'width 0.3s ease',
  } as const,
  floatingMeta: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', opacity: 0.7 } as const,
}

type Translate = (key: string, params?: Record<string, unknown>) => string

interface DialogProps {
  open: boolean
  busy?: boolean
  onPicked: (path: string) => void
  onCancel: () => void
  t: Translate
  listDirectory?: (path: string, signal?: AbortSignal) => Promise<unknown>
  pickNativeDirectory?: () => Promise<string | undefined>
}

interface FloatingJobProps {
  job: any
  t: Translate
  onCancel: () => void
  onDismiss: () => void
}

/**
 * 克隆进度浮层：固定在右下角，不遮住主界面，用户可继续在 DSH 里操作。
 * 运行中只提供取消，失败后提供关闭。
 */
function FloatingJob(props: FloatingJobProps): any {
  const { job, t, onCancel, onDismiss } = props
  const raw = Number(job?.percent)
  const percent = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0
  const failed = job?.state === 'failed'
  const cancelled = job?.state === 'cancelled'

  return (
    <div style={styles.floating}>
      <div style={styles.floatingHead}>
        <span style={styles.floatingTitle}>
          {failed ? t('cloneFailed') : cancelled ? t('cancelled') : t('cloningTitle')}
        </span>
        <button
          type="button"
          style={styles.floatingClose}
          aria-label={failed || cancelled ? t('dismiss') : t('cancel')}
          onClick={failed || cancelled ? onDismiss : onCancel}
        >
          ×
        </button>
      </div>
      <div style={styles.floatingRepo}>{String(job?.repo ?? '')}</div>
      <div style={styles.progressTrack}>
        <div style={{ ...styles.progressFill, width: percent + '%' }} />
      </div>
      <div style={styles.floatingMeta}>
        <span>{failed ? t('cloneFailed') : String(job?.detail ?? '')}</span>
        <span>{percent}%</span>
      </div>
      {failed ? <p style={styles.error}>{String(job?.error ?? '')}</p> : null}
    </div>
  )
}

function WorkspaceSourceDialog(props: DialogProps): any {
  const { open, onPicked, onCancel, t, listDirectory, pickNativeDirectory } = props
  const ownerBusy = props.busy === true
  const [tab, setTab] = useState<'local' | 'github'>('local')
  const [localPath, setLocalPath] = useState('')
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [cloning, setCloning] = useState(false)
  const [listing, setListing] = useState<any>(null)
  const [listingBusy, setListingBusy] = useState(false)
  const [token, setToken] = useState('')
  const [job, setJob] = useState<any>(null)
  const submittedJobRef = useRef<string | null>(null)

  // 每次关闭后回到干净状态，避免上次失败的原因残留在界面上。
  useEffect(() => {
    if (open) return
    setTab('local')
    setLocalPath('')
    setRepo('')
    setBranch('')
    setParentDir('')
    setError(null)
    setCloning(false)
    setListing(null)
    setListingBusy(false)
    setJob(null)
    setToken('')
    submittedJobRef.current = null
  }, [open])

  /** 列一层目录；不传路径时列 Host 主目录。 */
  const load = useCallback(async (path?: string) => {
    if (typeof listDirectory !== 'function') return
    setListingBusy(true)
    setError(null)
    try {
      const result: any = await listDirectory(path as any)
      setListing(result ?? null)
      if (result && typeof result.path === 'string') setLocalPath(result.path)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setListingBusy(false)
    }
  }, [listDirectory])

  // 打开本地页签时自动列出主目录，省掉用户手打路径。
  useEffect(() => {
    if (!open || tab !== 'local' || listing !== null) return
    void load(undefined)
  }, [open, tab, listing, load])

  const submitLocal = useCallback(() => {
    const value = localPath.trim()
    if (value === '') {
      setError(t('errPathRequired'))
      return
    }
    setError(null)
    onPicked(value)
  }, [localPath, onPicked, t])

  const pickNative = useCallback(async () => {
    if (typeof pickNativeDirectory !== 'function') {
      setError(t('errPickUnavailable'))
      return
    }
    try {
      const picked = await pickNativeDirectory()
      if (typeof picked === 'string' && picked.trim() !== '') {
        setError(null)
        onPicked(picked.trim())
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [pickNativeDirectory, onPicked, t])

  const cloneRepo = useCallback(async () => {
    const value = repo.trim()
    if (value === '') {
      setError(t('errRepoRequired'))
      return
    }
    setCloning(true)
    setError(null)
    try {
      const response = await fetch(CLONE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repo: value,
          branch: branch.trim(),
          parentDir: parentDir.trim(),
          token: token.trim(),
        }),
      })
      const data: any = await response.json()
      if (data?.ok !== true) {
        throw new Error(data?.error?.message ?? t('errClone'))
      }
      setCloning(false)
      if (data.value?.state === 'done' && data.value?.path) {
        onPicked(String(data.value.path))
        return
      }
      // 任务已在 host 侧排程：对话框收成角落浮层，用户可继续操作 DSH。
      setJob(data.value)
    } catch (reason) {
      setCloning(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [repo, branch, parentDir, token, onPicked, t])

  // 进度轮询：依赖 job.id 与运行状态两个标量，百分比变化不会重建定时器。
  const jobId: string | undefined = job?.id
  const jobRunning = job?.state === 'running'
  useEffect(() => {
    if (jobId === undefined || !jobRunning) return
    const timer = setInterval(() => {
      void (async () => {
        try {
          const response = await fetch('/gh-workspace/job?id=' + encodeURIComponent(jobId))
          // 任务已被清理：停止轮询并收起浮层（jobId 变 undefined 会让 effect 清定时器）。
          if (response.status === 404) {
            setJob(null)
            return
          }
          if (!response.ok) return
          const data: any = await response.json()
          if (data?.ok === true && data.value) setJob(data.value)
        } catch {
          /* 单次失败继续轮询 */
        }
      })()
    }, 700)
    return () => clearInterval(timer)
  }, [jobId, jobRunning])

  // 完成即交回 owner 注册为工作区；用 ref 防严格模式下的重复提交。
  useEffect(() => {
    if (job === null || job.state !== 'done' || typeof job.path !== 'string') return
    if (submittedJobRef.current === job.id) return
    submittedJobRef.current = job.id
    onPicked(job.path)
  }, [job, onPicked])

  const cancelJob = useCallback(async () => {
    if (job === null) return
    const id = job.id
    setJob(null)
    try {
      await fetch('/gh-workspace/job/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
    } catch {
      /* 取消失败也先收起浮层 */
    }
    onCancel()
  }, [job, onCancel])

  // 恢复只在「打开」这一刻做一次。依赖 job 会让取消后立刻重新拉回同一个任务：
  // 取消时 host 要等子进程 close 才把 state 改成 cancelled，这期间 /jobs 仍返回它。
  const restoredRef = useRef(false)
  useEffect(() => {
    if (!open) {
      restoredRef.current = false
      return
    }
    if (restoredRef.current) return
    restoredRef.current = true
    void (async () => {
      try {
        const response = await fetch('/gh-workspace/jobs')
        const data: any = await response.json()
        const active = data?.ok === true ? data.value?.jobs : undefined
        if (Array.isArray(active) && active.length > 0) setJob(active[0])
      } catch {
        /* 没有进行中任务 */
      }
    })()
  }, [open])

  if (!open) return null

  if (job !== null) {
    return <FloatingJob job={job} t={t} onCancel={() => void cancelJob()} onDismiss={onCancel} />
  }

  // owner 在注册工作区期间会置 busy，必须并进来，否则按钮仍可点。
  const busy = cloning === true || ownerBusy

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.dialog} onClick={(event: any) => event.stopPropagation()}>
        <h2 style={styles.title}>{t('title')}</h2>

        <div style={styles.tabs}>
          <button type="button" style={styles.tab(tab === 'local')} onClick={() => setTab('local')}>
            {t('tabLocal')}
          </button>
          <button type="button" style={styles.tab(tab === 'github')} onClick={() => setTab('github')}>
            {t('tabGithub')}
          </button>
        </div>

        {tab === 'local' ? (
          <div style={styles.field}>
            <p style={styles.hint}>{t('localHint')}</p>
            <input
              style={styles.input}
              value={localPath}
              placeholder={t('localPlaceholder')}
              onChange={(event: any) => setLocalPath(event.target.value)}
              onKeyDown={(event: any) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submitLocal()
                }
              }}
            />
            {typeof pickNativeDirectory === 'function' ? (
              <div>
                <Button variant="outline" onClick={() => void pickNative()}>
                  {t('pickNative')}
                </Button>
              </div>
            ) : null}
            {listing !== null ? (
              <div style={styles.listBox}>
                {Array.isArray(listing.entries) && listing.entries.length > 0 ? (
                  listing.entries.map((entry: any) => (
                    <button
                      key={String(entry.path)}
                      type="button"
                      style={styles.listRow}
                      title={String(entry.path)}
                      onClick={() => void load(String(entry.path))}
                    >
                      {String(entry.name)}
                    </button>
                  ))
                ) : (
                  <div style={styles.listMeta}>{listingBusy ? t('loading') : t('emptyDir')}</div>
                )}
              </div>
            ) : listingBusy ? (
              <p style={styles.hint}>{t('loading')}</p>
            ) : null}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={styles.field}>
              <span style={styles.label}>{t('repoLabel')}</span>
              <input
                style={styles.input}
                value={repo}
                placeholder={t('repoPlaceholder')}
                disabled={busy}
                onChange={(event: any) => setRepo(event.target.value)}
              />
              <p style={styles.hint}>{t('repoHint')}</p>
            </div>
            <div style={styles.field}>
              <span style={styles.label}>{t('branchLabel')}</span>
              <input
                style={styles.input}
                value={branch}
                placeholder={t('branchPlaceholder')}
                disabled={busy}
                onChange={(event: any) => setBranch(event.target.value)}
              />
            </div>
            <div style={styles.field}>
              <span style={styles.label}>{t('parentLabel')}</span>
              <input
                style={styles.input}
                value={parentDir}
                placeholder={t('parentPlaceholder')}
                disabled={busy}
                onChange={(event: any) => setParentDir(event.target.value)}
              />
            </div>
            <div style={styles.field}>
              <span style={styles.label}>{t('tokenLabel')}</span>
              <input
                style={styles.input}
                type="password"
                autoComplete="off"
                value={token}
                placeholder={t('tokenPlaceholder')}
                disabled={busy}
                onChange={(event: any) => setToken(event.target.value)}
              />
              <p style={styles.hint}>{t('tokenHint')}</p>
            </div>
          </div>
        )}

        {error !== null ? <p style={styles.error}>{error}</p> : null}

        <div style={styles.footer}>
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            {t('cancel')}
          </Button>
          {tab === 'local' ? (
            <Button variant="primary" disabled={busy} onClick={submitLocal}>
              {t('open')}
            </Button>
          ) : (
            <Button variant="primary" disabled={busy} onClick={() => void cloneRepo()}>
              {busy ? t('cloning') : t('clone')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

type ClientContext = {
  slots: {
    inject: (name: string, factory: () => unknown) => () => void
    register: (spec: Record<string, unknown>, component: unknown) => () => void
  }
  uiWorkspace: {
    listDirectory: (path: string, signal?: AbortSignal) => Promise<unknown>
    createDirectory: (path: string, name: string) => Promise<unknown>
    /** 系统文件夹选择器；返回选中目录，取消时返回 null。 */
    pickDirectory?: () => Promise<string | null | undefined>
  }
  locale: {
    register: (ns: string, dictionaries: Record<string, Record<string, string>>) => () => void
    bind: (ns: string) => Translate
  }
  effect: (fn: () => unknown, label?: string) => () => void
}

export const inject = ['slots', 'uiWorkspace', 'locale']

export function apply(ctx: ClientContext): void {
  // 每次 apply 占一档更低的 priority，重复 apply 时不会撞上同优先级注册。
  const priority = DEPTH_PRIORITY - applyGeneration++

  ctx.effect(() => {
    try {
      return ctx.locale.register(LOCALE_NS, { zh, en })
    } catch {
      // 重复 apply（动态注入与启动自动恢复同时存活）时字典已由先者注册。
      return () => {}
    }
  }, 'dsh-git-workspace: dictionaries')

  const injected = () => {
    // 与 dsh-client-ui-directory-picker-native 相同的两级来源：
    // 先用桌面注入的 __DSH_DIRECTORY_PICKER__，没有就走 uiWorkspace.pickDirectory()。
    const picker: (() => Promise<string | null | undefined>) | undefined =
      typeof (globalThis as any).__DSH_DIRECTORY_PICKER__?.pick === 'function'
        ? () => (globalThis as any).__DSH_DIRECTORY_PICKER__.pick()
        : typeof ctx.uiWorkspace.pickDirectory === 'function'
          ? () => ctx.uiWorkspace.pickDirectory!()
          : undefined

    return {
      t: ctx.locale.bind(LOCALE_NS),
      listDirectory: (path: string, signal?: AbortSignal) => ctx.uiWorkspace.listDirectory(path, signal),
      createDirectory: (path: string, name: string) => ctx.uiWorkspace.createDirectory(path, name),
      pickNativeDirectory: picker,
    }
  }

  // 两个洞都占用：侧栏 Add workspace 与 Hero 的 workspace picker。
  // 结构与 dsh-client-ui-directory-picker-browse 一致：嵌套 slots.inject +
  // generator 逐个 yield register，由 slots 自己管理生命周期。
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      try {
        yield ctx.slots.register({
          name: 'conversation.hero.workspace.directoryFlow',
          priority,
          inject: injected,
        }, WorkspaceSourceDialog)
      } catch {
        /* 极端情况下（同 priority 已被占）保留先者，不带走整个 client 半 */
      }
      try {
        yield ctx.slots.register({
          name: 'sidebar.workspaces.directoryFlow',
          priority,
          inject: injected,
        }, WorkspaceSourceDialog)
      } catch {
        /* 同上 */
      }
    }),
  )
}
