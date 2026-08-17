#!/usr/bin/env node
/**
 * 索引流水线 CLI —— 把"收录一个新开源库"压成命令序列。
 *
 * 设计给 agent 调用:CLI 只做确定性环节(取源、出工单、装依赖、质检、登记),
 * "切分能力点 + 写适配代码"这一智能环节留给调用方(调用方本来就是 LLM)。
 * 每个子命令最后一行输出一个 JSON 判定,机器可判读;质检门在流水线里:
 * verify 不过,register 直接拒绝。
 *
 * 用法:
 *   node scripts/index-add.mjs scaffold <owner/repo> --pkg <npm包名> [--id <零件id>]
 *       取 npm 元数据(版本/许可证)、浅取上游源码到 .cache/upstream/<id>、
 *       生成 generated/<id>/{package.json,.index-meta.json,WORK-ORDER.md} 骨架。
 *       然后由调用方按工单写 index.js + smoke.mjs。
 *   node scripts/index-add.mjs verify <id>
 *       npm install → 跑 smoke.mjs(exit 0 必须)→ 独立 listTools 实探 →
 *       写 index/reports/<id>.json。
 *   node scripts/index-add.mjs register <id>
 *       verify 报告必须存在且通过;幂等登记 index/catalog.yml +
 *       capabilities.yml 的 mcp-servers 段。
 *   node scripts/index-add.mjs check-all
 *       全量复检:跑每个 generated/<id>/smoke.mjs,任一失败退出非零。
 */
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const [cmd, target, ...rest] = process.argv.slice(2)
const flags = {}
for (let i = 0; i < rest.length; i += 2) {
  if (rest[i]?.startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1]
}

/**
 * Env for spawned part processes and smokes.
 *
 * Node's global `fetch` ignores HTTP(S)_PROXY unless NODE_USE_ENV_PROXY=1, so
 * behind a proxy a healthy service part fails with a bare "fetch failed"
 * while curl from the same shell succeeds. Forcing the flag here fixes every
 * network part's smoke at once (the runtime side is handled in scrubbedEnv).
 */
function partEnv() {
  const env = { ...process.env }
  const proxied = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((k) => env[k])
  if (proxied && env.NODE_USE_ENV_PROXY === undefined) env.NODE_USE_ENV_PROXY = '1'
  return env
}

const die = (msg) => {
  console.log(JSON.stringify({ ok: false, error: msg }))
  process.exit(1)
}
const out = (obj) => {
  console.log(JSON.stringify({ ok: true, ...obj }))
}

