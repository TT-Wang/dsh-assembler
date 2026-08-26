// DOM 层考(verify_app 第六门)的器官——不是平行考官,是同一台考官的一只手。
//
// 命题(设计书 docs/ 阶段 3):五门全绿仍放行的三种死法全在 React 绑定层——
// ①挂载即死(#root 永远空白)②onClick 没接线 ③点了、库变了、页面不刷新。
// 补这一跳 = 考官真开页面(无头浏览器)、真填真点、真看效果(库效 + 回显)。
//
// 三个结构决定(与设计书一致):
// - 驱动器 = 考官 spawn generated/browser-automate 零件,经其 MCP 工具面驱动
//   (零件即考官的手;先例:行为考自拉 sqlite 零件打服务脸,从不 import 零件内脏)。
// - 考场 = 自带小服务器镜像生产路由(vite preview 的 sirv 拒绝 .service 点文件,
//   实证见设计书 §5;生产里伺服 dist 的本来就是 host,考场服务器是把生产拓扑
//   搬进考场,比 vite preview 更诚实)。
// - 效果断言与行为考同一份实现(assertEffect 注入,DOM 腿传轮询预算)——唯一的
//   区别是口令前缀 DOM-,防"行为考直打 SQL 造的行冒充页面点出来的行"的假 PASS。
//
// 本模块不 import scaffold.ts(避免环):共享件(makeSub/assertEffect/服务脸)
// 由调用方注入。
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ── 考卷校验(纯函数,单测主战场)──────────────────────────────────────────────

export interface DomStep { fill?: string; click?: string; value?: string }
export interface DomSpec { steps?: DomStep[]; expectText?: string }

/**
 * DOM 标注的机械闸:封闭词表(fill/click)、只许长在 face 动作上、区分口令闸
 * (steps 里必须有 fill 织入 @@TOKEN@@,且 effect/expectText 至少一处含 @@TOKEN@@)。
 * 区分口令闸是三闸里最关键的:行为考在同一次 verify 里已用直打 SQL 造过行,
 * 一个不带独立口令的 effect(如 WHERE id=1)会被那次直打满足——DOM 没点,断言
 * 照样绿。返回违例清单(空 = 过闸)。
 */
export function validateDomPaper(
  actions: Array<Record<string, unknown>>,
): string[] {
  const violations: string[] = []
  for (const a of actions) {
    const dom = a.dom as DomSpec | undefined
    if (dom === undefined) continue
    const name = String(a.name ?? '?')
    const route = String(a.route ?? '')
    if (route !== 'face') {
      violations.push(`动作「${name}」route=${route} 带了 dom 标注——v1 只考 face 动作的 DOM 一跳(wire 走同源 /api 代理未建、ai-thin 无区分口令载体,均登记在案);改标 face 或删掉 dom`)
      continue
    }
    const steps = Array.isArray(dom.steps) ? dom.steps : []
    if (steps.length === 0) {
      violations.push(`动作「${name}」dom.steps 为空——至少一步(fill/click)`)
      continue
    }
    for (const st of steps) {
      const keys = Object.keys(st as Record<string, unknown>).filter((k) => k !== 'value')
      const known = keys.filter((k) => k === 'fill' || k === 'click')
      if (keys.length !== 1 || known.length !== 1) {
        violations.push(`动作「${name}」的 step ${JSON.stringify(st)} 不合词表——只有 {fill:"<selector>",value:"..."} 与 {click:"<selector>"} 两种(拼错改对重验;要新交互词汇,那是考官升级,回 scaffold-dom 提)`)
      }
      if (typeof st.fill === 'string' && typeof st.value !== 'string') {
        violations.push(`动作「${name}」的 fill step 缺 value`)
      }
    }
    const fillsToken = steps.some((st) => typeof st.value === 'string' && st.value.includes('@@TOKEN@@'))
    const eff = a.effect as { sql?: string; sampleParams?: unknown[]; expect?: string } | undefined
    const effHasToken = JSON.stringify(eff ?? {}).includes('@@TOKEN@@')
    const expectTextHasToken = typeof dom.expectText === 'string' && dom.expectText.includes('@@TOKEN@@')
    if (!fillsToken || !(effHasToken || expectTextHasToken)) {
      violations.push(
        `动作「${name}」缺区分口令:steps 里必须有 fill 把 @@TOKEN@@ 织进输入,且 effect/expectText 至少一处含 @@TOKEN@@。`
        + '没有区分口令,行为考直打 SQL 造的行会满足这里的断言——DOM 没点,考卷照绿(假 PASS)。',
      )
    }
  }
  return violations
}

