#!/usr/bin/env node
// app 三档泛化战役驱动器:每题一个真 DSH 会话,模拟用户发一句话需求、代答架构
// 检查点、跟到底,然后**独立复核**(不信 agent 自述)。判据全部机器可查,与
// bench/scenarios/generalization-9.json 的预注册预期比对。
// 用法:node bench/run-generalization.mjs [port] [只跑某几题,如 A1,B3]
//
// 复核与判卷**一律来自 bench/lib/generalization-grade.mjs**,本文件不留私有副本。
// 病史(2026-08-25 第二次):第一次修"判卷器按目录名猜实例"时只改了离线重判器,
// 驱动器里那份原样留着,文档却写了"两者共用一份实现"——于是现场判分继续跑旧代码,
// 而我据此又报了一轮结论。**"两份实现必然走偏"这句话,我是在自己身上验的第二遍。**
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { audit, cleanSlate, grade } from './lib/generalization-grade.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.argv[2] ?? 3097)
const ONLY = (process.argv[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const SPEC = JSON.parse(readFileSync(join(REPO, 'bench', 'scenarios', 'generalization-9.json'), 'utf8'))
const OUT_DIR = join(REPO, 'bench', 'results', '2026-08-26-generalization-v4')
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


// 每轮开跑前清场:上轮残留的同名 preset/app 会触发"同名复用"(正常特性),让这轮
// 零重建、也不再验收——实录:A2 二轮 132s 未验收,就是被上轮残留复用了。
//
// **只清这轮真要跑的题**(2026-08-25 实录:只跑 A 档时清场把 B/C 的工件一起抹了,
// 而离线重判是照盘上现状重算的——于是 B1/B2 被重判成"什么都没交",凭空多出两条
// 假回归。清场的作用域必须跟着 ONLY 走)。
const todo = SPEC.scenarios.filter((s) => ONLY.length === 0 || ONLY.includes(s.id))
const wiped = cleanSlate(todo, { corpusDirs: [CORPUS] })
console.log(wiped.length > 0 ? `清场:删除 ${wiped.length} 个上轮残留(${wiped.slice(0, 4).join(', ')}${wiped.length > 4 ? ' …' : ''})` : '清场:无残留')

// ── 主循环 ────────────────────────────────────────────────────────────────────
const results = []
for (const scn of todo) {
  console.log(`\n═══ ${scn.id} [${scn.tier}] ${scn.name} ═══`)
  let run, aud, g
  try {
    run = await runOne(scn)
    aud = await audit(scn, PORT)
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
