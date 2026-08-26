/**
 * scaffold —— app 车道的唯一底盘(宪法第九条执行后,分叉已消)。
 *
 * 曾经的形态(git 备查):via:'recipe' 第六种零件,三张配方(rag-qa/record-desk/
 * scaffold-react)构成"成品配方 vs scaffold 写手席"双车道,车道闸负责逼选择。
 * 第九条判:分叉能靠只留一条路消掉就消——成品配方降级为写手可抄的范例
 * (template/examples/),独立进程拓扑归 ROADMAP 阶段 5,scaffold 从"目录里可选
 * 的配方"降为**装配器装备**(与 frontends/ 同性质:印刷底版,不是零件)。
 *
 * 三件事分工与 preset 车道同构:
 *   emit_app    = 哑实例化(确定性:拷模板 + app.config.json 注入参数 + npm
 *                 install;模板字节零替换 ⇒ 模板哈希有意义、写手自由区与骨架
 *                 边界清晰)
 *   verify_app  = 独立考官(自己拉起 app,五道门:构建/骨架锁/页面 lint/静态
 *                 可达/行为考;考完杀进程,不依赖 DSH host 存活)
 *   出厂门      = 同一台考官跑在 scaffold 自带的 sample/ 上(scripts/index-add.mjs
 *                 scaffold-gate):底盘改版必须自己先过考,防"底盘腐烂"。
 *
 * 设计裁定(沿承配方车道,仍然成立):
 * - 模板文件零替换:参数经 app.config.json 注入,模板字节稳定。
 * - 参数键过 SECRET 形状闸:值不检查,键长得像密钥即拒——密钥只走进程环境变量。
 * - 考卷是声明式 check(代码执行,非 LLM 判卷):安全往代码压。
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { runScenario, sanitizeMarks } from './verify.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SCAFFOLD_DIR = join(REPO, 'scaffold')

// 与 src/index.ts 的参数教义同款(键的形状即拒,值不看):密钥值只许走环境
// 变量;一个长得像密钥的参数键本身就是在邀请误用。
const SECRET_PARAM_RE = /(password|passwd|secret|token|api[-_]?key|access[-_]?key|credential|private[-_]?key|auth)/i

// ── 底盘清单 ────────────────────────────────────────────────────────────────

export interface ScaffoldParamSpec {
  key: string
  description: string
  required?: boolean
  default?: string
  example?: string
}

export interface ScaffoldCheck {
  /**
   * 五道门:build = run.build 零错误(先于起服执行);skeleton-lock = lockPaths
   * 哈希与实例化时一致(写手不许越自由区);pages-lint = src/pages 机械纪律
   * (禁裸 fetch/WebSocket/dangerouslySetInnerHTML/外链);static-reach = 静态
   * 产物真伺服(GET / 200 且含挂载点、引用资产逐个真取);behavior = 按
   * PAGE-SPEC 逐动作验——face 动作经配套 preset 的服务脸执行 sql 并跑 effect
   * 断言(零件不在场时考官自己拉起),wire 动作跑单轮场景探针(需 wirePort),
   * ai-thin 动作打 ai 服务脸一次补全(缺 key SKIPPED)。
   */
  kind: 'build' | 'skeleton-lock' | 'pages-lint' | 'static-reach' | 'behavior'
}

export interface ScaffoldSpec {
  id: string
  version: number
  description: string
  license: string
  /** 借鉴出处备注(供应链诚实:模式从哪学的)。 */
  inspiredBy?: string
  params: ScaffoldParamSpec[]
  requiredSecrets: Array<{ env: string; purpose: string }>
  run: {
    /** 确定性预计算(装配时预思考):实例化后立即执行(npm install)。 */
    ingest?: string[]
    /** 构建命令(argv):考官在起服前执行(build 门);写手改完页后的必经门。 */
    build?: string[]
    /** 启动命令(argv 形式,cwd = app 目录;'@@PORT@@' 由考官替换为实际端口)。 */
    start: string[]
    /** 就绪探测路径(GET 该路径 200 即认为已起)。 */
    readyPath: string
  }
  /** skeleton-lock 考的锁定面(相对 app 根的文件/目录清单):写手自由区之外的一切。 */
  lockPaths?: string[]
  selftest: { checks: ScaffoldCheck[] }
  /** 入库门用的样例实例化输入(params 全填 + 底盘内相对页面目录)。 */
  sample: { params: Record<string, string>; pagesDir?: string }
}

