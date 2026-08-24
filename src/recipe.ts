/**
 * 配方零件(via: 'recipe')—— app 形态的组装图纸。
 *
 * preset 是"agent 的组装图纸"(零件+persona+接线,发射器印、考官验);配方是
 * "独立 app 的组装图纸":一个完整可跑的项目模板 + 声明式参数槽 + 写死在清单里
 * 的自测考卷。三件事分工与 preset 车道同构:
 *   emit_app    = 哑实例化(确定性:拷模板 + 写 app.config.json + 拷语料 +
 *                 跑确定性 ingest + 落 recipe.lock.yml;零 LLM)
 *   verify_app  = 独立考官(自己拉起 app,按配方考卷黑盒考,考完杀进程;
 *                 不依赖 DSH host——app 是独立进程,考官也独立)
 *   入库门      = 同一台考官跑在配方自带的 sample/ 上(scripts/index-add.mjs
 *                 recipe <id>):配方改版必须自己先过考,防"配方腐烂"——
 *                 对照系(penguin-harness)把配方夹在 skill 散文里靠人手维护,
 *                 错了没人知道;我们的配方错了进不了库。
 *
 * 设计裁定:
 * - 模板文件零替换:参数经 app.config.json 注入,模板字节稳定 ⇒ 配方哈希有
 *   意义、主 agent 的后续发挥面(改文件)与确定性面(配方本体)边界清晰。
 * - 参数键过 SECRET 形状闸(与 preset 参数同款教义):值不检查,键长得像
 *   密钥即拒——密钥只走进程环境变量,永不落 app 文件。
 * - 语料拷进 app 的 corpus/(交付物自包含,与知识包拷进 preset kb/ 同款)。
 * - 考卷是声明式 check(代码执行,非 LLM 判卷):安全往代码压。缺凭证时走
 *   接口模式(检索半边必须活着,AI 半边 SKIPPED + 配置指引)——凭证契约同款。
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { runScenario, sanitizeMarks } from './verify.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const RECIPES_DIR = join(REPO, 'recipes')

// 与 src/index.ts 的参数教义同款(键的形状即拒,值不看):密钥值只许走环境
// 变量;一个长得像密钥的参数键本身就是在邀请误用。
const SECRET_PARAM_RE = /(password|passwd|secret|token|api[-_]?key|access[-_]?key|credential|private[-_]?key|auth)/i

// ── 配方清单 ────────────────────────────────────────────────────────────────

export interface RecipeParamSpec {
  key: string
  description: string
  required?: boolean
  default?: string
  example?: string
}

export interface RecipeCheck {
  /**
   * healthz = readyPath 结构检查;ask = 真问真答(SSE 流 + 来源可核 + 内容标记);
   * record = 一句话入库(POST /api/record 走 AI 薄判断 → /api/rows 黑盒验行;
   * 无 key 时降级考存储半边:/api/sql 直插标记 + 读回)。
   * scaffold 车道五考:build = run.build 零错误(先于起服执行);skeleton-lock =
   * lockPaths 哈希与实例化时一致(写手不许越自由区);pages-lint = src/pages 机械
   * 纪律(禁裸 fetch/WebSocket/dangerouslySetInnerHTML/外链);static-reach =
   * 静态产物真伺服(GET / 200 且含挂载点);behavior = 按 PAGE-SPEC 逐动作验——
   * face 动作经配套 preset 的服务脸执行 sql 并跑 effect 断言(考 SDK 之下的真实
   * 链路;零件不在场时考官自己拉起),wire 动作跑单轮场景探针(需 wirePort)。
   */
  kind: 'healthz' | 'ask' | 'record' | 'build' | 'skeleton-lock' | 'pages-lint' | 'static-reach' | 'behavior'
  /** kind:'ask' 时:哪个参数是问题、哪个参数是必须出现在回答里的标记。 */
  questionParam?: string
  /** kind:'record' 时:哪个参数是考句(自然语言记录)。 */
  textParam?: string
  markerParam?: string
  /** 该检查的 AI 半边依赖的凭证(缺 → 接口模式 SKIPPED,不判负)。 */
  needsSecret?: string
}