// ── dedup gate ─────────────────────────────────────────────────────────────
// 目录是能力目录不是库目录:同一上游库/同一 npm 包不允许收两次。这里挡的是
// 机械重复(同库换个 id 再收);能力级重叠(不同库、同能力点)由调用方对着
// `coverage` 子命令的覆盖图判定——那是语义判断,属于智能环节。
function dedupGate({ id, pkg, repoSlug }) {
  const gen = join(REPO, 'generated')
  if (existsSync(join(gen, id, '.index-meta.json'))) return `id "${id}" 已存在(generated/${id})`
  for (const d of existsSync(gen) ? readdirSync(gen) : []) {
    const pj = join(gen, d, 'package.json')
    if (!existsSync(pj)) continue
    const deps = JSON.parse(readFileSync(pj, 'utf8')).dependencies ?? {}
    if (pkg in deps) return `npm 包 "${pkg}" 已被零件 "${d}" 收录`
  }
  const catalogPath = join(REPO, 'index', 'catalog.yml')
  if (existsSync(catalogPath) && new RegExp(`^  repo: ${repoSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(readFileSync(catalogPath, 'utf8'))) {
    return `上游 repo "${repoSlug}" 已在 index/catalog.yml`
  }
  return null
}

// ── coverage ───────────────────────────────────────────────────────────────
// 现有能力覆盖图:每个 server 一行(工具名 + tags 并集),给调用方做语义判重
// ——候选库先对着这张图判 NEW / OVERLAP,重叠能力点不收。
function coverage() {
  const catalogPath = join(REPO, 'index', 'catalog.yml')
  const text = readFileSync(catalogPath, 'utf8')
  const blocks = text.split(/^- id: /m).slice(1)
  const map = blocks.map((b) => {
    const id = b.split('\n')[0].trim()
    const tools = [...b.matchAll(/- \{ name: ([^,]+), description: ("[^"]*"|[^}]*?)\s*\}/g)]
      .map((m) => `${m[1].trim()}(${m[2].replace(/^"|"$/g, '').slice(0, 36)})`)
    return { id, tools }
  })
  for (const s of map) console.error(`${s.id}: ${s.tools.join(' | ')}`)
  console.log(JSON.stringify({ ok: true, servers: map.length, tools: map.reduce((n, s) => n + s.tools.length, 0) }))
}

// ── scaffold ───────────────────────────────────────────────────────────────
function scaffold() {
  out(scaffoldCore(target, flags))
}

/**
 * Skeleton + work order for a SERVICE part (a public HTTP API).
 *
 * No package to pin and nothing to clone: the recorded facts are the base URL,
 * the terms/licence the data comes under, and the rate limit the part must
 * respect. Dependencies stay at the MCP SDK + zod — a service part calls the
 * API with `fetch`, so there is no third-party client to audit.
 */
function scaffoldService(id, opts) {
  const dir = join(REPO, 'generated', id)
  mkdirSync(dir, { recursive: true })
  if (!existsSync(join(dir, 'package.json'))) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: `@dsh-index/${id}`,
      version: '0.0.1',
      type: 'module',
      private: true,
      description: `MCP stdio server exposing the ${id} public API`,
      dependencies: { '@modelcontextprotocol/sdk': '^1.0.0', zod: '^3.23.0' },
    }, null, 2) + '\n')
  }
  const meta = {
    id,
    kind: 'service',
    service: opts.service,
    provider: opts.provider ?? '(未填)',
    license: opts.license ?? 'UNKNOWN',
    terms: opts.terms ?? '(未填:服务条款 URL)',
    rateLimit: opts['rate-limit'] ?? '(未填)',
    network: true,
    scaffoldedAt: new Date().toISOString(),
  }
  writeFileSync(join(dir, '.index-meta.json'), JSON.stringify(meta, null, 2) + '\n')
  writeFileSync(join(dir, 'WORK-ORDER.md'), `# 收录工单(服务型):${id}

服务:${meta.service}
提供方:${meta.provider} — 数据许可:${meta.license} — 条款:${meta.terms}
速率限制:${meta.rateLimit}

## 要写的两个文件(户型规范,参照 generated/text-diff/ 与 generated/http-request/)

1. **index.js** — MCP stdio 适配服务器,用内置 fetch 调上述服务(不引第三方 HTTP 客户端)
   - 切 2~4 个能力点:选这个服务最有业务价值、一轮内可完成的操作
   - **网络零件铁律**:
     * 每次请求带超时(AbortSignal.timeout,建议 15s)与明确 User-Agent
       \`dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)\`——
       Nominatim/SEC 等服务强制要求 UA,缺了会被封
     * 非 2xx、超时、JSON 解析失败一律返回 { isError: true, ... } 且**说明是哪个服务出了什么问题**,绝不抛裸异常
     * 尊重速率限制(${meta.rateLimit});不做并发扇出
     * 只读:不调用任何写端点
   - 返回体裁剪成 agent 用得上的字段(别把整个 JSON 倒回上下文)
2. **smoke.mjs** — 冒烟(check() 计数,最后 process.exit(failures))
   - listTools 数量断言 → 每个工具**真实网络调用**并断言内容型结果 → 至少一条错误路径(非法参数或不存在的资源)
   - 断言要抗数据漂移:天气/汇率/行情这类值天天变,断言**结构与量纲**(字段存在、数值在合理区间、单位正确),不断言具体数值
   - **必须把代理环境显式传给零件子进程**:MCP SDK 的 StdioClientTransport 默认只透传
     白名单 env(HOME/PATH/USER…),HTTPS_PROXY / NODE_USE_ENV_PROXY 都不在其中。
     不传的话零件在代理网络下只报 "fetch failed",看着像零件坏了、其实是网络路径断了。
     写法:构造一个 NETWORK_ENV = { ...process.env },当检测到 HTTPS_PROXY/HTTP_PROXY
     而 NODE_USE_ENV_PROXY 未设时补上 NODE_USE_ENV_PROXY='1',再传给
     new StdioClientTransport({ command, args, env: NETWORK_ENV })。
     参照 generated/geocode/smoke.mjs 顶部的现成写法照抄。
`)
  return { id, kind: 'service', service: meta.service, license: meta.license, workOrder: `generated/${id}/WORK-ORDER.md`, next: `写 generated/${id}/{index.js,smoke.mjs},然后 verify` }
}

/**
 * Fetch metadata, shallow-clone upstream, write the skeleton + work order.
 * Returns the result rather than printing it, so `auto` can chain on it.
 */
function scaffoldCore(repoSlugArg, opts) {
  // Two part shapes share this pipeline:
  //   library part  — wraps an npm package (version+license from the registry,
  //                   upstream shallow-cloned for the author to read);
  //   service part  — wraps a PUBLIC HTTP API (`--service <base-url>`): there is
  //                   no package to pin, so the pinned facts are the service's
  //                   TERMS and rate limit instead. FDE delivery needs those on
  //                   record: a client's compliance desk asks what the agent
  //                   calls and under whose licence before it asks anything else.
  const isService = typeof opts.service === 'string' && opts.service !== ''
  const repoSlug = repoSlugArg
  if (!isService && !repoSlug?.includes('/')) die('scaffold 需要 <owner/repo>,如 kpdecker/jsdiff(服务型零件用 --service <base-url>)')
  const pkg = opts.pkg ?? (isService ? (opts.id ?? '') : repoSlug.split('/')[1])
  const id = (opts.id ?? pkg).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  const dup = dedupGate({ id, pkg: isService ? `service:${id}` : pkg, repoSlug: isService ? opts.service : repoSlug })
  if (dup !== null && opts.force !== 'yes') die(`去重门:${dup}(确认要重复收录用 --force yes)`)

  if (isService) return scaffoldService(id, opts)

  let meta
  try {
    meta = JSON.parse(execSync(`npm view ${pkg} version license description --json`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  } catch {
    die(`npm view ${pkg} 失败——包名不对?用 --pkg 指定 npm 包名`)
  }

  const upstream = join(REPO, '.cache', 'upstream', id)
  if (!existsSync(upstream)) {
    try {
      execSync(`git clone --depth 1 https://github.com/${repoSlug}.git "${upstream}"`, { stdio: 'pipe' })
    } catch {
      // 上游读不到不拦骨架:调用方还能从 npm README/类型定义读 API
    }
  }
  const upstreamFiles = existsSync(upstream)
    ? readdirSync(upstream).filter((f) => !f.startsWith('.')).slice(0, 40)
    : []

  const dir = join(REPO, 'generated', id)
  mkdirSync(dir, { recursive: true })
  const pkgJsonPath = join(dir, 'package.json')
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(pkgJsonPath, JSON.stringify({
      name: `@dsh-index/${id}`,
      version: '0.0.1',
      type: 'module',
      private: true,
      description: `MCP stdio server exposing ${pkg} tools`,
      dependencies: {
        '@modelcontextprotocol/sdk': '^1.0.0',
        zod: '^3.23.0',
        [pkg]: meta.version,
      },
    }, null, 2) + '\n')
  }
  writeFileSync(join(dir, '.index-meta.json'), JSON.stringify({
    id, pkg, version: meta.version, repo: repoSlug,
    license: meta.license ?? 'UNKNOWN',
    scaffoldedAt: new Date().toISOString(),
  }, null, 2) + '\n')

  writeFileSync(join(dir, 'WORK-ORDER.md'), `# 收录工单:${id}(${pkg}@${meta.version})

上游:https://github.com/${repoSlug}(${meta.license ?? '许可证未知'})
${meta.description ? `简介:${meta.description}` : ''}
源码副本:${existsSync(upstream) ? `.cache/upstream/${id}/(顶层:${upstreamFiles.join(', ')})` : '克隆失败,读 npm 文档'}

## 要写的两个文件(户型规范,参照 generated/binary-write/)

1. **index.js** — MCP stdio 适配服务器
   - McpServer({ name: '${id}', version: '0.0.1' }) + StdioServerTransport
   - 切 2~4 个"工具级能力点":选这个库最常用、一轮对话内可完成的操作
   - registerTool:inputSchema 用 zod;description 中文、说清输入输出与边界
   - 错误路径返回 { isError: true, content: [{type:'text', text: ...}] },不抛裸异常
   - 只 import 锁定版本的 ${pkg}(package.json 已精确锁 ${meta.version}),不访问网络除非能力本身是网络
2. **smoke.mjs** — 冒烟(check() 计数模式,最后 process.exit(failures))
   - listTools 数量断言 → 每个工具至少一次**真实调用**并断言内容结果 → 至少一条错误路径被拒

## 完成后
   node scripts/index-add.mjs verify ${id}     # 质检(不过不入库)
   node scripts/index-add.mjs register ${id}   # 登记两个目录文件
`)
  return { id, pkg, version: meta.version, license: meta.license ?? 'UNKNOWN', workOrder: `generated/${id}/WORK-ORDER.md`, upstream: existsSync(upstream) ? `.cache/upstream/${id}` : null, next: `写 generated/${id}/{index.js,smoke.mjs},然后 verify` }
}

// ── verify ─────────────────────────────────────────────────────────────────
async function verify() {
  out(await verifyCore(target))
}

/**
 * The quality gate: install, smoke (exit 0 required), independent listTools
 * probe, report. Throws with the smoke output on failure — `auto` feeds that
 * text back to the agent so it can repair its own part.
 */
async function verifyCore(idArg) {
  const id = idArg
  const dir = join(REPO, 'generated', id ?? '')
  if (!id || !existsSync(dir)) die(`generated/${id} 不存在——先 scaffold`)
  for (const f of ['index.js', 'smoke.mjs', 'package.json']) {
    if (!existsSync(join(dir, f))) die(`缺 ${f}——按 WORK-ORDER.md 补齐`)
  }
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8', timeout: 300_000 })
  if (install.status !== 0) die(`npm install 失败:${(install.stderr ?? '').slice(-400)}`)
  const smoke = spawnSync('node', ['smoke.mjs'], { cwd: dir, encoding: 'utf8', timeout: 180_000, env: partEnv() })
  process.stderr.write(smoke.stdout ?? '')
  if (smoke.status !== 0) {
    const err = new Error(`smoke.mjs 退出码 ${smoke.status}——冒烟未过,不入库`)
    err.smokeOutput = `${smoke.stdout ?? ''}\n${smoke.stderr ?? ''}`.slice(-1500)
    throw err
  }

  // 独立实探:不信 smoke 自报,从装配器自身依赖直接 listTools
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const client = new Client({ name: 'index-add-verify', version: '0.0.1' })
  await client.connect(new StdioClientTransport({ command: 'node', args: [join(dir, 'index.js')], env: partEnv() }))
  const tools = (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description ?? '' }))
  await client.close()
  if (tools.length === 0) die('listTools 为空')

  mkdirSync(join(REPO, 'index', 'reports'), { recursive: true })
  writeFileSync(join(REPO, 'index', 'reports', `${id}.json`), JSON.stringify({
    id, verifiedAt: new Date().toISOString(), node: process.version,
    smoke: 'pass', tools,
  }, null, 2) + '\n')
  return { id, tools: tools.map((t) => t.name), report: `index/reports/${id}.json`, next: `register ${id}` }
}