export function loadScaffold(scaffoldRoot: string = SCAFFOLD_DIR): ScaffoldSpec {
  const manifest = join(scaffoldRoot, 'scaffold.yml')
  if (!existsSync(manifest)) throw new Error(`scaffold 底盘不存在(找不到 ${manifest})`)
  const raw = (yaml.load(readFileSync(manifest, 'utf8')) ?? {}) as Partial<ScaffoldSpec>
  const spec: ScaffoldSpec = {
    id: String(raw.id ?? ''),
    version: typeof raw.version === 'number' ? raw.version : 0,
    description: String(raw.description ?? ''),
    license: String(raw.license ?? ''),
    ...(typeof raw.inspiredBy === 'string' ? { inspiredBy: raw.inspiredBy } : {}),
    params: Array.isArray(raw.params) ? raw.params as ScaffoldParamSpec[] : [],
    requiredSecrets: Array.isArray(raw.requiredSecrets) ? raw.requiredSecrets as ScaffoldSpec['requiredSecrets'] : [],
    ...(Array.isArray(raw.lockPaths) ? { lockPaths: raw.lockPaths.map(String) } : {}),
    run: (raw.run ?? {}) as ScaffoldSpec['run'],
    selftest: (raw.selftest ?? { checks: [] }) as ScaffoldSpec['selftest'],
    sample: (raw.sample ?? { params: {} }) as ScaffoldSpec['sample'],
  }
  if (spec.id === '') throw new Error('scaffold.yml 缺 id')
  if (spec.version < 1) throw new Error('scaffold.yml 缺 version(≥1 的整数,改模板必须升版本)')
  if (!Array.isArray(spec.run.start) || spec.run.start.length === 0) throw new Error('scaffold.yml 缺 run.start 启动命令')
  if (typeof spec.run.readyPath !== 'string' || !spec.run.readyPath.startsWith('/')) throw new Error('scaffold.yml 缺 run.readyPath 就绪探测路径')
  if (spec.selftest.checks.length === 0) throw new Error('scaffold.yml 缺 selftest.checks —— 没有考卷的底盘不许发货(验收永远归考官)')
  if (!existsSync(join(scaffoldRoot, 'template'))) throw new Error('scaffold 缺 template/ 目录')
  for (const p of spec.params) {
    if (SECRET_PARAM_RE.test(p.key)) throw new Error(`scaffold 参数键 ${p.key} 长得像密钥——密钥只许声明进 requiredSecrets(值走环境变量),不许做参数槽`)
  }
  return spec
}

// ── 实例化(哑印刷机)────────────────────────────────────────────────────────

export interface MaterializeInput {
  /** app 落地目录(绝对路径;不存在则创建;非空目录拒绝,除非 fresh)。 */
  targetDir: string
  params: Record<string, string>
  /** 页面目录(绝对路径),拷进 app 的 src/pages/(入库门样例页/写手成品迁入)。 */
  pagesDir?: string
  fresh?: boolean
  scaffoldRoot?: string
}

export interface MaterializeResult {
  targetDir: string
  scaffold: string
  version: number
  templateHash: string
  pendingSecrets: Array<{ env: string; purpose: string; configured: boolean }>
  lockPath: string
}

function walkFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walkFiles(p))
    else if (e.isFile()) out.push(p)
  }
  return out
}

/** 锁定面哈希:lockPaths 里的文件/目录(相对 app 根)全体字节,路径排序后逐个喂。 */
export function hashLockPaths(appDir: string, lockPaths: readonly string[]): string {
  const h = createHash('sha256')
  const files: string[] = []
  for (const rel of lockPaths) {
    const p = join(appDir, rel)
    if (!existsSync(p)) { h.update(`MISSING:${rel}\0`); continue }
    if (statSync(p).isDirectory()) files.push(...walkFiles(p))
    else files.push(p)
  }
  for (const f of files.sort()) {
    h.update(relative(appDir, f))
    h.update('\0')
    h.update(readFileSync(f))
  }
  return h.digest('hex').slice(0, 16)
}

/** 模板全体字节的稳定哈希(文件相对路径排序后逐个喂)——进 lock,底盘代际可核。 */
export function hashTemplate(templateDir: string): string {
  const h = createHash('sha256')
  for (const f of walkFiles(templateDir).sort()) {
    h.update(relative(templateDir, f))
    h.update('\0')
    h.update(readFileSync(f))
  }
  return h.digest('hex').slice(0, 16)
}

