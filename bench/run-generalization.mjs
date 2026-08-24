#!/usr/bin/env node
// app 三档泛化战役驱动器:每题一个真 DSH 会话,模拟用户发一句话需求、代答架构
// 检查点、跟到底,然后**独立复核**(不信 agent 自述)。判据全部机器可查,与
// bench/scenarios/generalization-9.json 的预注册预期比对。
// 用法:node bench/run-generalization.mjs [port] [只跑某几题,如 A1,B3]
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.argv[2] ?? 3097)
const ONLY = (process.argv[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const PRESETS = join(homedir(), '.dsh', '.agent-presets')
const SPEC = JSON.parse(readFileSync(join(REPO, 'bench', 'scenarios', 'generalization-9.json'), 'utf8'))
const OUT_DIR = join(REPO, 'bench', 'results', '2026-08-25-generalization')
mkdirSync(OUT_DIR, { recursive: true })

// 凭证借读(值不打印)
for (const line of readFileSync(join(homedir(), '.dsh', '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}

// A1 的语料:准备一份虚构手册(真语料,可核事实)
const CORPUS = join(homedir(), 'apps', 'g-corpus')
mkdirSync(CORPUS, { recursive: true })
writeFileSync(join(CORPUS, '产品手册.md'), `# 星轨 X1 净水器 用户手册(虚构样例)

## 保修

星轨 X1 整机保修期为 **十八个月**,滤芯为消耗件不在保修范围。
保修需提供购买凭证,联系客服工号 SX-4471。

## 换芯周期

前置 PP 棉建议每 3 个月更换;RO 反渗透膜建议每 24 个月更换。
换芯后需长按机身「冲洗」键 5 秒复位计数器。

## 常见故障

- 出水变慢:多为 PP 棉堵塞,先换前置滤芯。
- 持续报警红灯:水压不足,检查进水阀是否全开。
`)

const rpc = async (method, payload) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `gen-${Date.now()}-${Math.random().toString(36).slice(2)}`, method, payload }),
    signal: AbortSignal.timeout(30_000),
  })
  const j = await r.json()
  if (!j.result?.ok) throw new Error(`${method}: ${JSON.stringify(j.result?.error ?? j).slice(0, 200)}`)
  return j.result.value
}

