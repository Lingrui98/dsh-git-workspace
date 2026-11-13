import { readFileSync } from 'node:fs'
import type { UserConfig } from 'tsdown'

/**
 * client bundle 的注册 id 必须等于 package.json 的 name。
 *
 * DSH 的 client-modules 把「包名」当作 boot graph 的 row id：浏览器端
 * ``arrive()`` 先执行初始 batch URL，再检查 ``factories`` 里有没有 ``row.id``
 * 的注册。注册 id 和 row id 不一致时，它判定这一行没注册成功，于是回退到
 * 「单包 URL」把同一个 bundle 第二次执行；第二次会撞上 ``register()`` 的
 * duplicate factory registration 硬报错，整个 web boot 失败，渲染层重试 3 次
 * 后放弃 —— DSH NEXT 直接退出。
 *
 * 历史上这里写死过一个与包名不一致的别名（先带 @dsh-external/ scope，包名去掉
 * scope 后没同步），正是 2026-10-28 DSH NEXT 启动崩溃的根因。
 * 现在从 package.json 派生：package.json name / cordis.patch.yml 的 id+name /
 * 本文件的注册 id 三处从此不会漂移。
 */
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { name?: unknown }

if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
  throw new Error('tsdown.config: package.json must declare a non-empty string "name"')
}

const PLUGIN_ID = pkg.name

const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [clientBundle] satisfies UserConfig[]
