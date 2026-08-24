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
  /** healthz = readyPath 结构检查;ask = 真问真答(SSE 流 + 来源可核 + 内容标记,来源链接可达性并在其中)。 */
  kind: 'healthz' | 'ask'
  /** kind:'ask' 时:哪个参数是问题、哪个参数是必须出现在回答里的标记。 */
  questionParam?: string
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
    /** 确定性预计算(装配时预思考):emit_app 实例化后立即执行,如 ingest。 */
    ingest?: string[]
    /** 启动命令(argv 形式,cwd = app 目录)。 */
    start: string[]
    /** 就绪探测路径(GET 该路径 200 即认为已起)。 */
    readyPath: string
  }
  selftest: { checks: RecipeCheck[] }
  /** 入库门用的样例实例化输入(params 全填 + 配方内相对语料目录)。 */
  sample: { params: Record<string, string>; corpusDir?: string }
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
    const m = /indexed (\d+) chunks/.exec(stdout)
    chunks = m !== null ? Number(m[1]) : null
    if (chunks === null || chunks === 0) throw new Error(`emit_app: ingest 产出 0 块(语料是空的还是格式不对?ingest 输出:${stdout.slice(0, 200)})`)
  }

  const templateHash = hashTemplate(templateDir)
  const pendingSecrets = spec.requiredSecrets.map((sret) => ({ ...sret, configured: (process.env[sret.env] ?? '') !== '' }))
  const lock = {
    recipe: spec.id,
    version: spec.version,
    templateHash,
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
  opts: { recipesRoot?: string; onPhase?: (line: string) => void; startTimeoutMs?: number; askTimeoutMs?: number } = {},
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

  phase(`启动 app:${spec.run.start.join(' ')}(cwd=${targetDir},PORT=${String(port)})`)
  const child = spawn(spec.run.start[0] as string, spec.run.start.slice(1), {
    cwd: targetDir,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let childErr = ''
  child.stderr.on('data', (d: Buffer) => { childErr = (childErr + d.toString()).slice(-1000) })
  const checks: AppCheckResult[] = []
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
  const materialize = materializeApp({
    recipeId: id,
    targetDir: tmp,
    params: spec.sample.params,
    ...(corpusDir !== undefined ? { corpusDir } : {}),
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
