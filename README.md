# dsh-github-workspace

在 DeepSeek Harness 的「新建工作区」按钮上，加一个「从 Git 仓库创建」的来源。

点侧栏的 **Add workspace**（或新会话 Hero 里的工作区选择器），弹出的不再是原来的目录浏览对话框，
而是两个页签：**本地目录** 和 **Git 仓库**。填仓库地址，插件把仓库拉到本地，
再把路径交回给原生工作区流程，最后和手动选目录一样出现在工作区列表里。

## 支持的仓库地址

| 形式 | 例子 | 说明 |
| --- | --- | --- |
| 短格式 | `deepseek-ai/DeepSeek-Harness` | 默认 github.com |
| HTTPS | `https://gitlab.com/group/repo`、`https://gitee.com/owner/repo.git` | 任意 Git 服务器，可带端口 |
| SSH 协议 | `ssh://git@gitlab.com/group/repo.git` | 走本机 SSH key |
| SCP 风格 | `git@github.com:owner/repo.git` | 走本机 SSH key |
| git 协议 | `git://example.com/team/repo.git` | 只读协议 |

目标目录名取自地址的最后一段（去掉 `.git`），冲突时直接复用已有目录。

明确拒绝 `file://`、本地绝对路径、`../` 与 `~` 开头的输入 —— 这不是 clone 本地目录的入口。

## 它接管了什么

DSH 的工作区新增入口由 `@deepseek-ai/dsh-client-ui-workspace` 声明成两个「单占洞」：

| 入口 | 洞名 |
| --- | --- |
| 侧栏 Add workspace | `sidebar.workspaces.directoryFlow` |
| 新会话 Hero 的工作区选择器 | `conversation.hero.workspace.directoryFlow` |

插件的浏览器半同时占用这两个洞。洞的契约是「每次打开回报一个本地绝对路径」，
所以本插件不碰工作区注册表，克隆完调用 `onPicked(path)` 即可。

### 和内置目录浏览器的关系

内置的 `@deepseek-ai/dsh-client-ui-directory-picker-browse` 也占这两个洞，注册优先级是默认 0。
`dsh-client-ui-slots` 对 `single` 洞的规则是：同优先级再注册会直接抛错，不同优先级按升序投影取胜者。
本插件用 **priority -1** 接管，所以原来的应用内目录浏览对话框不再显示。

卸载本插件后遮蔽消失，内置对话框自动恢复 —— 不需要改 profile 配置。

## 仓库怎么拉下来

host 半按两级尝试：

1. **git clone**（`--depth 1`，可指定分支）。git 可执行文件按以下顺序探测：
   - 环境变量 `DSH_GIT_EXE`
   - `C:\Program Files\Git\cmd\git.exe`、`C:\Program Files\Git\bin\git.exe`、
     `C:\Program Files (x86)\Git\cmd\git.exe`、`%LOCALAPPDATA%\Programs\Git\cmd\git.exe`
   - 类 Unix：`/usr/bin/git`、`/usr/local/bin/git`、`/opt/homebrew/bin/git`
   - 最后回退到 PATH 里的裸 `git`（`git --version` 探测）
2. **codeload tarball 兜底 —— 仅 GitHub**：git 不存在或 clone 失败时，下载
   `https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>`，用系统 `tar` 解压并剥掉顶层目录。

> 非 GitHub 主机（GitLab、Gitee、自建服务器）**只有 git 一条路径**：它们没有等价的公开归档接口，
> 找不到 git 时会直接报错并提示安装 git，而不是悄悄降级。
> tarball 结果没有 `.git` 目录，后续 git 操作需要用户自己 `git init`。

拉取目标默认是 `~/.dsh/github-workspaces/<repo>`；在对话框里填「克隆到」可以改父目录（该目录必须已存在）。

## 后台任务、进度与角落浮层

克隆不再是阻塞式请求。点「克隆并添加」后：