/** PAGE-SPEC 页 id ↔ src/pages 文件对应(pages-lint 用;防挂载考被回落页骗)。 */
export function pageIdFileMismatches(pageIds: string[], pageFiles: string[]): string[] {
  const files = new Set(pageFiles.map((f) => f.replace(/\.(tsx|jsx)$/, '')))
  const ids = new Set(pageIds)
  const out: string[] = []
  for (const id of pageIds) if (!files.has(id)) out.push(`PAGE-SPEC 页 id「${id}」没有对应的 src/pages/${id}.tsx(现有文件:${[...files].join(', ') || '无'})——App 的"找不到就回落首页"会让挂载考考错页`)
  for (const f of files) if (!ids.has(f)) out.push(`页面文件 src/pages/${f}.tsx 不在 PAGE-SPEC 里——没有考卷的页面不算交付`)
  return out
}

// ── 考场小服务器(镜像生产路由:静态 dist@base + .service 同源)────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json', '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

/**
 * 起考场:GET /assembler/ui/<id>/.service → 惰性读 presetDir/workspace/.service.json
 * (惰性是因为自拉零件在 DOM 门内才重写该文件——新端口新 token);其余按 dist
 * 静态伺服(路径穿越守卫)。逐字镜像 src/frontend.ts 的生产语义。
 */
export async function startExamServer(distDir: string, presetDir: string, presetId: string): Promise<{ port: number; base: string; close: () => void }> {
  const base = `/assembler/ui/${presetId}`
  const srv = createServer((req, res) => {
    const send = (code: number, text: string): void => {
      res.statusCode = code
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end(text)
    }
    if (req.method !== 'GET') return send(405, 'Method Not Allowed')
    let pathname: string
    try { pathname = new URL(req.url ?? '/', 'http://local').pathname } catch { return send(400, 'Bad Request') }
    if (pathname === `${base}/.service`) {
      const svcFile = join(presetDir, 'workspace', '.service.json')
      if (!existsSync(svcFile)) return send(404, 'no service faces')
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      return res.end(readFileSync(svcFile))
    }
    if (pathname !== base && !pathname.startsWith(`${base}/`)) return send(404, 'Not found')
    const rel = pathname === base || pathname === `${base}/` ? 'index.html' : pathname.slice(base.length + 1)
    const file = resolve(distDir, rel)
    if (!file.startsWith(resolve(distDir) + '/') && file !== resolve(distDir, 'index.html')) return send(404, 'Not found')
    const target = existsSync(file) && statSync(file).isFile() ? file : join(distDir, 'index.html')
    if (!existsSync(target)) return send(404, 'Not found')
    const dot = target.slice(target.lastIndexOf('.'))
    res.statusCode = 200
    res.setHeader('Content-Type', MIME[dot] ?? 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-store')
    return res.end(readFileSync(target))
  })
  await new Promise<void>((resolveListen, reject) => {
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => resolveListen())
  })
  const addr = srv.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  return { port, base, close: () => { try { srv.close() } catch { /* 已关 */ } } }
}

// ── 浏览器手(MCP 客户端包 browser-automate 零件)──────────────────────────────

export interface BrowserHand {
  open: (url: string) => Promise<string>
  click: (selector: string) => Promise<string>
  fill: (selector: string, value: string) => Promise<string>
  extract: (selector: string) => Promise<string>
  close: () => Promise<void>
}

const CALL_DEADLINE_MS = 30_000

/**
 * 拉起浏览器零件并包成手。拉不起(依赖未装/浏览器缺席)→ throw,由调用方判
 * SKIPPED 并给修法命令(考场不可用 ≠ app 坏)。
 */
export async function openBrowserHand(repoRoot: string): Promise<BrowserHand> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const c = new Client({ name: 'verify-app-dom', version: '0.0.1' })
  await c.connect(new StdioClientTransport({
    command: 'node',
    args: [join(repoRoot, 'generated', 'browser-automate', 'index.js')],
    env: process.env as Record<string, string>,
  }))
  const call = async (name: string, argsObj: Record<string, unknown>): Promise<string> => {
    const r = await c.callTool({ name, arguments: argsObj }, undefined, { timeout: CALL_DEADLINE_MS }) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
    const text = (r.content ?? []).map((b) => b.text ?? '').join('')
    if (r.isError === true) throw new Error(`${name}: ${text.slice(0, 300)}`)
    return text
  }
  return {
    open: (url) => call('browser-open', { url, waitUntil: 'domcontentloaded' }),
    click: (selector) => call('browser-click', { selector, timeout: 10_000 }),
    fill: (selector, value) => call('browser-fill', { selector, value, timeout: 10_000 }),
    extract: (selector) => call('browser-extract', { selector }),
    close: async () => { try { await c.close() } catch { /* 零件 EOF 自杀 */ } },
  }
}