// ── register ───────────────────────────────────────────────────────────────
function register() {
  out(registerCore(target))
}

/** Idempotent catalog registration; refuses without a passing verify report. */
function registerCore(idArg) {
  const id = idArg
  const dir = join(REPO, 'generated', id ?? '')
  const metaPath = join(dir, '.index-meta.json')
  const reportPath = join(REPO, 'index', 'reports', `${id}.json`)
  if (!existsSync(metaPath)) die('缺 .index-meta.json——先 scaffold')
  if (!existsSync(reportPath)) die('缺 verify 报告——质检门:先 verify 且必须通过')
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  if (report.smoke !== 'pass') die('verify 报告非 pass,拒绝登记')

  const changed = []
  // catalog.yml:追加条目(幂等)
  const catalogPath = join(REPO, 'index', 'catalog.yml')
  const catalog = readFileSync(catalogPath, 'utf8')
  if (!new RegExp(`^- id: ${id}$`, 'm').test(catalog)) {
    const toolLines = report.tools
      .map((t) => `    - { name: ${t.name}, description: ${JSON.stringify(t.description.replace(/\n[\s\S]*/, '').slice(0, 80))} }`)
      .join('\n')
    // A service part pins terms + rate limit where a library part pins a rev:
    // that IS its supply-chain provenance, and the BOM carries it to the client.
    const provenance = meta.kind === 'service'
      ? `  kind: service\n  service: ${meta.service}\n  provider: ${JSON.stringify(meta.provider ?? '')}\n  license: ${meta.license}\n  terms: ${JSON.stringify(meta.terms ?? '')}\n  rateLimit: ${JSON.stringify(meta.rateLimit ?? '')}\n  network: true\n`
      : `  repo: ${meta.repo}\n  rev: v${meta.version}\n  license: ${meta.license}\n`
    writeFileSync(catalogPath, catalog.replace(/\n*$/, '\n') + `
- id: ${id}
${provenance}  tools:
${toolLines}
`)
    changed.push('index/catalog.yml')
  }
  // capabilities.yml:mcp-servers 段插入连接配置(段尾 = capabilities: 键之前;幂等)
  const capsPath = join(REPO, 'capabilities.yml')
  const caps = readFileSync(capsPath, 'utf8')
  if (!new RegExp(`^  ${id}:$`, 'm').test(caps)) {
    const entry = `  ${id}:\n    transport: stdio\n    command: node\n    args: ['${join(REPO, 'generated', id, 'index.js')}']\n\n`
    if (!/^capabilities:$/m.test(caps)) die('capabilities.yml 缺 capabilities: 键,无法定位 mcp-servers 段尾')
    writeFileSync(capsPath, caps.replace(/^capabilities:$/m, entry + 'capabilities:'))
    changed.push('capabilities.yml')
  }
  return { id, registered: changed, note: changed.length > 0 ? 'git diff 后提交即完成收录;联邦缓存无此 server 键,下次装配自动实探' : '已登记过,无改动' }
}