export function materializeApp(input: MaterializeInput): MaterializeResult {
  const scaffoldRoot = input.scaffoldRoot ?? SCAFFOLD_DIR
  const spec = loadScaffold(scaffoldRoot)
  const target = input.targetDir
  if (!target.startsWith('/')) throw new Error('emit_app: targetDir 必须是绝对路径(相对路径会解析进宿主进程 cwd)')
  const norm = resolve(target)
  if (norm === homedir() || norm === '/' || norm === REPO) throw new Error(`emit_app: 拒绝把 app 实例化到 ${norm}`)
  if (norm.startsWith(REPO + '/')) throw new Error('emit_app: targetDir 不许落在装配器仓库内(底盘是库存,实例是交付物,两者不混)')

  // 参数闸:键形状 + 必填齐全。缺哪些、每个是干什么的,一次说清(可行动错误)。
  for (const k of Object.keys(input.params)) {
    if (SECRET_PARAM_RE.test(k)) throw new Error(`emit_app: 参数键 ${k} 长得像密钥,拒绝——密钥只走启动环境变量(见 scaffold requiredSecrets),永不进 app 文件`)
  }
  const missing = spec.params.filter((p) => p.required !== false && (input.params[p.key] ?? '').trim() === '')
  if (missing.length > 0) {
    throw new Error(`emit_app: 缺必填参数:\n${missing.map((p) => `  - ${p.key}:${p.description}${p.example !== undefined ? `(如:${p.example}` : ''}${p.example !== undefined ? ')' : ''}`).join('\n')}`)
  }
  const params: Record<string, string> = {}
  for (const p of spec.params) {
    const v = (input.params[p.key] ?? p.default ?? '').trim()
    if (v !== '') params[p.key] = v
  }

  if (existsSync(norm) && readdirSync(norm).length > 0) {
    if (input.fresh !== true) throw new Error(`emit_app: ${norm} 非空。同址重印传 fresh:true(会清空该目录重来);要保留旧 app 就换个 targetDir`)
    rmSync(norm, { recursive: true, force: true })
  }
  mkdirSync(norm, { recursive: true })

  const templateDir = join(scaffoldRoot, 'template')
  cpSync(templateDir, norm, { recursive: true })

  if (input.pagesDir !== undefined && input.pagesDir !== '') {
    const pd = resolve(input.pagesDir)
    if (!pd.startsWith('/') || !existsSync(pd) || !statSync(pd).isDirectory()) throw new Error(`emit_app: pagesDir 不存在:${pd}`)
    cpSync(pd, join(norm, 'src', 'pages'), { recursive: true })
    // 约定:pagesDir 里的 PAGE-SPEC.yml 是这批页面的考卷,迁到 app 根(覆盖模板空卷)
    const movedSpec = join(norm, 'src', 'pages', 'PAGE-SPEC.yml')
    if (existsSync(movedSpec)) {
      cpSync(movedSpec, join(norm, 'PAGE-SPEC.yml'))
      rmSync(movedSpec)
    }
  }

  // 参数经配置文件注入(模板文件零替换 ⇒ 模板字节稳定、底盘哈希有意义)。
  writeFileSync(join(norm, 'app.config.json'), JSON.stringify({ scaffold: spec.id, ...params }, null, 2) + '\n')

  // 确定性预计算(装配时预思考):npm install 在实例化时跑完,写手上桌即可写页。
  if (Array.isArray(spec.run.ingest) && spec.run.ingest.length > 0) {
    try {
      execFileSync(spec.run.ingest[0] as string, spec.run.ingest.slice(1), { cwd: norm, encoding: 'utf8', timeout: 300_000 })
    } catch (error: unknown) {
      const e = error as { stderr?: string; stdout?: string; message?: string }
      throw new Error(`emit_app: ingest 失败——${(e.stderr ?? e.stdout ?? e.message ?? '').toString().slice(0, 400)}`)
    }
  }

  const templateHash = hashTemplate(templateDir)
  // 骨架锁:锁定面哈希入 lock,验收时重算——写手的自由区之外动一个字节都会被
  // skeleton-lock 考抓住。node_modules 不在 lockPaths 内。
  const skeletonHash = spec.lockPaths !== undefined ? hashLockPaths(norm, spec.lockPaths) : null
  const pendingSecrets = spec.requiredSecrets.map((sret) => ({ ...sret, configured: (process.env[sret.env] ?? '') !== '' }))
  const lock = {
    scaffold: spec.id,
    version: spec.version,
    templateHash,
    ...(skeletonHash !== null ? { skeletonHash } : {}),
    materializedAt: new Date().toISOString(),
    params,
    pendingSecrets: pendingSecrets.filter((sm) => !sm.configured).map((sm) => ({ env: sm.env, purpose: sm.purpose })),
  }
  const lockPath = join(norm, 'scaffold.lock.yml')
  writeFileSync(lockPath, yaml.dump(lock, { lineWidth: 120 }))
  return { targetDir: norm, scaffold: spec.id, version: spec.version, templateHash, pendingSecrets, lockPath }
}

// ── 考官(声明式考卷的确定性执行)────────────────────────────────────────────