export interface RecipeSpec {
  id: string
  version: number
  description: string
  tags: string[]
  license: string
  /** 借鉴出处备注(供应链诚实:模式从哪学的,进目录与 BOM)。 */
  inspiredBy?: string
  params: RecipeParamSpec[]
  requiredSecrets: Array<{ env: string; purpose: string }>
  run: {
    /** 确定性预计算(装配时预思考):emit_app 实例化后立即执行,如 ingest / npm install。 */
    ingest?: string[]
    /** ingest 输出必须报数("indexed N",N>0)——rag/record 类配方开;scaffold(npm install)不开。 */
    ingestCounts?: boolean
    /** 构建命令(argv):考官在起服前执行(kind:'build' 考它);写手改完页后的必经门。 */
    build?: string[]
    /** 启动命令(argv 形式,cwd = app 目录;'@@PORT@@' 由考官替换为实际端口)。 */
    start: string[]
    /** 就绪探测路径(GET 该路径 200 即认为已起)。 */
    readyPath: string
  }
  /** skeleton-lock 考的锁定面(相对 app 根的文件/目录清单):写手自由区之外的一切。 */
  lockPaths?: string[]
  selftest: { checks: RecipeCheck[] }
  /** 入库门用的样例实例化输入(params 全填 + 配方内相对语料/表结构/页面目录)。 */
  sample: { params: Record<string, string>; corpusDir?: string; schemaFile?: string; pagesDir?: string }
}

export function loadRecipe(id: string, recipesRoot: string = RECIPES_DIR): RecipeSpec {
  const dir = join(recipesRoot, id)
  const manifest = join(dir, 'recipe.yml')
  if (!existsSync(manifest)) throw new Error(`配方不存在:${id}(找不到 ${manifest})`)
  const raw = (yaml.load(readFileSync(manifest, 'utf8')) ?? {}) as Partial<RecipeSpec>
  const spec: RecipeSpec = {
    id: String(raw.id ?? ''),
    version: typeof raw.version === 'number' ? raw.version : 0,
    description: String(raw.description ?? ''),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    license: String(raw.license ?? ''),
    ...(typeof raw.inspiredBy === 'string' ? { inspiredBy: raw.inspiredBy } : {}),
    params: Array.isArray(raw.params) ? raw.params as RecipeParamSpec[] : [],
    requiredSecrets: Array.isArray(raw.requiredSecrets) ? raw.requiredSecrets as RecipeSpec['requiredSecrets'] : [],
    ...(Array.isArray(raw.lockPaths) ? { lockPaths: raw.lockPaths.map(String) } : {}),
    run: (raw.run ?? {}) as RecipeSpec['run'],
    selftest: (raw.selftest ?? { checks: [] }) as RecipeSpec['selftest'],
    sample: (raw.sample ?? { params: {} }) as RecipeSpec['sample'],
  }
  if (spec.id !== id) throw new Error(`配方 ${id} 的 recipe.yml id 字段(${spec.id})与目录名不一致`)
  if (spec.version < 1) throw new Error(`配方 ${id} 缺 version(≥1 的整数,改内容必须升版本)`)
  if (!Array.isArray(spec.run.start) || spec.run.start.length === 0) throw new Error(`配方 ${id} 缺 run.start 启动命令`)
  if (typeof spec.run.readyPath !== 'string' || !spec.run.readyPath.startsWith('/')) throw new Error(`配方 ${id} 缺 run.readyPath 就绪探测路径`)
  if (spec.selftest.checks.length === 0) throw new Error(`配方 ${id} 缺 selftest.checks —— 没有考卷的配方不许入库(验收永远归考官)`)
  if (!existsSync(join(dir, 'template'))) throw new Error(`配方 ${id} 缺 template/ 目录`)
  for (const p of spec.params) {
    if (SECRET_PARAM_RE.test(p.key)) throw new Error(`配方 ${id} 参数键 ${p.key} 长得像密钥——密钥只许声明进 requiredSecrets(值走环境变量),不许做参数槽`)
  }
  return spec
}