1. host 立即返回一个 `jobId`，实际拉取在后台跑。
2. 对话框收成**右下角浮层**，显示仓库名、进度条、百分比和阶段文字。
3. 浮层用 `position: fixed`，不遮住主界面，用户可以继续在 DSH 里做别的事。
4. 任务完成后浮层消失，路径交给 ui-workspace 注册成工作区。

进度来自 `git clone --progress` 的 stderr 百分比解析；走 tarball 时按 `content-length` 折算下载进度（15%–90%），解压阶段固定 92%。

页面重载后进行中的任务不会丢：打开对话框时先查 `GET /gh-workspace/jobs`，有活跃任务就恢复浮层。

> 洞契约要求 `open` 保持 true 直到回报路径，所以浮层期间 `open` 不变 —— 用户点浮层的 × 等同于取消（`onCancel`）。

## 私有仓库凭据

克隆私有仓库有三条路，按优先级：

1. **复用的本机 git 凭据（默认）**：token 留空时，插件不覆盖 `credential.helper`，git 会照常调用你本机配置的凭据助手。本机是 `credential.helper = manager`（Git Credential Manager），凭据存在 Windows 凭据管理器里 —— 之前 `git clone` 能过，这里也能过。SSH 地址（`ssh://`、`git@host:path`）走本机 SSH key。
2. **环境变量**：`GITHUB_TOKEN` 或 `GH_TOKEN`。
3. **手动填 token**：「Git 仓库」页签底部的「访问令牌」，填该服务器的 Personal Access Token（GitHub `ghp_…`、GitLab `glpat-…` 等）。

手动填的凭据只用于本次克隆，**不落盘、不记录**，页面关闭即丢。token 通过 git 的 `GIT_CONFIG_*` 环境变量注入，
配置键按**仓库地址的实际主机**拼成 `http.https://<host>/.extraheader`，所以 GitHub / GitLab / 自建服务器都能用同一个输入框。
token **不进命令行参数**，不会出现在进程列表里，也不会写进 `.git/config`。GitHub 的 tarball 兜底同样支持，用 `Authorization: Bearer`。

权限范围：GitHub 需要 `repo` scope；GitLab 需要 `read_repository` 或 `api`。

认证类失败会单独提示：`git` 输出里出现 `Authentication failed` / `could not read Username` / `Repository not found` / `403` 时，
浮层会直接告诉你"本机凭据没覆盖该仓库，请填令牌"，而不是丢一段原始 stderr。

## 路由

host 半注册一组仅限回环的 HTTP 路由：

```
POST /gh-workspace/clone        { repo, branch?, parentDir?, token? } -> { job }
GET  /gh-workspace/job?id=xxx   -> { job }
POST /gh-workspace/job/cancel   { id } -> { cancelled }
GET  /gh-workspace/jobs         -> { jobs }   仅进行中的任务

job = { id, repo, state, percent, detail, path?, method?, error? }
state ∈ running | done | failed | cancelled
```