// ── auto ───────────────────────────────────────────────────────────────────
// 全自动收录:CLI 调 agent(不内嵌 LLM——调用方本来就是 LLM 的这条设计在
// 这里推到极致:让 harness 里的真 agent 拿文件工具照工单写零件),写完过同
// 一道质检门;冒烟不过就把输出喂回同一会话让它自己修(零件自愈),仍不过则
// 拒绝入库。产出依旧是静态零件 + 目录条目,收录完 CLI 退出——过三判据。

/** One prompt to a fresh-or-existing session; resolves with the turn's reply. */
async function agentTurn(port, session, text, timeoutMs = 900_000) {
  const endsBefore = session.frames.filter((e) => e.type === 'turn/end').length
  const start = session.frames.length
  await session.rpc('session.prompt', { sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text }] })
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (session.frames.filter((e) => e.type === 'turn/end').length > endsBefore) {
      return session.frames.slice(start)
        .filter((e) => e.type === 'assistant/message')
        .map((e) => {
          const c = e.data?.message?.content ?? e.data?.content
          return Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text : '')).join('') : String(c ?? '')
        }).join('\n')
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return null
}

async function openSession(port, cwd) {
  const rpc = async (method, payload) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `auto-${Date.now()}-${Math.random().toString(36).slice(2)}`, method, payload }),
    })
    const j = await res.json()
    if (!j.result?.ok) throw new Error(`${method}: ${JSON.stringify(j.result?.error ?? j).slice(0, 400)}`)
    return j.result.value
  }
  const { sessionId } = await rpc('session.create', { cwd })
  const frames = []
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events.mux`)
  ws.onmessage = (m) => {
    try {
      const f = JSON.parse(String(m.data))
      if (f.payload?.type === 'session/event' && f.payload.sessionId === sessionId) frames.push(f.payload.event)
    } catch { /* non-JSON frame */ }
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('events.mux 连接失败')) })
  return { sessionId, frames, rpc, close: () => ws.close() }
}

async function auto() {
  const port = Number(flags.port ?? 3096)
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/`)
    if (!probe.ok) throw new Error(String(probe.status))
  } catch {
    die(`auto 需要一个在跑的 DSH web profile(端口 ${port});先启动:dsh --profile web`)
  }

  const sc = scaffoldCore(target, flags)
  console.error(`[auto] scaffold ok: ${sc.id} (${sc.pkg}@${sc.version}, ${sc.license})`)
  // The work order ends with the operator's own next steps (verify / register).
  // Handing those lines to the agent invites it to run the gates itself —
  // observed live: it did, and the pipeline's own run then hit the idempotent
  // no-op, making the report read as "nothing registered". The pipeline owns
  // the gates; the agent owns the two files.
  const workOrder = readFileSync(join(REPO, 'generated', sc.id, 'WORK-ORDER.md'), 'utf8')
    .replace(/\n## 完成后[\s\S]*$/, '\n')
  const session = await openSession(port, REPO)
  try {
    const brief = [
      `请按下面的工单,为零件 ${sc.id} 写两个文件:generated/${sc.id}/index.js 和 generated/${sc.id}/smoke.mjs。`,
      '写之前先读 generated/text-diff/{index.js,smoke.mjs} 学户型规范,再读上游源码/README 确认真实 API 与 ESM/CJS 导入方式(不要凭记忆写 API)。',
      '只写这两个文件,不要运行 npm install、不要跑 verify/register(质检与登记由流水线负责)、不要改其他文件。写完用 node --check 做语法检查。',
      '',
      '=== 工单 ===',
      workOrder,
    ].join('\n')
    const first = await agentTurn(port, session, brief)
    if (first === null) die('agent 写零件超时')
    console.error('[auto] agent 交付,进质检门…')

    let report
    try {
      report = await verifyCore(sc.id)
    } catch (error) {
      // 零件自愈:把冒烟原文喂回同一会话,让它自己定位并修,再过一次门。
      console.error('[auto] 冒烟未过,喂回失败输出让 agent 修复…')
      const repair = await agentTurn(port, session, [
        `质检未过:${error.message}`,
        '冒烟输出如下,请定位并修复(可以改 index.js 或 smoke.mjs,以真实行为为准;不要放宽断言来掩盖真实缺陷):',
        '```',
        error.smokeOutput ?? '(无输出)',
        '```',
        '修完只回复"已修复"。',
      ].join('\n'))
      if (repair === null) die('agent 修复超时')
      report = await verifyCore(sc.id)
    }
    const reg = registerCore(sc.id)
    // Report the catalog's STATE, not just what this call happened to write:
    // registration is idempotent, so an empty `wroteNow` means "already there",
    // which reads like failure unless the state is reported beside it.
    const inCatalog = new RegExp(`^- id: ${sc.id}$`, 'm').test(readFileSync(join(REPO, 'index', 'catalog.yml'), 'utf8'))
    out({
      id: sc.id, pkg: sc.pkg, version: sc.version, license: sc.license,
      tools: report.tools,
      catalogued: inCatalog,
      wroteNow: reg.registered,
      note: '全自动收录完成;git diff 后提交',
    })
  } finally {
    session.close()
  }
}

