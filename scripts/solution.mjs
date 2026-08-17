#!/usr/bin/env node
/**
 * Solution pack —— FDE 的交付单元。
 *
 * 一个 preset 是一个 agent;一次客户交付通常是**几个 agent + 客户知识 +
 * 部署参数 + 凭证清单 + 验收记录**。方案包把这些收进一份可 git、可版本化、
 * 可在另一台机器一键重建的清单(solution.yml)。
 *
 * 判据回照(DESIGN.md 三条):
 *   - 运行时:apply 跑完就退出,产出是 preset 目录 —— 装配器不在会话期在场 ✓
 *   - 步骤号:清单声明"有哪些 agent、各自要什么",不含执行顺序 ✓
 *   - 产物:solution.yml + 生成的 preset + 交付报告,全是静态工件 ✓
 *
 * 用法:
 *   node scripts/solution.mjs init <name> --client <客户> [--catalog <path>]
 *   node scripts/solution.mjs apply <solution.yml> [--port 3096] [--param k=v ...]
 *   node scripts/solution.mjs handover <solution.yml>   # 生成交付报告
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import yaml from 'js-yaml'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const [cmd, target, ...rest] = process.argv.slice(2)
const flags = {}
const repeatable = { param: [] }
for (let i = 0; i < rest.length; i += 2) {
  if (!rest[i]?.startsWith('--')) continue
  const key = rest[i].slice(2)
  if (key === 'param') repeatable.param.push(rest[i + 1])
  else flags[key] = rest[i + 1]
}

const die = (msg) => { console.log(JSON.stringify({ ok: false, error: msg })); process.exit(1) }
const out = (obj) => { console.log(JSON.stringify({ ok: true, ...obj }, null, 2)) }

const presetRoot = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.agent-presets')

// ── init ───────────────────────────────────────────────────────────────────
function init() {
  const name = target
  if (name === undefined || name === '') die('用法:solution.mjs init <name> --client <客户>')
  const dir = join(REPO, 'solutions', name)
  const file = join(dir, 'solution.yml')
  if (existsSync(file) && flags.force !== 'yes') die(`方案已存在:${file}`)
  mkdirSync(dir, { recursive: true })
  const doc = {
    name,
    client: flags.client ?? '(客户名)',
    version: '0.1.0',
    catalog: flags.catalog ?? (flags.client !== undefined ? `catalogs/${flags.client}/capabilities.yml` : 'capabilities.yml'),
    // 参数是部署事实(时区/语言/目录),不是秘密;秘密只在 secrets 里点名。
    params: { timezone: 'Asia/Shanghai', language: 'zh' },
    agents: [
      { id: `${name}-assistant`, requirement: '（把客户的一句话需求写在这里）' },
    ],
  }
  writeFileSync(file, `# ${name} —— 方案包清单(FDE 交付单元)\n`
    + `# apply 会按 agents 逐个装配;凭证只声明不落值,验收结果写进 handover 报告。\n`
    + yaml.dump(doc, { lineWidth: -1 }))
  out({ name, file: file.replace(REPO + '/', ''), next: `编辑 agents 后:solution.mjs apply ${file.replace(REPO + '/', '')}` })
}

// ── apply ──────────────────────────────────────────────────────────────────
/** One assemble over the public wire, driven exactly like a user's session. */
async function assembleOne(port, requirement, id, params) {
  const rpc = async (method, payload) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `sol-${Date.now()}-${Math.random().toString(36).slice(2)}`, method, payload }),
    })
    const j = await res.json()
    if (!j.result?.ok) throw new Error(`${method}: ${JSON.stringify(j.result?.error ?? j).slice(0, 300)}`)
    return j.result.value
  }
  const { sessionId } = await rpc('session.create', { cwd: REPO })
  const frames = []
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events.mux`)
  ws.onmessage = (m) => {
    try {
      const f = JSON.parse(String(m.data))
      if (f.payload?.type === 'session/event' && f.payload.sessionId === sessionId) frames.push(f.payload.event)
    } catch { /* non-JSON frame */ }
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('events.mux 连接失败')) })
  const paramText = Object.keys(params).length > 0 ? `,params 传 ${JSON.stringify(params)}` : ''
  await rpc('session.prompt', {
    sessionId, mode: 'queue',
    content: [{ type: 'text', text: `请调用 assemble 工具,requirement 为"${requirement}",name 参数用 "${id}"${paramText}。工具返回后直接复述结果,不要做其他探索。` }],
  })
  const t0 = Date.now()
  while (Date.now() - t0 < 12 * 60_000 && !frames.some((e) => e.type === 'turn/end')) {
    await new Promise((r) => setTimeout(r, 2000))
  }
  ws.close()
  const toolText = frames.filter((e) => e.type === 'tool/result')
    .map((e) => JSON.stringify(e.data ?? {})).find((x) => x.includes('自动验证')) ?? ''
  const verdict = toolText.includes('自动验证:PASS') ? 'PASS'
    : toolText.includes('自动验证:FAIL') ? 'FAIL'
      : toolText.includes('自动验证:跳过') ? 'SKIPPED' : 'UNKNOWN'
  return { verdict, line: (toolText.match(/自动验证[^\\"]*/) ?? [''])[0].slice(0, 300), wallSeconds: Math.round((Date.now() - t0) / 1000) }
}

async function apply() {
  const file = target
  if (file === undefined || !existsSync(file)) die('用法:solution.mjs apply <solution.yml> [--port 3096]')
  const doc = yaml.load(readFileSync(file, 'utf8'))
  const port = Number(flags.port ?? 3096)
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/`)
    if (!probe.ok) throw new Error(String(probe.status))
  } catch {
    die(`apply 需要一个在跑的 DSH web profile(端口 ${port}),且其 assembler 的 catalogPath 指向 ${doc.catalog}`)
  }
  // CLI params override the manifest's — the same solution deployed to a
  // second tenant differs by parameters, not by a forked manifest.
  const params = { ...(doc.params ?? {}) }
  for (const p of repeatable.param) {
    const i = String(p).indexOf('=')
    if (i > 0) params[String(p).slice(0, i)] = String(p).slice(i + 1)
  }

  const results = []
  for (const agent of doc.agents ?? []) {
    process.stderr.write(`[solution] 装配 ${agent.id} …\n`)
    try {
      const r = await assembleOne(port, agent.requirement, agent.id, params)
      process.stderr.write(`[solution]   ${agent.id}: ${r.verdict} (${r.wallSeconds}s)\n`)
      results.push({ id: agent.id, ...r })
    } catch (error) {
      process.stderr.write(`[solution]   ${agent.id}: ERROR ${error.message.slice(0, 120)}\n`)
      results.push({ id: agent.id, verdict: 'ERROR', line: error.message.slice(0, 200), wallSeconds: 0 })
    }
  }
  const applied = { appliedAt: new Date().toISOString(), port, params, results }
  writeFileSync(join(dirname(file), 'last-apply.json'), JSON.stringify(applied, null, 2) + '\n')
  const bad = results.filter((r) => r.verdict === 'FAIL' || r.verdict === 'ERROR')
  out({ name: doc.name, agents: results.length, results, params, ok: bad.length === 0, failed: bad.map((r) => r.id) })
  process.exit(bad.length === 0 ? 0 : 1)
}