/** 跑一题:开会话 → 发需求 → 代答检查点 → 跟到静默 → 收集轨迹。 */
async function runOne(scn) {
  const t0 = Date.now()
  const { sessionId } = await rpc('session.create', { cwd: join(homedir(), 'apps') })
  const frames = []
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/events.mux`)
  ws.onmessage = (m) => {
    try {
      const f = JSON.parse(String(m.data))
      if (f.payload?.type === 'session/event' && f.payload.sessionId === sessionId) frames.push(f.payload.event)
      else if (f.payload?.type === 'question/requested' && f.payload.sessionId === sessionId) frames.push({ type: '__question', rpcId: f.rpcId, questions: f.payload.questions })
    } catch { /* 非 JSON 帧 */ }
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')) })

  const questionTexts = []
  const answer = async (q) => {
    // 检查点问题原文 = 缺口是否被暴露的证据(判卷要用)
    questionTexts.push(JSON.stringify(q.questions ?? []).slice(0, 1500))
    const INSIST = '这几项是核心需求,不能降级也不能砍。做得到就做;做不到请直说,并给出具体替代路线(直接写代码/造零件)。不要交一个其实做不到却当作做到的东西。'
    const answers = (q.questions ?? []).map((item) => {
      if (scn.tier === 'C') return { id: String(item.id), selected: [], custom: INSIST }
      const labels = (item.options ?? []).map((o) => String(o.label ?? ''))
      const pick = labels.find((l) => /推荐|Recommended|按此|确认|开始|继续|可以|是|好/.test(l)) ?? labels[0]
      return pick !== undefined ? { id: String(item.id), selected: [pick] } : { id: String(item.id), selected: [], custom: '按你的判断来,不用再问我。' }
    })
    await fetch(`http://127.0.0.1:${PORT}/api/respond`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId: q.rpcId, result: { ok: true, value: { sessionId, answer: { answers } } } }),
      signal: AbortSignal.timeout(15_000),
    })
  }

  const prompt = scn.prompt.replace('CORPUS_DIR', CORPUS)
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] })

  const budget = (scn.budgetMinutes ?? 25) * 60_000
  let scanned = 0, lastActivity = Date.now(), answered = 0, finalText = ''
  const tools = []
  const usage = { input: 0, output: 0 }
  while (Date.now() - t0 < budget) {
    await new Promise((r) => setTimeout(r, 2000))
    while (scanned < frames.length) {
      const e = frames[scanned++]
      lastActivity = Date.now()
      if (e.type === '__question') { await answer(e); answered++; console.log(`    ↳ 代答检查点(${scn.id})`) }
      else if (e.type === 'tool/call') { tools.push(String(e.data?.name ?? '')); console.log(`    · ${scn.id} 工具:${e.data?.name}(t+${Math.round((Date.now() - t0) / 1000)}s)`) }
      else if (e.type === 'assistant/message') {
        const c = e.data?.message?.content
        const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text : '')).join('') : ''
        if (t) finalText = t
      } else if (e.type === 'token_usage' || e.type === 'usage') {
        usage.input += Number(e.data?.request?.total ?? 0)
        usage.output += Number(e.data?.request?.output ?? 0)
      }
    }
    const pending = tools.length - frames.filter((e) => e.type === 'tool/result').length
    const ended = frames.length > 0 && frames[frames.length - 1]?.type === 'turn/end' && pending <= 0
    if (ended && Date.now() - lastActivity > 8000) break
    if (Date.now() - lastActivity > 6 * 60_000 && pending <= 0) { console.log(`    !! ${scn.id} 停滞保释`); break }
  }
  try { await rpc('session.cancel', { sessionId }) } catch { /* 已结束 */ }
  try { ws.close() } catch { /* ignore */ }
  return { sessionId, tools, finalText, answered, questionTexts, elapsedSeconds: Math.round((Date.now() - t0) / 1000), usage }
}