// ── DOM 考本体 ────────────────────────────────────────────────────────────────

export interface DomExamDeps {
  /** 注入自 scaffold.ts 的共享件(与行为考一份实现;DI 避免模块环)。 */
  makeSub: (token: string) => (v: unknown) => unknown
  assertEffect: (
    face: { url: string; token: string },
    eff: { sql?: string; sampleParams?: unknown[]; expect?: string },
    sub: (v: unknown) => unknown,
    opts: { pollMs?: number; budgetMs?: number },
  ) => Promise<{ ok: boolean; hay: string }>
  acquireSqliteFace: (presetDir: string, phase: (l: string) => void) => Promise<{ face: { url: string; token: string } | null; kill: () => void }>
  sqliteFaceAlive: (f: { url: string; token: string } | null) => Promise<boolean>
}

export interface DomExamOpts {
  repoRoot: string
  distDir: string
  presetDir: string
  presetId: string
  pageIds: string[]
  actions: Array<Record<string, unknown>>
  phase: (line: string) => void
  deps: DomExamDeps
}

const MOUNT_BUDGET_MS = 8_000
const EFFECT_BUDGET_MS = 10_000
const GATE_SOFT_BUDGET_MS = 180_000

const pollUntil = async (budgetMs: number, stepMs: number, probe: () => Promise<boolean>): Promise<boolean> => {
  const t0 = Date.now()
  for (;;) {
    if (await probe()) return true
    if (Date.now() - t0 >= budgetMs) return false
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

/**
 * 跑 DOM 考。返回 status+evidence;SKIPPED 仅用于"考场不可用"(浏览器/依赖缺席)
 * 与骨架态,考卷病与页内证据不合一律 FAIL。
 */
export async function runDomExam(opts: DomExamOpts): Promise<{ status: 'PASS' | 'FAIL' | 'SKIPPED'; evidence: string }> {
  const { phase, deps } = opts
  // 1) 考卷校验(不开浏览器就能判——考卷病最便宜的失败)
  const paperViolations = validateDomPaper(opts.actions)
  if (paperViolations.length > 0) {
    return { status: 'FAIL', evidence: `DOM 考卷不合格:${paperViolations.slice(0, 3).join(';')}` }
  }
  if (opts.pageIds.length === 0) {
    return { status: 'SKIPPED', evidence: '骨架态(PAGE-SPEC 无页)——写页后重验' }
  }
  const domActions = opts.actions.filter((a) => a.dom !== undefined)
  // 2) 浏览器手(拉不起 = 考场不可用,SKIPPED 带修法)
  let hand: BrowserHand
  try {
    hand = await openBrowserHand(opts.repoRoot)
  } catch (error: unknown) {
    return {
      status: 'SKIPPED',
      evidence: `DOM 考场不可用(浏览器手拉不起:${(error instanceof Error ? error.message : String(error)).slice(0, 160)})——修法:cd ${opts.repoRoot}/generated/browser-automate && npm install && npx playwright install chromium;装了系统 Chrome 也行(零件自动回退)`,
    }
  }
  const exam = await startExamServer(opts.distDir, opts.presetDir, opts.presetId)
  const faceHold = domActions.some((a) => (a.effect as { sql?: string } | undefined)?.sql !== undefined)
    ? await deps.acquireSqliteFace(opts.presetDir, phase)
    : { face: null, kill: () => { /* 无 effect 断言,不需要脸 */ } }
  const results: string[] = []
  let fail = ''
  const t0 = Date.now()
  try {
    // 3) 考场自探(把"考场坏"与"app 坏"隔离在不同状态里)
    const ready = await pollUntil(5_000, 200, async () => {
      try { return (await fetch(`http://127.0.0.1:${String(exam.port)}${exam.base}/`, { signal: AbortSignal.timeout(1500) })).ok } catch { return false }
    })
    if (!ready) return { status: 'SKIPPED', evidence: 'DOM 考场服务器自探不过(考官侧故障,非 app 责任)——重验一次;复现则报告仓库' }
    const pageUrl = (id: string): string => `http://127.0.0.1:${String(exam.port)}${exam.base}/#${id}`
    // 4) 挂载死活考(每页,无条件——"全不标注"路线下 DOM 层的保底覆盖)
    for (const pid of opts.pageIds) {
      if (Date.now() - t0 > GATE_SOFT_BUDGET_MS) { results.push(`⚠ 挂载考「${pid}」未考(门级预算耗尽)`); continue }
      await hand.open(pageUrl(pid))
      const mounted = await pollUntil(MOUNT_BUDGET_MS, 300, async () => {
        try { return (await hand.extract('#root')).trim().length > 0 } catch { return false }
      })
      if (!mounted) { fail = `页「${pid}」挂载后根节点空白(JS 运行时死亡:模块顶层抛错/渲染异常——构建过、资产 200 都救不了它;开浏览器控制台看第一条红)`; break }
      results.push(`挂载「${pid}」✓`)
    }
    // 5) 逐动作 DOM 考(fill/click → 库效(轮询)→ 回显(轮询))
    if (fail === '') {
      for (const a of domActions) {
        if (Date.now() - t0 > GATE_SOFT_BUDGET_MS) { results.push(`⚠ dom 动作「${String(a.name ?? '?')}」未考(门级预算耗尽)`); continue }
        const name = String(a.name ?? '?')
        const page = String(a.page ?? opts.pageIds[0] ?? '')
        const dom = a.dom as DomSpec
        const token = `DOM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
        const sub = deps.makeSub(token)
        await hand.open(pageUrl(page))
        try {
          for (const st of dom.steps ?? []) {
            if (typeof st.fill === 'string') await hand.fill(st.fill, String(sub(st.value ?? '')))
            else if (typeof st.click === 'string') await hand.click(st.click)
          }
        } catch (error: unknown) {
          fail = `dom 动作「${name}」:${(error instanceof Error ? error.message : String(error)).slice(0, 200)}(selector 找不到/多匹配/不可见——对照页面源码里的 id)`
          break
        }
        const eff = a.effect as { sql?: string; sampleParams?: unknown[]; expect?: string } | undefined
        if (eff?.sql !== undefined) {
          if (!(await deps.sqliteFaceAlive(faceHold.face)) || faceHold.face === null) { fail = `dom 动作「${name}」:效果断言要读 sqlite 面,服务脸不可达(考官已尝试自拉)`; break }
          const res = await deps.assertEffect(faceHold.face, eff, sub, { budgetMs: EFFECT_BUDGET_MS, pollMs: 500 })
          if (!res.ok) { fail = `dom 动作「${name}」:点了但库没变(${String(EFFECT_BUDGET_MS / 1000)}s 内效果断言未含「${String(eff.expect)}」,实得 ${res.hay.slice(0, 120)})——onClick 没接线,或 SDK 调用没发出去`; break }
        }
        if (typeof dom.expectText === 'string') {
          const wantText = String(sub(dom.expectText))
          const shown = await pollUntil(EFFECT_BUDGET_MS, 400, async () => {
            try { return (await hand.extract('#root')).includes(wantText) } catch { return false }
          })
          if (!shown) { fail = `dom 动作「${name}」:点了、${eff?.sql !== undefined ? '库也变了、' : ''}页面没回显「${wantText}」(状态没刷新——写库后要重新拉取/渲染)`; break }
        }
        results.push(`dom「${name}」✓(真填真点→${eff?.sql !== undefined ? '库效✓' : ''}${typeof dom.expectText === 'string' ? '回显✓' : ''})`)
      }
    }
    // 6) 覆盖率出声(不判负不静默)
    const face2 = opts.actions.filter((a) => String(a.route ?? '') === 'face')
    const covered = face2.filter((a) => a.dom !== undefined).length
    if (fail === '') {
      const uncovered = face2.filter((a) => a.dom === undefined).map((a) => String(a.name ?? '?'))
      results.push(`dom 标注覆盖 ${String(covered)}/${String(face2.length)} 个 face 动作${uncovered.length > 0 ? `;未覆盖(DOM 层未验,登记):${uncovered.slice(0, 6).join('、')}` : ''}`)
    }
    return fail !== '' ? { status: 'FAIL', evidence: fail } : { status: 'PASS', evidence: results.join(';') }
  } finally {
    faceHold.kill()
    exam.close()
    await hand.close()
  }
}