export function listRecipes(recipesRoot: string = RECIPES_DIR): string[] {
  if (!existsSync(recipesRoot)) return []
  return readdirSync(recipesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(recipesRoot, e.name, 'recipe.yml')))
    .map((e) => e.name)
    .sort()
}

// ── 实例化(哑印刷机)────────────────────────────────────────────────────────

export interface MaterializeInput {
  recipeId: string
  /** app 落地目录(绝对路径;不存在则创建;非空目录拒绝,除非 fresh)。 */
  targetDir: string
  params: Record<string, string>
  /** 语料目录(绝对路径),拷进 app 的 corpus/。 */
  corpusDir?: string
  /** 表结构文件(绝对路径),拷进 app 的 schema.sql(记录形配方:装配器的装备 DDL 对位物)。 */
  schemaFile?: string
  /** 页面目录(绝对路径),拷进 app 的 src/pages/(scaffold 配方:入库门样例页/写手成品迁入)。 */
  pagesDir?: string
  fresh?: boolean
  recipesRoot?: string
}

export interface MaterializeResult {
  targetDir: string
  recipe: string
  version: number
  templateHash: string
  corpus: { files: number; bytes: number } | null
  /** ingest 输出解析出的块数(配方无 ingest 时为 null)。 */
  chunks: number | null
  pendingSecrets: Array<{ env: string; purpose: string; configured: boolean }>
  lockPath: string
}

const CORPUS_EXTS = new Set(['.md', '.mdx', '.txt', '.html', '.htm'])
const CORPUS_FILE_CAP = 2 * 1024 * 1024
const CORPUS_TOTAL_CAP = 50 * 1024 * 1024

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