export interface AppCheckResult { check: string; status: 'PASS' | 'FAIL' | 'SKIPPED'; evidence: string }
export interface AppSelftestResult {
  status: 'PASS' | 'FAIL' | 'SKIPPED'
  checks: AppCheckResult[]
  elapsedSeconds: number
  port: number
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolveP, rejectP) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      srv.close(() => { port > 0 ? resolveP(port) : rejectP(new Error('端口探测失败')) })
    })
    srv.on('error', rejectP)
  })
}

async function waitReady(base: string, path: string, timeoutMs: number): Promise<void> {
  const t0 = Date.now()
  let lastErr = ''
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(base + path, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
      lastErr = `HTTP ${String(res.status)}`
    } catch (error) {
      lastErr = error instanceof Error ? error.message : String(error)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`app 未在 ${String(Math.round(timeoutMs / 1000))}s 内就绪(${path} → ${lastErr})`)
}

/**
 * 独立考官:从 app 目录自己拉起进程、按底盘考卷黑盒考、考完必杀进程。
 * 同一台考官双岗:入库门(sample 实例)与交付验收(写手实例)。
 */
export async function runAppSelftest(
  targetDir: string,
  opts: {
    scaffoldRoot?: string
    onPhase?: (line: string) => void
    startTimeoutMs?: number
    askTimeoutMs?: number
    /** behavior 考:配套 preset 的根(默认 $DSH_HOME/.agent-presets)。 */
    presetRoot?: string
    /** behavior 考:wire 动作用的 host 端口;缺省时 wire 动作 SKIPPED(face 动作照考)。 */
    wirePort?: number
  } = {},
): Promise<AppSelftestResult> {
  const t0 = Date.now()
  const lockPath = join(targetDir, 'scaffold.lock.yml')
  if (!existsSync(lockPath)) throw new Error(`verify_app: ${targetDir} 没有 scaffold.lock.yml——这不是 emit_app 实例化出来的 app(先 emit_app)`)
  const lock = (yaml.load(readFileSync(lockPath, 'utf8')) ?? {}) as { scaffold?: string; params?: Record<string, string> }
  if (typeof lock.scaffold !== 'string') throw new Error('verify_app: scaffold.lock.yml 缺 scaffold 字段')
  const spec = loadScaffold(opts.scaffoldRoot)
  const params = lock.params ?? {}
  const port = await getFreePort()
  const base = `http://127.0.0.1:${String(port)}`
  const phase = (line: string): void => { opts.onPhase?.(line) }
  const preChecks: AppCheckResult[] = []

  // 构建门先于起服(preview 伺服的是 dist,必须先 build;失败带出编译器原文)
  if (spec.selftest.checks.some((c) => c.kind === 'build')) {
    if (!Array.isArray(spec.run.build) || spec.run.build.length === 0) {
      return { status: 'FAIL', checks: [{ check: 'build', status: 'FAIL', evidence: '底盘声明了 build 考但 run.build 缺失' }], elapsedSeconds: Math.round((Date.now() - t0) / 1000), port }
    }
    phase(`构建门:${spec.run.build.join(' ')}`)
    const tb = Date.now()
    try {
      execFileSync(spec.run.build[0] as string, spec.run.build.slice(1), { cwd: targetDir, encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] })
      preChecks.push({ check: 'build', status: 'PASS', evidence: `构建零错误(${String(Math.round((Date.now() - tb) / 1000))}s)` })
    } catch (error: unknown) {
      const e = error as { stderr?: string; stdout?: string; message?: string }
      const detail = `${String(e.stdout ?? '')}\n${String(e.stderr ?? '')}`.trim().slice(-600)
      return { status: 'FAIL', checks: [{ check: 'build', status: 'FAIL', evidence: `构建失败:${detail !== '' ? detail : String(e.message ?? '')}` }], elapsedSeconds: Math.round((Date.now() - t0) / 1000), port }
    }
  }

  const startArgv = spec.run.start.map((a) => a.replace(/@@PORT@@/g, String(port)))
  phase(`启动 app:${startArgv.join(' ')}(cwd=${targetDir},PORT=${String(port)})`)
  const child = spawn(startArgv[0] as string, startArgv.slice(1), {
    cwd: targetDir,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let childErr = ''
  child.stderr.on('data', (d: Buffer) => { childErr = (childErr + d.toString()).slice(-1000) })
  const checks: AppCheckResult[] = [...preChecks]
  try {
    try {
      await waitReady(base, spec.run.readyPath, opts.startTimeoutMs ?? 15_000)
    } catch (error) {
      const reason = `${error instanceof Error ? error.message : String(error)}${childErr !== '' ? `;stderr:${childErr.slice(-300)}` : ''}`
      return { status: 'FAIL', checks: [{ check: 'start', status: 'FAIL', evidence: reason }], elapsedSeconds: Math.round((Date.now() - t0) / 1000), port }
    }

    for (const c of spec.selftest.checks) {
      if (c.kind === 'build') {
        continue // 已在起服前执行(preChecks)
      } else if (c.kind === 'skeleton-lock') {
        const lockedHash = (lock as { skeletonHash?: string }).skeletonHash
        if (typeof lockedHash !== 'string' || spec.lockPaths === undefined) {
          checks.push({ check: 'skeleton-lock', status: 'FAIL', evidence: 'lock 里没有 skeletonHash(底盘缺 lockPaths?重新 emit_app)' })
          break
        }
        const now = hashLockPaths(targetDir, spec.lockPaths)
        const ok = now === lockedHash
        checks.push({
          check: 'skeleton-lock',
          status: ok ? 'PASS' : 'FAIL',
          evidence: ok ? `骨架/SDK/词汇字节未被越界改动(${lockedHash})` : `骨架被改动(${lockedHash} → ${now})——写手自由区只有 src/pages/ 与 PAGE-SPEC.yml,改骨架请回底盘升版本`,
        })
        if (!ok) break
      } else if (c.kind === 'pages-lint') {
        const pagesDir = join(targetDir, 'src', 'pages')
        const offenses: string[] = []
        // 页面实际用到的 SDK 出网口(路由一致性证据面)
        let usesFace = false
        let usesWire = false
        let usesAi = false
        if (existsSync(pagesDir)) {
          for (const f of walkFiles(pagesDir).filter((x) => /\.(tsx|ts|jsx|js)$/.test(x))) {
            const text = readFileSync(f, 'utf8')
            const rel = relative(targetDir, f)
            if (/sqliteFace|filesFace|face\(/.test(text)) usesFace = true
            if (/createClient|\.ask\(/.test(text)) usesWire = true
            if (/aiFace/.test(text)) usesAi = true
            for (const [re, why] of [
              [/(?<![.\w])fetch\s*\(/, '裸 fetch(出网必须经 @/sdk/assembler-sdk)'],
              [/new\s+WebSocket/, '裸 WebSocket(出网必须经 SDK)'],
              [/dangerouslySetInnerHTML/, 'dangerouslySetInnerHTML(注入面,禁)'],
              [/https?:\/\//, '外链 URL(离线交付,禁外部资源)'],
            ] as Array<[RegExp, string]>) {
              const m = re.exec(text)
              if (m !== null) offenses.push(`${rel}:${String(text.slice(0, m.index).split('\n').length)} ${why}`)
            }
          }
        }
        // 路由一致性闸(对抗审计后加):PAGE-SPEC 的 route 声明与页面实际使用的
        // SDK 出网口必须对得上——声明即得分的口子从"声明纸"缝到实现字节上。
        // 只做方向级一致(声明了某路由 → 对应 SDK 口必须在页面里出现;反之亦然),
        // 动作粒度的真伪仍归行为考。
        const specPath2 = join(targetDir, 'PAGE-SPEC.yml')
        if (existsSync(specPath2)) {
          try {
            const ps = (yaml.load(readFileSync(specPath2, 'utf8')) ?? {}) as { pages?: Array<{ actions?: Array<Record<string, unknown>> }> }
            const declared = { face: 0, wire: 0, 'ai-thin': 0 }
            for (const pg of ps.pages ?? []) for (const act of pg.actions ?? []) {
              const rt = String(act.route ?? '')
              if (rt in declared) declared[rt as keyof typeof declared] += 1
            }
            if (declared.face > 0 && !usesFace) offenses.push(`PAGE-SPEC 声明 ${String(declared.face)} 个 face 动作,页面却没有任何服务脸调用(sqliteFace/face()——声明与实现脱节`)
            if (declared.wire > 0 && !usesWire) offenses.push(`PAGE-SPEC 声明 ${String(declared.wire)} 个 wire 动作,页面却没有会话调用(createClient/.ask)`)
            if (declared['ai-thin'] > 0 && !usesAi) offenses.push(`PAGE-SPEC 声明 ${String(declared['ai-thin'])} 个 ai-thin 动作,页面却没有 aiFace 调用`)
            if (usesWire && declared.wire === 0) offenses.push('页面用了会话口(createClient/.ask)但 PAGE-SPEC 零 wire 声明——漏报路由')
            if (usesFace && declared.face === 0) offenses.push('页面用了服务脸但 PAGE-SPEC 零 face 声明——漏报路由')
          } catch { /* 考卷坏由 behavior 考报 */ }
        }
        checks.push({
          check: 'pages-lint',
          status: offenses.length === 0 ? 'PASS' : 'FAIL',
          evidence: offenses.length === 0 ? '页面纪律干净(无裸出网/注入面/外链;路由声明与实现一致)' : offenses.slice(0, 5).join(';'),
        })
        if (offenses.length > 0) break
      } else if (c.kind === 'static-reach') {
        // 病史:曾只验 HTML 200+挂载点,资产 404 白屏照样过考(kb-sdk-e2e 实录)。
        // 现在把 HTML 引用的每个 script/link 资产逐个真取——引用完整性入考。
        try {
          const r = await fetch(base + '/', { signal: AbortSignal.timeout(5000), redirect: 'follow' })
          const html = await r.text()
          if (!r.ok || !html.includes('id="root"')) {
            checks.push({ check: 'static-reach', status: 'FAIL', evidence: `GET / → ${String(r.status)},挂载点${html.includes('id="root"') ? '在' : '缺'}` })
            break
          }
          const pageUrl = r.url
          const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m2) => m2[1] as string)
            .filter((u) => !u.startsWith('data:') && !u.startsWith('#'))
          const broken: string[] = []
          for (const u of refs.slice(0, 20)) {
            try {
              const ar = await fetch(new URL(u, pageUrl), { signal: AbortSignal.timeout(5000) })
              if (!ar.ok) broken.push(`${u} → ${String(ar.status)}`)
            } catch { broken.push(`${u} → 请求失败`) }
          }
          const ok = broken.length === 0
          checks.push({
            check: 'static-reach',
            status: ok ? 'PASS' : 'FAIL',
            evidence: ok ? `静态产物真伺服(200 + 挂载点 + ${String(refs.length)} 个引用资产全部可取)` : `资产引用断链:${broken.slice(0, 3).join(';')}`,
          })
          if (!ok) break
        } catch (error) {
          checks.push({ check: 'static-reach', status: 'FAIL', evidence: `GET / 失败:${error instanceof Error ? error.message : String(error)}` })
          break
        }
      } else if (c.kind === 'behavior') {
        // 行为考:PAGE-SPEC 的动作路由标注是考卷——face 动作打服务脸验库效,
        // wire 动作跑真会话。不点 DOM(无浏览器驱动,已知诚实边界):页面层由
        // lint 门"动作必经 SDK"+构建门类型检查夹住,SDK 之下的链路在此真跑。
        const specPath = join(targetDir, 'PAGE-SPEC.yml')
        if (!existsSync(specPath)) {
          checks.push({ check: 'behavior', status: 'FAIL', evidence: '缺 PAGE-SPEC.yml——写页之前先写动作路由标注(它就是这场考试的考卷)' })
          break
        }
        const pageSpec = (yaml.load(readFileSync(specPath, 'utf8')) ?? {}) as { pages?: Array<{ id?: string; actions?: Array<Record<string, unknown>> }> }
        const actions = (pageSpec.pages ?? []).flatMap((p) => (p.actions ?? []).map((a2) => ({ ...a2, page: String(p.id ?? '?') } as Record<string, unknown>)))
        if (actions.length === 0) {
          const pageFiles = existsSync(join(targetDir, 'src', 'pages')) ? walkFiles(join(targetDir, 'src', 'pages')).filter((x) => /\.(tsx|jsx)$/.test(x)).length : 0
          if (pageFiles > 0) {
            checks.push({ check: 'behavior', status: 'FAIL', evidence: `有 ${String(pageFiles)} 张页面但 PAGE-SPEC 没有任何动作——没有考卷的页面不算交付(纯展示动作也要标 route: local)` })
            break
          }
          checks.push({ check: 'behavior', status: 'SKIPPED', evidence: '骨架态(尚无页面)——写页后按 PAGE-SPEC 重验' })
          continue
        }
        const presetId = params.PRESET_ID ?? ''
        const presetDir = join(opts.presetRoot ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.agent-presets'), presetId)
        // 服务脸:优先读在场的 .service.json;零件不在场则考官自己拉起(自给自足)
        let facePart: ReturnType<typeof spawn> | null = null
        const readFace = (): { url: string; token: string } | null => {
          const svcPath = join(presetDir, 'workspace', '.service.json')
          if (!existsSync(svcPath)) return null
          try {
            const svc = (JSON.parse(readFileSync(svcPath, 'utf8')) as { sqlite?: { url: string; token: string } }).sqlite
            return svc ?? null
          } catch { return null }
        }
        const faceAlive = async (f: { url: string; token: string } | null): Promise<boolean> => {
          if (f === null) return false
          try { return (await fetch(`${f.url}/schema`, { headers: { 'x-service-token': f.token }, signal: AbortSignal.timeout(1500) })).ok } catch { return false }
        }
        let face = readFace()
        if (!(await faceAlive(face))) {
          const partJs = join(REPO, 'generated', 'sqlite-query', 'index.js')
          const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            PART_WORKDIR: join(presetDir, 'workspace'),
            SQLITE_DEFAULT_DB: join(presetDir, 'workspace', 'data.db'),
          }
          if (existsSync(join(presetDir, 'equipment', 'init.sql'))) env.SQLITE_INIT_DDL_FILE = join(presetDir, 'equipment', 'init.sql')
          phase('服务脸不在场——考官自行拉起 sqlite 零件')
          facePart = spawn('node', [partJs], { env, stdio: ['pipe', 'pipe', 'pipe'] })
          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 250))
            face = readFace()
            if (await faceAlive(face)) break
          }
        }
        // ai 服务脸(ai-thin 路由):同款自给自足——不在场则考官自拉 ai-call 零件
        let aiPart: ReturnType<typeof spawn> | null = null
        const readAi = (): { url: string; token: string } | null => {
          const svcPath = join(presetDir, 'workspace', '.service.json')
          if (!existsSync(svcPath)) return null
          try { return (JSON.parse(readFileSync(svcPath, 'utf8')) as { ai?: { url: string; token: string } }).ai ?? null } catch { return null }
        }
        const aiAlive = async (f: { url: string; token: string } | null): Promise<boolean> => {
          if (f === null) return false
          try {
            const r = await fetch(`${f.url}/complete`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': f.token }, body: JSON.stringify({}), signal: AbortSignal.timeout(1500) })
            return r.status === 400 || r.ok // 400 = 面活着但参数空,正是探活
          } catch { return false }
        }
        let ai = readAi()

        const results: string[] = []
        let behaviorFail = ''
        try {
          const token = `BHV-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
          const sub = (v: unknown): unknown => typeof v === 'string' ? v.replace(/@@TOKEN@@/g, token) : Array.isArray(v) ? v.map(sub) : v
          for (const a2 of actions) {
            const route = String(a2.route ?? '')
            const name = String(a2.name ?? '?')
            if (route === 'face') {
              if (!(await faceAlive(face)) || face === null) { behaviorFail = `face 动作「${name}」:服务脸不可达(preset ${presetId} 的 sqlite 零件拉不起来)`; break }
              const doSql = async (sql: string, sqlParams: unknown[]): Promise<Record<string, unknown>> => {
                const r = await fetch(`${face.url}/sql`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': face.token }, body: JSON.stringify({ sql, params: sqlParams }), signal: AbortSignal.timeout(8000) })
                const j = (await r.json()) as Record<string, unknown>
                if (typeof j.error === 'string') throw new Error(j.error)
                return j
              }
              try {
                await doSql(String(sub(a2.sql)), (sub(a2.sampleParams) as unknown[] | undefined) ?? [])
                const eff = a2.effect as { sql?: string; sampleParams?: unknown[]; expect?: string } | undefined
                if (eff?.sql !== undefined) {
                  const out = await doSql(String(sub(eff.sql)), (sub(eff.sampleParams) as unknown[] | undefined) ?? [])
                  const hay = JSON.stringify(out.rows ?? [])
                  if (eff.expect !== undefined && !hay.includes(String(sub(eff.expect)))) { behaviorFail = `face 动作「${name}」:效果断言失败(期望含「${String(eff.expect)}」,实得 ${hay.slice(0, 120)})`; break }
                }
                results.push(`face「${name}」✓`)
              } catch (error) {
                behaviorFail = `face 动作「${name}」:${error instanceof Error ? error.message : String(error)}`
                break
              }
            } else if (route === 'wire') {
              if (opts.wirePort === undefined) { results.push(`wire「${name}」SKIPPED(未给 wirePort)`); continue }
              const probe = String(sub(a2.probe ?? ''))
              const marks = sanitizeMarks(((sub(a2.marks) as unknown[] | undefined) ?? []).map(String))
              if (probe === '' || marks.length === 0) { behaviorFail = `wire 动作「${name}」:缺 probe/marks 考题`; break }
              const w = await runScenario(opts.wirePort, presetId, { goal: `行为考·${name}`, turns: [{ prompt: probe, mustInclude: marks }] }, opts.askTimeoutMs ?? 180_000, undefined, join(presetDir, 'workspace'))
              if (w.status !== 'PASS') { behaviorFail = `wire 动作「${name}」:${w.reason ?? w.status}`; break }
              results.push(`wire「${name}」✓`)
            } else if (route === 'ai-thin') {
              const secret = String(a2.needsSecret ?? 'DEEPSEEK_API_KEY')
              if ((process.env[secret] ?? '') === '') { results.push(`ai-thin「${name}」SKIPPED(未配 ${secret},接口模式)`); continue }
              if (!(await aiAlive(ai))) {
                const partJs = join(REPO, 'generated', 'ai-call', 'index.js')
                phase('ai 服务脸不在场——考官自行拉起 ai-call 零件')
                aiPart = spawn('node', [partJs], { env: { ...process.env as Record<string, string>, PART_WORKDIR: join(presetDir, 'workspace') }, stdio: ['pipe', 'pipe', 'pipe'] })
                for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 250)); ai = readAi(); if (await aiAlive(ai)) break }
              }
              if (!(await aiAlive(ai)) || ai === null) { behaviorFail = `ai-thin 动作「${name}」:ai 服务脸不可达(preset ${presetId} 挂了 ai-call 零件吗?)`; break }
              const promptText = String(sub(a2.prompt ?? ''))
              const expect = String(sub(a2.expect ?? ''))
              if (promptText === '' || expect === '') { behaviorFail = `ai-thin 动作「${name}」:缺 prompt/expect 考题`; break }
              try {
                const r = await fetch(`${ai.url}/complete`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', 'x-service-token': ai.token },
                  body: JSON.stringify({ prompt: promptText, system: typeof a2.system === 'string' ? String(sub(a2.system)) : undefined, maxTokens: 512 }),
                  signal: AbortSignal.timeout(opts.askTimeoutMs ?? 120_000),
                })
                const j = (await r.json()) as { text?: string; error?: string }
                if (typeof j.error === 'string') { behaviorFail = `ai-thin 动作「${name}」:${j.error.slice(0, 160)}`; break }
                const text = String(j.text ?? '')
                if (!text.includes(expect)) { behaviorFail = `ai-thin 动作「${name}」:补全未含「${expect}」;实得:${text.slice(0, 160)}`; break }
                results.push(`ai-thin「${name}」✓(一次补全,不开会话)`)
              } catch (error) {
                behaviorFail = `ai-thin 动作「${name}」:${error instanceof Error ? error.message : String(error)}`
                break
              }
            } else if (route === 'local') {
              results.push(`local「${name}」(纯本地 UI,无出网,免考)`)
            } else {
              results.push(`「${name}」route=${route}(未知路由,标注留档)`)
            }
          }
        } finally {
          facePart?.kill('SIGTERM')
          aiPart?.kill('SIGTERM')
        }
        checks.push({
          check: 'behavior',
          status: behaviorFail !== '' ? 'FAIL' : results.some((r) => r.includes('SKIPPED')) ? 'SKIPPED' : 'PASS',
          evidence: behaviorFail !== '' ? behaviorFail : results.join(';'),
        })
        if (behaviorFail !== '') break
      } else {
        checks.push({ check: String((c as ScaffoldCheck).kind), status: 'SKIPPED', evidence: '未知检查类型(底盘比考官新?升级装配器后重验)' })
      }
    }
  } finally {
    child.kill('SIGTERM')
    setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退 */ } }, 2000).unref()
  }
  const anyFail = checks.some((c) => c.status === 'FAIL')
  const anySkip = checks.some((c) => c.status === 'SKIPPED')
  return {
    status: anyFail ? 'FAIL' : anySkip ? 'SKIPPED' : 'PASS',
    checks,
    elapsedSeconds: Math.round((Date.now() - t0) / 1000),
    port,
  }
}

/**
 * 入库门:底盘自证——用自带 sample 实例化到临时目录,跑同一台考官。
 * scripts/index-add.mjs scaffold 调它;底盘改版不过此门不许发货。
 */
export async function runScaffoldGate(
  opts: { scaffoldRoot?: string; tmpRoot?: string; onPhase?: (line: string) => void } = {},
): Promise<{ scaffold: string; version: number; materialize: MaterializeResult; selftest: AppSelftestResult }> {
  const root = opts.scaffoldRoot ?? SCAFFOLD_DIR
  const spec = loadScaffold(root)
  const tmp = join(opts.tmpRoot ?? '/tmp', `scaffold-gate-${String(Date.now())}`)
  const pagesDir = spec.sample.pagesDir !== undefined ? join(root, spec.sample.pagesDir) : undefined
  const materialize = materializeApp({
    targetDir: tmp,
    params: spec.sample.params,
    ...(pagesDir !== undefined ? { pagesDir } : {}),
    fresh: true,
    scaffoldRoot: root,
  })
  try {
    const selftest = await runAppSelftest(tmp, { ...(opts.scaffoldRoot !== undefined ? { scaffoldRoot: opts.scaffoldRoot } : {}), ...(opts.onPhase !== undefined ? { onPhase: opts.onPhase } : {}) })
    return { scaffold: spec.id, version: spec.version, materialize, selftest }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