非回环请求一律 403。目标目录已存在且非空时任务立即标记 `done`，`method` 为 `existing`。
完成的任务保留 10 分钟供客户端取结果，之后自动清理。

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_GITHUB_WORKSPACE_ROOT` | `~/.dsh/github-workspaces` | 默认克隆父目录 |
| `DSH_GIT_EXE` | 空 | 显式指定 git 可执行文件路径 |
| `GITHUB_TOKEN` / `GH_TOKEN` | 空 | 私有仓库凭据，低于手动填写 |

## 平台支持

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Desktop（Windows/macOS/Linux） | 支持 | 系统文件夹选择器可用时显示按钮 |
| Web（`dsh web`，浏览器访问） | 支持 | 用内置目录浏览；`pickDirectory` 不可用时不显示按钮 |

代码层面本来就是 Web 形态：

- `dsh.client.platform` 是 `web`，client bundle 走 Module Loader，desktop 与 web 共用同一份。
- host 半只依赖 node 内置模块（`child_process` / `fs` / `path` / `os` / `crypto`），没有任何 DSH 内部 API 依赖。
- git / tar 可执行文件按「环境变量 → 常见安装路径 → PATH 里的裸命令」三级探测，Linux 容器和 nix 环境同样能找到。

### 仅本机页面可调用

所有路由拒绝非回环来源，**没有开关**。除此之外还有三道针对浏览器攻击的防线：

| 防线 | 挡住什么 |
| --- | --- |
| `Host` 必须是 `127.0.0.1` / `localhost` / `[::1]` | DNS rebinding（任意域名解析到回环） |
| POST 必须 `content-type: application/json` | 跨站简单请求：非简单类型会触发 preflight，而本服务不响应 preflight |
| `Origin` 存在时必须是回环源 | 同源策略覆盖不到的场景 |

只看 `socket.remoteAddress` 是不够的 —— 跨站请求同样从 127.0.0.1 出发。

另外两条写入约束：

- 用户指定的 `parentDir` **必须已存在且是目录**，不会替调用方创建任意路径。
- 同时最多 3 个克隆任务，超出的请求返回 429。

需要从别的设备使用时，走 SSH 隧道把端口转回本地，remoteAddress 仍然是回环：

```bash
ssh -L 52280:127.0.0.1:52280 user@host
```

### Web 端的系统文件夹选择器

Web 端通常没有 `pickDirectory`，本地页签只显示路径输入和内置目录浏览。这是预期行为，不是故障。

## 安装

```bash
# 从 npm
dsh plugin --profile web add dsh-github-workspace

# 从 GitHub 源码
dsh plugin --profile web add github:OWNER/dsh-github-workspace

# 从本地目录（开发）
dsh plugin --profile web add /absolute/path/to/dsh-github-workspace
```

装完重启 GUI / `dsh web`。host 行由 `cordis.patch.yml` 声明，client 由 `dsh.client` 声明驱动。

## 发布

```bash
npm run build:all      # host → lib/index.js，client → lib/client.js
npm pack               # 产出 tgz
npm publish            # 或 gh release create v0.1.0 <tgz>
```

`files` 只包含 `lib`、`cordis.patch.yml`、`README.md`、`LICENSE`。<br>
包名是无 scope 的 `dsh-github-workspace`，`package.json` 的 `name` 与 `cordis.patch.yml` 的 `id` / `name` 必须一致。
client bundle 的 `__ModuleLoader__.load({ id })` 注册 id 由 `tsdown.config.ts` 从 `package.json.name` 派生，**禁止手写别名**：
DSH 的 client-modules 用包名当 boot graph 的 row id，注册 id 不一致会让同一个 bundle 被执行两遍，
撞上 `duplicate factory registration`，整个 web boot 失败、渲染层恢复耗尽后 DSH NEXT 直接退出
（2026-10-28 的启动崩溃就是写死的旧别名 `@dsh-external/dsh-github-workspace` 引起的）。

## 构建

本机没有 DSH 源码 checkout，构建只依赖本地安装的 TypeScript：

```bash
npm install
node node_modules/typescript/bin/tsc -p tsconfig.json   # host 半 → lib/index.js
npm run build:client                                     # client 半 → lib/client.js
```

装配（桌面 profile）：

```text
dev_install_package { dir: "C:/Users/admin/Documents/dsh-infra/plugins/dsh-github-workspace", profile: "desktop" }
```

装配器默认往 `profiles/web` 注入，而桌面 GUI 跑的是 `profiles/desktop` —— 必须显式指定 `profile: "desktop"`，
否则重启后 client 半不会被加载。

## 已知限制

- 接管是全局的：只要本插件在，内置目录浏览对话框就不出现，本地目录只能靠路径输入或系统选择器。
- 本地目录页签的系统选择器依赖 `__DSH_DIRECTORY_PICKER__` 或 `uiWorkspace.pickDirectory()`，两者都没有时只显示路径输入和目录列表；
  非 Windows 桌面环境只显示路径输入框。
- 只支持公开仓库；私有仓库需要凭据，当前没有做认证注入。
- tarball 路径上限 256 MB，单次操作超时 5 分钟。