/** 模板全体字节的稳定哈希(文件相对路径排序后逐个喂)——进 lock,配方代际可核。 */
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
  const spec = loadRecipe(input.recipeId, input.recipesRoot)
  const target = input.targetDir
  if (!target.startsWith('/')) throw new Error('emit_app: targetDir 必须是绝对路径(相对路径会解析进宿主进程 cwd)')
  const norm = resolve(target)
  if (norm === homedir() || norm === '/' || norm === REPO) throw new Error(`emit_app: 拒绝把 app 实例化到 ${norm}`)
  if (norm.startsWith(REPO + '/')) throw new Error('emit_app: targetDir 不许落在装配器仓库内(配方是库存,实例是交付物,两者不混)')

  // 参数闸:键形状 + 必填齐全。缺哪些、每个是干什么的,一次说清(可行动错误)。
  for (const k of Object.keys(input.params)) {
    if (SECRET_PARAM_RE.test(k)) throw new Error(`emit_app: 参数键 ${k} 长得像密钥,拒绝——密钥只走启动环境变量(见配方 requiredSecrets),永不进 app 文件`)
  }
  const missing = spec.params.filter((p) => p.required !== false && (input.params[p.key] ?? '').trim() === '')
  if (missing.length > 0) {
    throw new Error(`emit_app: 配方 ${spec.id} 缺必填参数:\n${missing.map((p) => `  - ${p.key}:${p.description}${p.example !== undefined ? `(如:${p.example}` : ''}${p.example !== undefined ? ')' : ''}`).join('\n')}`)
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

  const templateDir = join(input.recipesRoot ?? RECIPES_DIR, spec.id, 'template')
  cpSync(templateDir, norm, { recursive: true })

  // 语料自包含拷贝(文本类、限尺寸;越界/超限即拒,不静默截断)。
  let corpus: MaterializeResult['corpus'] = null
  if (input.corpusDir !== undefined && input.corpusDir !== '') {
    const src = resolve(input.corpusDir)
    if (!src.startsWith('/')) throw new Error('emit_app: corpusDir 必须是绝对路径')
    if (!existsSync(src) || !statSync(src).isDirectory()) throw new Error(`emit_app: 语料目录不存在:${src}`)
    const files = walkFiles(src).filter((f) => CORPUS_EXTS.has(extname(f).toLowerCase()))
    if (files.length === 0) throw new Error(`emit_app: 语料目录 ${src} 里没有文本文件(收 ${[...CORPUS_EXTS].join('/')})`)
    let total = 0
    const dst = join(norm, 'corpus')
    mkdirSync(dst, { recursive: true })
    for (const f of files) {
      const size = statSync(f).size
      if (size > CORPUS_FILE_CAP) throw new Error(`emit_app: 语料文件超 2MB:${f}(${String(size)} 字节)——先拆分或剔除`)
      total += size
      if (total > CORPUS_TOTAL_CAP) throw new Error('emit_app: 语料总量超 50MB——配方 app 的检索是内存索引,先裁剪语料')
      const rel = relative(src, f)
      const to = join(dst, rel)
      if (!resolve(to).startsWith(dst + '/') && resolve(to) !== dst) throw new Error(`emit_app: 语料相对路径越界:${rel}`)
      mkdirSync(dirname(to), { recursive: true })
      cpSync(f, to)
    }
    corpus = { files: files.length, bytes: total }
  }

  if (input.schemaFile !== undefined && input.schemaFile !== '') {
    const sf = resolve(input.schemaFile)
    if (!sf.startsWith('/') || !existsSync(sf)) throw new Error(`emit_app: schemaFile 不存在:${sf}`)
    cpSync(sf, join(norm, 'schema.sql'))
  }
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

  // 参数经配置文件注入(模板文件零替换 ⇒ 模板字节稳定、配方哈希有意义)。
  writeFileSync(join(norm, 'app.config.json'), JSON.stringify({ recipe: spec.id, ...params }, null, 2) + '\n')

  // 确定性预计算(装配时预思考):ingest 在实例化时跑完,交付即就绪。
  let chunks: number | null = null
  if (Array.isArray(spec.run.ingest) && spec.run.ingest.length > 0) {
    let stdout = ''
    try {
      stdout = execFileSync(spec.run.ingest[0] as string, spec.run.ingest.slice(1), { cwd: norm, encoding: 'utf8', timeout: 60_000 })
    } catch (error: unknown) {
      const e = error as { stderr?: string; stdout?: string; message?: string }
      throw new Error(`emit_app: ingest 失败——${(e.stderr ?? e.stdout ?? e.message ?? '').toString().slice(0, 400)}`)
    }
    const m = /indexed (\d+)/.exec(stdout)
    chunks = m !== null ? Number(m[1]) : null
    // 报数纪律按配方声明:rag/record 类的 ingest 必须报 indexed N 且 N>0;
    // scaffold 类的 ingest 是 npm install,不报数不算病。
    if (spec.run.ingestCounts === true && (chunks === null || chunks === 0)) {
      throw new Error(`emit_app: ingest 产出 0 块(语料是空的还是格式不对?ingest 输出:${stdout.slice(0, 200)})`)
    }
  }

  const templateHash = hashTemplate(templateDir)
  // 骨架锁(scaffold 车道):锁定面哈希入 lock,验收时重算——写手的自由区之外
  // 动一个字节都会被 skeleton-lock 考抓住。node_modules 不在 lockPaths 内。
  const skeletonHash = spec.lockPaths !== undefined ? hashLockPaths(norm, spec.lockPaths) : null
  const pendingSecrets = spec.requiredSecrets.map((sret) => ({ ...sret, configured: (process.env[sret.env] ?? '') !== '' }))
  const lock = {
    recipe: spec.id,
    version: spec.version,
    templateHash,
    ...(skeletonHash !== null ? { skeletonHash } : {}),
    materializedAt: new Date().toISOString(),
    params,
    ...(corpus !== null ? { corpus } : {}),
    ...(chunks !== null ? { chunks } : {}),
    pendingSecrets: pendingSecrets.filter((sm) => !sm.configured).map((sm) => ({ env: sm.env, purpose: sm.purpose })),
  }
  const lockPath = join(norm, 'recipe.lock.yml')
  writeFileSync(lockPath, yaml.dump(lock, { lineWidth: 120 }))
  return { targetDir: norm, recipe: spec.id, version: spec.version, templateHash, corpus, chunks, pendingSecrets, lockPath }
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

async function waitReady(base: string, path: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  let lastErr = ''
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(base + path, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return (await res.json().catch(() => ({}))) as Record<string, unknown>
      lastErr = `HTTP ${String(res.status)}`
    } catch (error) {
      lastErr = error instanceof Error ? error.message : String(error)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`app 未在 ${String(Math.round(timeoutMs / 1000))}s 内就绪(${path} → ${lastErr})`)
}

/** 收集一次 /api/ask 的 SSE 流(delta 拼回答、sources/error 取事件)。 */
async function collectAsk(base: string, question: string, timeoutMs: number): Promise<{ answer: string; sources: Array<Record<string, unknown>>; error?: string }> {
  const res = await fetch(`${base}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok || res.body === null) throw new Error(`/api/ask HTTP ${String(res.status)}`)
  let answer = ''
  let sources: Array<Record<string, unknown>> = []
  let errorMsg: string | undefined
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const line = frame.split('\n').find((l) => l.startsWith('data: '))
      if (line === undefined) continue
      try {
        const ev = JSON.parse(line.slice(6)) as Record<string, unknown>
        if (typeof ev.delta === 'string') answer += ev.delta
        if (Array.isArray(ev.sources)) sources = ev.sources as Array<Record<string, unknown>>
        if (typeof ev.error === 'string') errorMsg = ev.error
      } catch { /* 非 JSON 帧忽略 */ }
    }
  }
  return { answer, sources, ...(errorMsg !== undefined ? { error: errorMsg } : {}) }
}

/**
 * 独立考官:从 app 目录自己拉起进程、按配方考卷黑盒考、考完必杀进程。
 * 同一台考官双岗:入库门(sample 实例)与交付验收(用户实例)。
 */
export async function runAppSelftest(
  targetDir: string,
  opts: {
    recipesRoot?: string
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
  const lockPath = join(targetDir, 'recipe.lock.yml')
  if (!existsSync(lockPath)) throw new Error(`verify_app: ${targetDir} 没有 recipe.lock.yml——这不是配方实例化出来的 app(先 emit_app)`)
  const lock = (yaml.load(readFileSync(lockPath, 'utf8')) ?? {}) as { recipe?: string; params?: Record<string, string> }
  if (typeof lock.recipe !== 'string') throw new Error('verify_app: recipe.lock.yml 缺 recipe 字段')
  const spec = loadRecipe(lock.recipe, opts.recipesRoot)
  const params = lock.params ?? {}
  const port = await getFreePort()
  const base = `http://127.0.0.1:${String(port)}`
  const phase = (line: string): void => { opts.onPhase?.(line) }
  const preChecks: AppCheckResult[] = []

  // 构建门先于起服(scaffold:preview 伺服的是 dist,必须先 build;失败带出编译器原文)
  if (spec.selftest.checks.some((c) => c.kind === 'build')) {
    if (!Array.isArray(spec.run.build) || spec.run.build.length === 0) {
      return { status: 'FAIL', checks: [{ check: 'build', status: 'FAIL', evidence: '配方声明了 build 考但 run.build 缺失' }], elapsedSeconds: Math.round((Date.now() - t0) / 1000), port }
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
    let health: Record<string, unknown>
    try {
      health = await waitReady(base, spec.run.readyPath, opts.startTimeoutMs ?? 15_000)
    } catch (error) {
      const reason = `${error instanceof Error ? error.message : String(error)}${childErr !== '' ? `;stderr:${childErr.slice(-300)}` : ''}`
      return { status: 'FAIL', checks: [{ check: 'start', status: 'FAIL', evidence: reason }], elapsedSeconds: Math.round((Date.now() - t0) / 1000), port }
    }

    for (const c of spec.selftest.checks) {
      if (c.kind === 'healthz') {
        const chunks = typeof health.chunks === 'number' ? health.chunks : 0
        const ok = health.ok === true && chunks > 0
        checks.push({ check: 'healthz', status: ok ? 'PASS' : 'FAIL', evidence: `${spec.run.readyPath} → ok=${String(health.ok)}, chunks=${String(chunks)}` })
        phase(`healthz ${ok ? '✓' : '✗'}(${String(chunks)} 块)`)
        if (!ok) break
      } else if (c.kind === 'ask') {
        const question = params[c.questionParam ?? ''] ?? ''
        const marker = params[c.markerParam ?? ''] ?? ''
        if (question === '' || marker === '') {
          checks.push({ check: 'ask', status: 'FAIL', evidence: `考题参数缺失(${c.questionParam ?? '?'}/${c.markerParam ?? '?'} 未随实例落 lock)` })
          break
        }
        const keyPresent = c.needsSecret === undefined || (process.env[c.needsSecret] ?? '') !== ''
        phase(`真题黑盒:「${question.slice(0, 60)}」${keyPresent ? '' : `(${c.needsSecret ?? ''} 未配 → 接口模式)`}`)
        let out: Awaited<ReturnType<typeof collectAsk>>
        try {
          out = await collectAsk(base, question, opts.askTimeoutMs ?? 120_000)
        } catch (error) {
          checks.push({ check: 'ask', status: 'FAIL', evidence: `/api/ask 请求失败:${error instanceof Error ? error.message : String(error)}` })
          break
        }
        // 检索半边是客观闸,不吃凭证:来源必须 ≥1,且首个来源文件真实存在、
        // 其 /corpus 链接可达(引用必须能点开原文——配方契约)。
        if (out.sources.length === 0) {
          checks.push({ check: 'ask', status: 'FAIL', evidence: `回答无 sources 事件(检索半边死了)${out.error !== undefined ? `;error:${out.error.slice(0, 160)}` : ''}` })
          break
        }
        const src0 = out.sources[0] as { source?: string; url?: string }
        const srcFile = join(targetDir, 'corpus', String(src0.source ?? ''))
        const srcOnDisk = existsSync(srcFile)
        let srcLink = false
        try {
          const r = await fetch(base + String(src0.url ?? ''), { signal: AbortSignal.timeout(5000) })
          srcLink = r.ok
        } catch { srcLink = false }
        if (!srcOnDisk || !srcLink) {
          checks.push({ check: 'ask', status: 'FAIL', evidence: `来源不可核:文件${srcOnDisk ? '在' : '缺'}、链接 ${srcLink ? '通' : '断'}(${String(src0.url ?? '')})` })
          break
        }
        if (!keyPresent) {
          const honest = out.error !== undefined && out.error.includes(c.needsSecret ?? '')
          checks.push({
            check: 'ask',
            status: honest ? 'SKIPPED' : 'FAIL',
            evidence: honest
              ? `接口模式 PASS:检索来源可核(${String(src0.source ?? '')}),AI 半边如实报缺 ${c.needsSecret ?? ''}(配置后重验)`
              : `未配 ${c.needsSecret ?? ''} 时 app 未给出可行动错误(error 事件缺失或没点名环境变量)——违反凭证契约`,
          })
          if (!honest) break
          continue
        }
        const hit = out.answer.includes(marker)
        checks.push({
          check: 'ask',
          status: hit ? 'PASS' : 'FAIL',
          evidence: hit
            ? `回答含标记「${marker}」,来源可核(${String(src0.source ?? '')});回答节选:${out.answer.slice(0, 120)}`
            : `回答未含标记「${marker}」;实际回答节选:${out.answer.slice(0, 200)}`,
        })
        phase(`真题 ${hit ? '✓' : '✗'}`)
        if (!hit) break
      } else if (c.kind === 'record') {
        const text = params[c.textParam ?? ''] ?? ''
        const marker = params[c.markerParam ?? ''] ?? ''
        if (text === '' || marker === '') {
          checks.push({ check: 'record', status: 'FAIL', evidence: `考题参数缺失(${c.textParam ?? '?'}/${c.markerParam ?? '?'} 未随实例落 lock)` })
          break
        }
        const keyPresent = c.needsSecret === undefined || (process.env[c.needsSecret] ?? '') !== ''
        const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
          const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.askTimeoutMs ?? 90_000) })
          return (await r.json()) as Record<string, unknown>
        }
        const rowsHaveMarker = async (table?: string): Promise<boolean> => {
          // 指定表优先(/api/record 会报它写进了哪张表);缺省第一张表
          const r = await fetch(`${base}/api/rows${table !== undefined && table !== '' ? `?table=${encodeURIComponent(table)}` : ''}`, { signal: AbortSignal.timeout(5000) })
          return JSON.stringify(await r.json()).includes(marker)
        }
        if (keyPresent) {
          phase(`真句入库:「${text.slice(0, 50)}」`)
          const j = await post('/api/record', { text })
          if (typeof j.error === 'string') {
            checks.push({ check: 'record', status: 'FAIL', evidence: `/api/record 报错:${j.error.slice(0, 200)}` })
            break
          }
          const hit = await rowsHaveMarker(typeof j.table === 'string' ? j.table : undefined)
          checks.push({
            check: 'record',
            status: hit ? 'PASS' : 'FAIL',
            evidence: hit ? `AI 解析入库且台账可查(标记「${marker}」在表 ${String(j.table ?? '?')});行:${JSON.stringify(j.row ?? {}).slice(0, 140)}` : `入库后 /api/rows 查不到标记「${marker}」(表 ${String(j.table ?? '?')})`,
          })
          phase(`真句 ${hit ? '✓' : '✗'}`)
          if (!hit) break
        } else {
          // 接口模式:AI 半边必须如实报缺;存储半边用 /api/sql 直插直读证明活着
          const j = await post('/api/record', { text })
          const honest = typeof j.error === 'string' && j.error.includes(c.needsSecret ?? '')
          if (!honest) {
            checks.push({ check: 'record', status: 'FAIL', evidence: `未配 ${c.needsSecret ?? ''} 时 /api/record 未给出点名环境变量的可行动错误——违反凭证契约` })
            break
          }
          const sch = (await (await fetch(`${base}/api/schema`, { signal: AbortSignal.timeout(5000) })).json()) as { tables?: Array<{ name: string; columns: Array<{ name: string; type: string; pk: boolean }> }> }
          const t0table = sch.tables?.[0]
          const col = t0table?.columns.find((cc) => /TEXT|CHAR/i.test(cc.type) && !cc.pk)
          let stored = false
          if (t0table !== undefined && col !== undefined) {
            await post('/api/sql', { sql: `INSERT INTO "${t0table.name.replace(/"/g, '""')}" ("${col.name}") VALUES (?)`, params: [marker] })
            stored = await rowsHaveMarker(t0table.name)
          }
          checks.push({
            check: 'record',
            status: stored ? 'SKIPPED' : 'FAIL',
            evidence: stored
              ? `接口模式 PASS:存储半边直插直读可核(表 ${t0table?.name ?? '?'}),AI 半边如实报缺 ${c.needsSecret ?? ''}(配置后重验)`
              : '接口模式下存储半边直插直读失败',
          })
          if (!stored) break
        }
      } else if (c.kind === 'build') {
        continue // 已在起服前执行(preChecks)
      } else if (c.kind === 'skeleton-lock') {
        const lockedHash = (lock as { skeletonHash?: string }).skeletonHash
        if (typeof lockedHash !== 'string' || spec.lockPaths === undefined) {
          checks.push({ check: 'skeleton-lock', status: 'FAIL', evidence: 'lock 里没有 skeletonHash(配方缺 lockPaths?重新 emit_app)' })
          break
        }
        const now = hashLockPaths(targetDir, spec.lockPaths)
        const ok = now === lockedHash
        checks.push({
          check: 'skeleton-lock',
          status: ok ? 'PASS' : 'FAIL',
          evidence: ok ? `骨架/SDK/词汇字节未被越界改动(${lockedHash})` : `骨架被改动(${lockedHash} → ${now})——写手自由区只有 src/pages/ 与 PAGE-SPEC.yml,改骨架请回配方车道升版本`,
        })
        if (!ok) break
      } else if (c.kind === 'pages-lint') {
        const pagesDir = join(targetDir, 'src', 'pages')
        const offenses: string[] = []
        if (existsSync(pagesDir)) {
          for (const f of walkFiles(pagesDir).filter((x) => /\.(tsx|ts|jsx|js)$/.test(x))) {
            const text = readFileSync(f, 'utf8')
            const rel = relative(targetDir, f)
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
        checks.push({
          check: 'pages-lint',
          status: offenses.length === 0 ? 'PASS' : 'FAIL',
          evidence: offenses.length === 0 ? '页面纪律干净(无裸出网/注入面/外链)' : offenses.slice(0, 5).join(';'),
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
              results.push(`「${name}」route=${route}(ai-thin v1 经 wire 承载,标注留档)`)
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
        checks.push({ check: String(c.kind), status: 'SKIPPED', evidence: '未知检查类型(配方比考官新?升级装配器后重验)' })
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
 * 入库门:配方自证——用自带 sample 实例化到临时目录,跑同一台考官。
 * scripts/index-add.mjs recipe <id> 调它;配方改版不过此门不许登记。
 */
export async function runRecipeGate(
  id: string,
  opts: { recipesRoot?: string; tmpRoot?: string; onPhase?: (line: string) => void } = {},
): Promise<{ recipe: string; version: number; materialize: MaterializeResult; selftest: AppSelftestResult }> {
  const spec = loadRecipe(id, opts.recipesRoot)
  const tmp = join(opts.tmpRoot ?? '/tmp', `recipe-gate-${id}-${String(Date.now())}`)
  const recipeDir = join(opts.recipesRoot ?? RECIPES_DIR, id)
  const corpusDir = spec.sample.corpusDir !== undefined ? join(recipeDir, spec.sample.corpusDir) : undefined
  const schemaFile = spec.sample.schemaFile !== undefined ? join(recipeDir, spec.sample.schemaFile) : undefined
  const pagesDir = spec.sample.pagesDir !== undefined ? join(recipeDir, spec.sample.pagesDir) : undefined
  const materialize = materializeApp({
    recipeId: id,
    targetDir: tmp,
    params: spec.sample.params,
    ...(corpusDir !== undefined ? { corpusDir } : {}),
    ...(schemaFile !== undefined ? { schemaFile } : {}),
    ...(pagesDir !== undefined ? { pagesDir } : {}),
    fresh: true,
    ...(opts.recipesRoot !== undefined ? { recipesRoot: opts.recipesRoot } : {}),
  })
  try {
    const selftest = await runAppSelftest(tmp, { ...(opts.recipesRoot !== undefined ? { recipesRoot: opts.recipesRoot } : {}), ...(opts.onPhase !== undefined ? { onPhase: opts.onPhase } : {}) })
    return { recipe: id, version: spec.version, materialize, selftest }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