// ── check-all ──────────────────────────────────────────────────────────────
async function checkAll() {
  const gen = join(REPO, 'generated')
  const ids = readdirSync(gen).filter((d) => existsSync(join(gen, d, 'smoke.mjs')))
  // A network part's smoke makes real calls, so an offline run would report
  // failures that say nothing about the part. Those are SKIPPED and counted
  // separately — never folded into the pass count, because "did not run" and
  // "ran and passed" are different facts and the ledger must keep them apart.
  const online = await (async () => {
    try {
      const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR', { signal: AbortSignal.timeout(8000) })
      return r.ok
    } catch { return false }
  })()
  const results = []
  for (const id of ids) {
    let networkPart = false
    try {
      networkPart = JSON.parse(readFileSync(join(gen, id, '.index-meta.json'), 'utf8')).network === true
    } catch { /* library part or pre-metadata part */ }
    if (networkPart && !online) {
      results.push({ id, skipped: true })
      console.error(`  ↷ SKIP ${id}(网络零件,当前离线)`)
      continue
    }
    const r = spawnSync('node', ['smoke.mjs'], { cwd: join(gen, id), encoding: 'utf8', timeout: 180_000, env: partEnv() })
    results.push({ id, pass: r.status === 0 })
    console.error(`${r.status === 0 ? '  ✓' : '  ✗ FAIL'} ${id}`)
  }
  const failed = results.filter((r) => r.skipped !== true && !r.pass)
  const skipped = results.filter((r) => r.skipped === true)
  console.log(JSON.stringify({
    ok: failed.length === 0,
    total: results.length,
    ran: results.length - skipped.length,
    skipped: skipped.map((r) => r.id),
    failed: failed.map((r) => r.id),
    online,
  }))
  process.exit(failed.length === 0 ? 0 : 1)
}

if (cmd === 'scaffold') scaffold()
else if (cmd === 'verify') await verify()
else if (cmd === 'register') register()
else if (cmd === 'check-all') await checkAll()
else if (cmd === 'coverage') coverage()
else if (cmd === 'auto') await auto()
else die('用法:index-add.mjs scaffold <owner/repo> --pkg <npm名> | verify <id> | register <id> | check-all | coverage | auto <owner/repo> --pkg <npm名> [--id <id>] [--port 3096]')
