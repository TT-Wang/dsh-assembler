/**
 * 装配器的浏览器半区(client half):把装配的两块都放进 dsh-better-sidebar,
 * 让"装配过程"和"装好的 agent 操作台"都在右侧栏里,不再有页面单独跳出来。
 *
 *  1. 装配直播台(console tab):assemble 一开工就自动弹出,行动链实时滚。
 *  2. agent 操作台(agent tab):某次装配一完成,就把那个 agent 的操作前端
 *     (/assembler/ui/<id>)作为侧栏 tab 弹出——用户直接在侧栏操作装好的 agent,
 *     而不是另开一张独立页。一个通用 tab 类型,靠 openTab 的 meta 带上 presetId,
 *     组件读 meta 拼 iframe src,多个 agent 各占一个 tab。
 *
 * 依赖面刻意最小:cordis inject ['betterSidebar'] —— 底座未装时本半区永不激活,
 * host 半区与独立页(/assembler/ui/*)完全不受影响(优雅缺席,不是报错)。
 * tab 内容都是 iframe 装已有的同源页——单一事实源,侧栏与独立页永远同一份 UI。
 *
 * 打包契约(见 scripts/build-client.mjs):esbuild CJS + __ModuleLoader__.load
 * 包裹,react 经 factory 的 require 由 host 共享图供给——与 genui 同款制式。
 */
import { createElement as h } from 'react'

const CONSOLE_TAB = 'dsh-assembler:console'
const AGENT_TAB = 'dsh-assembler:agent'
const CONSOLE_URL = '/assembler/ui/_console'
const DATA_URL = '/assembler/ui/_console/data'
const FRONTEND_BASE = '/assembler/ui'
/** mtime 比现在早这么多秒以内算"正在进行"(链子自带 20s 心跳,两跳余量)。 */
const FRESH_WINDOW_S = 45
/** 装配完成后这么多秒内算"新鲜完成",才自动弹操作台(避免翻旧账把历史全弹出来)。 */
const FRESH_DONE_S = 40

interface ProgressItem { id: string; mtime: number; tail: string }

interface OpenSeed { type: string; id: string; title: string; meta?: Record<string, unknown> }
interface BetterSidebarLike {
  registerTab: (d: Record<string, unknown>) => () => void
  openTab: (seed: OpenSeed) => void
}

interface CtxLike {
  betterSidebar: BetterSidebarLike
  effect: (fn: () => () => void, label?: string) => void
}

const iframeOf = (src: string, title: string): unknown => h('iframe', {
  src,
  title,
  style: { width: '100%', height: '100%', border: '0', display: 'block', background: 'transparent' },
})

export const inject = ['betterSidebar']

export function apply(ctx: CtxLike): void {
  // ── tab 类型 1:装配直播台(单例,内容固定指向 _console)────────────────
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: CONSOLE_TAB,
    title: () => '装配直播台',
    icon: (size: number) => h('span', { style: { fontSize: Math.round(size * 0.85), lineHeight: 1 } }, '🛠'),
    order: 45,
    single: true,
    component: () => iframeOf(CONSOLE_URL, '装配直播台'),
  }), 'assembler.client.console-tab')

  // ── tab 类型 2:agent 操作台(每 agent 一个,内容按 meta.presetId 定)──────
  // dedupeKey 按 tab.id ⇒ 同一 agent 重复打开只聚焦不新增;组件读 meta 拼 iframe。
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: AGENT_TAB,
    title: () => 'agent 操作台',
    icon: (size: number) => h('span', { style: { fontSize: Math.round(size * 0.85), lineHeight: 1 } }, '🤖'),
    order: 46,
    dedupeKey: (tab: { id?: string }) => tab.id ?? AGENT_TAB,
    component: (props: { tab?: { meta?: { presetId?: string } } }) => {
      const pid = props.tab?.meta?.presetId
      if (pid === undefined || pid === '') {
        return h('div', { style: { padding: 16, color: 'hsl(var(--muted-foreground))' } }, '未指定 agent')
      }
      return iframeOf(`${FRONTEND_BASE}/${pid}`, pid)
    },
  }), 'assembler.client.agent-tab')

  // ── 自动弹出环:每 2.5s 看一眼直播数据 ──────────────────────────────────
  // 开跑(未完成+mtime 新鲜)→ 弹直播台;完成(含"装配完成"+新鲜+真 preset id)
  // → 弹该 agent 的操作台。各自按 (id + mtime) 去重,一次只弹一次;数据端点不可达
  // (装配器路由没挂 / headless)就静默。
  const poppedConsole = new Map<string, number>()
  const poppedAgent = new Map<string, number>()
  ctx.effect(() => {
    const tick = async (): Promise<void> => {
      let items: ProgressItem[]
      try {
        const res = await fetch(DATA_URL, { cache: 'no-store' })
        if (!res.ok) return
        items = ((await res.json()) as { items?: ProgressItem[] }).items ?? []
      } catch {
        return
      }
      const nowS = Date.now() / 1000
      let consoleOpened = false
      for (const item of items) {
        const done = item.tail.includes('装配完成')
        // 开跑 → 直播台(临时链 _pending-xxxx 也算,选型阶段就弹出来盯着)
        if (!consoleOpened && !done && nowS - item.mtime < FRESH_WINDOW_S && poppedConsole.get(item.id) !== item.mtime) {
          poppedConsole.set(item.id, item.mtime)
          try { ctx.betterSidebar.openTab({ type: CONSOLE_TAB, id: CONSOLE_TAB, title: '装配直播台' }) } catch { /* 不打断轮询 */ }
          consoleOpened = true
        }
        // 新鲜完成 + 真 preset(排除 _pending / _solutions 等 _ 打头)→ 弹操作台
        if (done && !item.id.startsWith('_') && nowS - item.mtime < FRESH_DONE_S && poppedAgent.get(item.id) !== item.mtime) {
          poppedAgent.set(item.id, item.mtime)
          try {
            ctx.betterSidebar.openTab({ type: AGENT_TAB, id: `${AGENT_TAB}:${item.id}`, title: item.id, meta: { presetId: item.id } })
          } catch { /* openTab 失败不打断轮询 */ }
        }
      }
    }
    const timer = window.setInterval(() => { void tick() }, 2500)
    void tick()
    return () => { window.clearInterval(timer) }
  }, 'assembler.client.auto-open')
}