// ── handover ───────────────────────────────────────────────────────────────
/**
 * The handover document: what was delivered, what it is made of, what the
 * operator must still configure. Assembled from the artifacts themselves
 * (each preset's parts.lock.yml) rather than from anyone's memory.
 */
function handover() {
  const file = target
  if (file === undefined || !existsSync(file)) die('用法:solution.mjs handover <solution.yml>')
  const doc = yaml.load(readFileSync(file, 'utf8'))
  const root = presetRoot()
  const agents = []
  const allSecrets = new Map()
  const allParts = new Map()
  const allKnowledge = new Map()
  for (const a of doc.agents ?? []) {
    const lockPath = join(root, a.id, 'parts.lock.yml')
    if (!existsSync(lockPath)) {
      agents.push({ id: a.id, status: '未装配(找不到 parts.lock.yml)' })
      continue
    }
    const lock = yaml.load(readFileSync(lockPath, 'utf8'))
    for (const p of lock.parts ?? []) {
      // Knowledge capabilities have their own section with source+version;
      // listing them again as parts with an empty origin reads like missing
      // provenance rather than "documented elsewhere".
      if (p.via === 'knowledge') continue
      const key = p.server ?? p.capability
      if (!allParts.has(key)) {
        allParts.set(key, {
          part: key,
          ...(p.repo !== undefined ? { repo: p.repo, rev: p.rev } : {}),
          ...(p.service !== undefined ? { service: p.service, terms: p.terms, rateLimit: p.rateLimit } : {}),
          license: p.license,
        })
      }
    }
    for (const sec of lock.requiredSecrets ?? []) {
      if (!allSecrets.has(sec.env)) allSecrets.set(sec.env, sec)
    }
    for (const k of lock.knowledge ?? []) {
      if (!allKnowledge.has(k.id)) allKnowledge.set(k.id, k)
    }
    agents.push({
      id: a.id, status: '已装配',
      requirement: a.requirement,
      parts: (lock.parts ?? []).length,
      preset: join(root, a.id, 'agent.cordis.yml'),
    })
  }
  const lastApply = existsSync(join(dirname(file), 'last-apply.json'))
    ? JSON.parse(readFileSync(join(dirname(file), 'last-apply.json'), 'utf8'))
    : null

  const md = [
    `# ${doc.name} 交付报告`,
    '',
    `- 客户:${doc.client ?? '(未填)'}`,
    `- 方案版本:${doc.version ?? '(未填)'}`,
    `- 生成时间:${new Date().toISOString()}`,
    lastApply === null ? '- 最近一次装配:(未记录)' : `- 最近一次装配:${lastApply.appliedAt}`,
    '',
    '## 交付的 agent',
    '',
    '| agent | 状态 | 零件数 | 验收 |',
    '|---|---|---|---|',
    ...agents.map((a) => {
      const v = lastApply?.results?.find((r) => r.id === a.id)
      return `| ${a.id} | ${a.status} | ${a.parts ?? '-'} | ${v?.verdict ?? '-'} |`
    }),
    '',
    '## 部署参数',
    '',
    ...Object.entries(lastApply?.params ?? doc.params ?? {}).map(([k, v]) => `- \`${k}\` = ${v}`),
    '',
    '## 待配置凭证',
    '',
    allSecrets.size === 0 ? '(本方案不需要凭证)' : '| 变量 | 用途 | 状态 |\n|---|---|---|',
    ...[...allSecrets.values()].map((s) => `| \`${s.env}\` | ${s.purpose ?? ''} | ${s.configured ? '已配置' : s.optional ? '可选(未配则降级)' : '**待配置**'} |`),
    '',
    '## 知识包',
    '',
    allKnowledge.size === 0 ? '(本方案不含知识包)' : '| 包 | 篇数 | 来源 | 版本 |\n|---|---|---|---|',
    ...[...allKnowledge.values()].map((k) => `| ${k.id} | ${k.docs} | ${k.source ?? ''} | ${k.version ?? ''} |`),
    '',
    '## 供应链清单(BOM 汇总)',
    '',
    '| 零件 | 出处 | 许可 |',
    '|---|---|---|',
    ...[...allParts.values()].map((p) => {
      const origin = p.repo !== undefined ? `${p.repo}@${p.rev}` : (p.service ?? '-')
      return `| ${p.part} | ${origin} | ${p.license ?? '-'} |`
    }),
    '',
    '## 重建方式',
    '',
    '```bash',
    `node scripts/solution.mjs apply ${file.replace(REPO + '/', '')} --port <端口> [--param k=v]`,
    '```',
    '',
    '同一方案交付给另一个租户:改 `--param`、配另一套凭证,零件与知识不变。',
    '',
  ].join('\n')
  const outPath = join(dirname(file), 'HANDOVER.md')
  writeFileSync(outPath, md)
  out({
    name: doc.name, agents: agents.length,
    parts: allParts.size, secrets: allSecrets.size, knowledge: allKnowledge.size,
    handover: outPath.replace(REPO + '/', ''),
  })
}

if (cmd === 'init') init()
else if (cmd === 'apply') await apply()
else if (cmd === 'handover') handover()
else die('用法:solution.mjs init <name> --client <客户> | apply <solution.yml> [--port] [--param k=v] | handover <solution.yml>')