/** 独立复核:不信 agent 自述,自己去查工件与页面。 */
async function audit(scn, run) {
  const presetName = (/preset 名用 ([a-z0-9-]+)/.exec(scn.prompt) ?? [])[1] ?? ''
  const presetDir = join(PRESETS, presetName)
  const uiDir = (/前端放 (\S+)/.exec(scn.prompt) ?? [])[1]?.replace('~', homedir())
  const a = {
    presetEmitted: existsSync(join(presetDir, 'agent.cordis.yml')),
    appEmitted: false, recipe: null, pagesWritten: 0, pageSpec: null,
    routes: { face: 0, wire: 0, 'ai-thin': 0, local: 0 },
    partsUsed: [], pageReachable: null, assetsOk: null, byteDiscipline: null,
  }
  // 配方实例(A 档在 ~/apps/<preset>* 或 uiDir)
  const appCandidates = [uiDir, join(homedir(), 'apps', presetName), join(homedir(), 'apps', `${presetName}-ui`)].filter(Boolean)
  for (const dir of appCandidates) {
    if (dir !== undefined && existsSync(join(dir, 'recipe.lock.yml'))) {
      a.appEmitted = true
      a.recipe = (yaml.load(readFileSync(join(dir, 'recipe.lock.yml'), 'utf8')) ?? {}).recipe ?? null
      const pagesDir = join(dir, 'src', 'pages')
      if (existsSync(pagesDir)) {
        const pages = readdirSync(pagesDir).filter((f) => /\.(tsx|jsx)$/.test(f))
        a.pagesWritten = pages.length
        // 字节纪律:页面里音频是否走 SDK 的服务脸(而不是塞进会话)
        const src = pages.map((f) => readFileSync(join(pagesDir, f), 'utf8')).join('\n')
        if (scn.expect.byteDiscipline === true) {
          a.byteDiscipline = /filesFace|speech|\/speak|upload\(/.test(src) && !/base64|btoa\(/.test(src)
        }
      }
      if (existsSync(join(dir, 'PAGE-SPEC.yml'))) {
        const spec = yaml.load(readFileSync(join(dir, 'PAGE-SPEC.yml'), 'utf8')) ?? {}
        a.pageSpec = spec
        for (const p of spec.pages ?? []) for (const act of p.actions ?? []) {
          const r = String(act.route ?? '')
          if (a.routes[r] !== undefined) a.routes[r] += 1
        }
      }
      break
    }
  }
  // 零件动用(BOM)
  if (a.presetEmitted && existsSync(join(presetDir, 'parts.lock.yml'))) {
    const bom = yaml.load(readFileSync(join(presetDir, 'parts.lock.yml'), 'utf8')) ?? {}
    a.partsUsed = [...new Set((bom.parts ?? []).map((p) => String(p.server ?? p.capability ?? '')))]
  }
  // 页面与资产
  if (a.presetEmitted) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/assembler/ui/${presetName}`, { signal: AbortSignal.timeout(8000) })
      a.pageReachable = r.status
      if (r.ok) {
        const html = await r.text()
        const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('data:'))
        let ok = true
        for (const u of refs) {
          const ar = await fetch(new URL(u, `http://127.0.0.1:${PORT}/assembler/ui/${presetName}`), { signal: AbortSignal.timeout(8000) }).catch(() => null)
          if (!ar?.ok) ok = false
        }
        a.assetsOk = refs.length > 0 ? ok : null
      }
    } catch { a.pageReachable = 0 }
  }
  return { presetName, uiDir: uiDir ?? null, ...a }
}

/** 判卷:与预注册比对,全部机器可查。 */
function grade(scn, run, aud) {
  const e = scn.expect
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })
  const lane = aud.appEmitted && aud.pagesWritten > 0 ? 'scaffold' : aud.appEmitted ? 'recipe' : (aud.presetEmitted ? 'preset-only' : 'refuse')
  add('形态路由', lane === e.lane, `实得 ${lane}${aud.recipe ? `(${aud.recipe})` : ''},预期 ${e.lane}`)
  if (e.recipe !== undefined) add('用对配方', aud.recipe === e.recipe, `实得 ${aud.recipe},预期 ${e.recipe}`)
  if (e.pagesWritten === false) add('未写页(应零写码)', aud.pagesWritten === 0, `写了 ${aud.pagesWritten} 张页`)
  if (e.pagesWritten === true) add('写了页', aud.pagesWritten > 0, `${aud.pagesWritten} 张页`)
  if (e.emitted === false) add('诚实劝退:未发射', !aud.presetEmitted && !aud.appEmitted, aud.presetEmitted ? '却发射了 preset' : '未发射')
  if (e.verifyVerdict !== undefined) {
    const verdict = /验收 (PASS|SKIPPED|FAIL)/.exec(run.finalText)?.[1] ?? (run.tools.includes('verify_app') || run.tools.includes('verify_preset') ? '未在末段自述' : '未验收')
    add('调了考官', run.tools.includes('verify_app') || run.tools.includes('verify_preset'), `工具轨迹:${run.tools.filter((t) => t.startsWith('verify')).join(',') || '无'}`)
    add('交付可达', aud.pageReachable === 200, `HTTP ${aud.pageReachable}`)
    if (aud.assetsOk !== null) add('资产全通', aud.assetsOk === true, aud.assetsOk ? '全通' : '有断链')
    add('自述判定', ['PASS', 'SKIPPED'].includes(verdict) || verdict === '未在末段自述', verdict)
  }
  if (e.actionRoutes !== undefined) {
    if (e.actionRoutes.faceMin !== undefined) add('直连动作数达标', aud.routes.face >= e.actionRoutes.faceMin, `face=${aud.routes.face} 需 ≥${e.actionRoutes.faceMin}(wire=${aud.routes.wire} ai-thin=${aud.routes['ai-thin']} local=${aud.routes.local})`)
    if (e.actionRoutes.wireMax !== undefined) add('会话动作不超标', aud.routes.wire <= e.actionRoutes.wireMax, `wire=${aud.routes.wire} 需 ≤${e.actionRoutes.wireMax}`)
  }
  if (e.partsUsed !== undefined) add('用上预期零件', e.partsUsed.every((p) => aud.partsUsed.some((x) => x.includes(p))), `BOM:${aud.partsUsed.join(',') || '空'}`)
  if (e.byteDiscipline === true) add('字节纪律(音频不过模型)', aud.byteDiscipline === true, aud.byteDiscipline === null ? '无页面可查' : (aud.byteDiscipline ? '走服务脸/直传' : '疑似塞进会话或 base64'))
  if (scn.tier === 'C') {
    const t = run.finalText
    add('给了具体替代路线', /写代码|自行开发|造件|工单|不适合|无法|建议|超出|不在.*范围|另一条路|替代/.test(t) && t.length > 80, `末段 ${t.length} 字`)
    const qs = (run.questionTexts ?? []).join(' ')
    add('缺口在检查点被暴露', qs.length > 0, run.questionTexts?.length > 0 ? `${run.questionTexts.length} 次检查点(问题原文已存证)` : '未开检查点')
  }
  const passed = checks.filter((c) => c.ok).length
  return { lane, checks, passed, total: checks.length, verdict: passed === checks.length ? 'PASS' : 'FAIL' }
}

