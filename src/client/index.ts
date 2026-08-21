/**
 * 装配器的浏览器半区(client half):向 dsh-better-sidebar 注册「装配直播台」tab,
 * 并在检测到新装配开跑时自动弹出——"assemble 一开工,直播台就在右侧栏跳出来"。
 *
 * 依赖面刻意最小:
 *  - cordis inject ['betterSidebar'] —— 底座未装时本半区永不激活,host 半区与
 *    独立直播台页(/assembler/ui/_console)完全不受影响(优雅缺席,不是报错)。
 *  - tab 内容 = iframe 装我们已有的直播台页——单一事实源,侧栏与独立页永远同一份 UI。
 *  - 自动弹出 = 轮询 /assembler/ui/_console/data:发现"链尾未到完成行且 mtime
 *    新鲜"的装配即 openTab(single 去重 ⇒ 已开则聚焦,不轰炸)。
 *
 * 打包契约(见 scripts/build-client.mjs):esbuild CJS + __ModuleLoader__.load
 * 包裹,react 经 factory 的 require 由 host 共享图供给——与 genui 同款制式。
 */
import { createElement as h } from 'react'

const TAB_TYPE = 'dsh-assembler:console'
const CONSOLE_URL = '/assembler/ui/_console'
const DATA_URL = '/assembler/ui/_console/data'
/** mtime 比现在早这么多秒以内算"正在进行"(direct feed 心跳约 1.5s,给足余量)。 */
const FRESH_WINDOW_S = 20

interface ProgressItem { id: string; mtime: number; tail: string }

interface BetterSidebarLike {
  registerTab: (d: Record<string, unknown>) => () => void
  openTab: (seed: { type: string; id: string; title: string }) => void
}

interface CtxLike {
  betterSidebar: BetterSidebarLike
  effect: (fn: () => () => void, label?: string) => void
}

export const inject = ['betterSidebar']

export function apply(ctx: CtxLike): void {
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: TAB_TYPE,
    title: () => '装配直播台',
    icon: (size: number) => h('span', { style: { fontSize: Math.round(size * 0.85), lineHeight: 1 } }, '🛠'),
    order: 45,
    single: true,
    component: () => h('iframe', {
      src: CONSOLE_URL,
      title: '装配直播台',
      style: { width: '100%', height: '100%', border: '0', display: 'block', background: 'transparent' },
    }),
  }), 'assembler.client.console-tab')

  // 自动弹出环:每 2.5s 看一眼直播数据。同一次装配(id+mtime)只弹一次;
  // 数据端点不可达(装配器路由没挂 / headless)就静默——探测不是报错。
  const popped = new Map<string, number>()
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
      for (const item of items) {
        const running = !item.tail.includes('装配完成') && nowS - item.mtime < FRESH_WINDOW_S
        if (running && popped.get(item.id) !== item.mtime) {
          popped.set(item.id, item.mtime)
          try {
            ctx.betterSidebar.openTab({ type: TAB_TYPE, id: TAB_TYPE, title: '装配直播台' })
          } catch { /* openTab 失败不打断轮询 */ }
          break
        }
      }
    }
    const timer = window.setInterval(() => { void tick() }, 2500)
    void tick()
    return () => { window.clearInterval(timer) }
  }, 'assembler.client.auto-open')
}