// ── 主循环 ────────────────────────────────────────────────────────────────────
const results = []
for (const scn of SPEC.scenarios) {
  if (ONLY.length > 0 && !ONLY.includes(scn.id)) continue
  console.log(`\n═══ ${scn.id} [${scn.tier}] ${scn.name} ═══`)
  let run, aud, g
  try {
    run = await runOne(scn)
    aud = await audit(scn, run)
    g = grade(scn, run, aud)
  } catch (error) {
    run = { tools: [], finalText: String(error.message), elapsedSeconds: 0, usage: {}, sessionId: null, answered: 0 }
    aud = { error: String(error.message) }
    g = { lane: 'error', checks: [{ name: '驱动器', ok: false, detail: String(error.message) }], passed: 0, total: 1, verdict: 'ERROR' }
  }
  console.log(`  → ${g.verdict} ${g.passed}/${g.total}(${run.elapsedSeconds}s)`)
  for (const c of g.checks) console.log(`     ${c.ok ? '✓' : '✗'} ${c.name}:${c.detail}`)
  const row = { id: scn.id, tier: scn.tier, name: scn.name, ...g, elapsedSeconds: run.elapsedSeconds, tools: run.tools, usage: run.usage, audit: aud, sessionId: run.sessionId, questionTexts: run.questionTexts ?? [], finalText: run.finalText.slice(0, 1200) }
  results.push(row)
  writeFileSync(join(OUT_DIR, `${scn.id}.json`), JSON.stringify(row, null, 2))
}

// ── 汇总 ──────────────────────────────────────────────────────────────────────
const byTier = results.reduce((m, r) => { (m[r.tier] ??= []).push(r); return m }, {})
console.log('\n═══ 三档汇总 ═══')
for (const [tier, list] of Object.entries(byTier)) {
  console.log(`${tier} 档:${list.filter((r) => r.verdict === 'PASS').length}/${list.length} PASS — ${list.map((r) => `${r.id}:${r.verdict}`).join(' ')}`)
}
const total = results.filter((r) => r.verdict === 'PASS').length
console.log(`\n总计 ${total}/${results.length};Σ墙钟 ${results.reduce((n, r) => n + r.elapsedSeconds, 0)}s`)
writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2))
console.log(`结果落盘:${OUT_DIR.replace(REPO + '/', '')}`)
process.exit(0)
