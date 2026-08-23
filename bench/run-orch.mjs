// B 臂(编排模式)驱动器:模拟人类经主 agent 对话触发编排式装配。
// 与 run-campaign.mjs 的差异:
//  1. 主 agent 会先在对话里出架构、可能停轮等用户确认——驱动器扮演"看过了,
//     继续"的用户(这正是 B 臂的交互价值,如实模拟而非绕过);
//  2. 终局判据 = verify_preset 的结果文本(验收 PASS/FAIL/…),不是 assemble;
//  3. 采集主 agent 侧 token 用量(usage 形状的帧字段求和)+ 帧类型分布。
// 用法:node run-orch.mjs <scenarios.json> <outdir> [lanes=1] [only=ids] [port=3098]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const [file, outdir, lanesArg, onlyArg, portArg] = process.argv.slice(2)
const PORT = Number(portArg ?? 3098) || 3098
const TURN_TIMEOUT_MS = 25 * 60_000
const MAX_NUDGES = 4
const lanes = Number(lanesArg ?? 1) || 1
mkdirSync(outdir, { recursive: true })
let scenarios = JSON.parse(readFileSync(file, 'utf8'))
if (onlyArg) {
  const keep = new Set(onlyArg.split(','))
  scenarios = scenarios.filter((s) => keep.has(s.id))
}

function humanPrompt(s, i) {
  const namePart = s.name ? `,preset 名字就叫「${s.name}」` : ''
  const paramPart = s.params ? `。装配参数用:${JSON.stringify(s.params)}` : ''
  const styles = [
    `请帮我装配一个 agent:${s.req}${namePart}${paramPart}`,
    `${s.req}${namePart}${paramPart}。装配好之后告诉我怎么用。`,
    `帮我装一个 agent:${s.req}${namePart}${paramPart}`,
  ]
  return styles[i % styles.length]
}

// 深挖一个对象里的 usage 形状字段(不同事件把 usage 放的位置不可预知,机械递归找)。
function findUsages(obj, out, depth = 0) {
  if (obj === null || typeof obj !== 'object' || depth > 6) return
  if (typeof obj.inputTokens === 'number' || typeof obj.outputTokens === 'number') {
    out.push({
      inputTokens: obj.inputTokens ?? 0, outputTokens: obj.outputTokens ?? 0,
      reasoningTokens: obj.reasoningTokens ?? 0, cacheReadTokens: obj.cacheReadTokens ?? 0,
    })
    return
  }
  for (const v of Object.values(obj)) findUsages(v, out, depth + 1)
}

async function runOne(s, idx) {
  const t0 = Date.now()
  const rec = { scenario: s, arm: 'B-orchestrated', port: PORT, startedAt: new Date().toISOString() }
  let ws = null
  try {
    const rpc = async (m, p) => {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/${m}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: `${s.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`, method: m, payload: p }),
        signal: AbortSignal.timeout(30_000),
      })
      const j = await r.json()
      if (!j.result?.ok) throw new Error(`${m}: ${JSON.stringify(j.result?.error ?? '').slice(0, 200)}`)
      return j.result.value
    }
    const { sessionId } = await rpc('session.create', { cwd: process.cwd() })
    rec.sessionId = sessionId
    const frames = []
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/events.mux`)
    ws.onmessage = (m) => {
      try {
        const f = JSON.parse(String(m.data))
        if (f.payload?.type === 'session/event' && f.payload.sessionId === sessionId) frames.push(f.payload.event)
        // ask_user_question 走 server-request 通道(question/requested + rpcId 回执),
        // 不是会话事件;queue 一条文本回不了它(实测:回答被拼进下一轮收件箱,
        // 挂起的 ask 永远等不到答案,整轮挂死)。这里收进 frames 由主循环应答。
        else if (f.payload?.type === 'question/requested' && f.payload.sessionId === sessionId) {
          frames.push({ type: '__question', rpcId: f.rpcId, questions: f.payload.questions })
        }
      } catch {}
    }
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')) })
    // 模拟用户答结构化问题:优先"确认/继续/推荐"味道的选项,否则第一项;多选取一项。
    const answerQuestion = async (q) => {
      const answers = (q.questions ?? []).map((item) => {
        const labels = (item.options ?? []).map((o) => String(o.label ?? ''))
        const pick = labels.find((l) => /推荐|Recommended|确认|开始|继续|可以|是|好/.test(l)) ?? labels[0]
        return pick !== undefined
          ? { id: String(item.id), selected: [pick] }
          : { id: String(item.id), selected: [], custom: '你看着办,按最典型的场景来就行,不用再问我了。' }
      })
      const r = await fetch(`http://127.0.0.1:${PORT}/api/respond`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-response', rpcId: q.rpcId, result: { ok: true, value: { sessionId, answer: { answers } } } }),
        signal: AbortSignal.timeout(15_000),
      })
      return await r.json()
    }
    rec.prompt = humanPrompt(s, idx)
    await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: rec.prompt }] })

    const toolCalled = (name) => frames.some((e) => e.type === 'tool/call' && e.data?.name === name)
    const verdictSoFar = () => {
      for (const e of frames.filter((x) => x.type === 'tool/result')) {
        const t = JSON.stringify(e.data ?? {})
        const m = t.match(/验收 (PASS|FAIL|SKIPPED|ERRORED)/)
        if (m) return m[1]
      }
      return null
    }

    let expectedEnds = 1
    let nudges = 0
    let clarified = 0
    let bailed = false
    let scanned = 0
    let waitingSince = Date.now()
    while (Date.now() - t0 < TURN_TIMEOUT_MS && !bailed) {
      for (; scanned < frames.length && !bailed; scanned++) {
        const ev = frames[scanned]
        if (ev?.type === 'approval/asked') {
          rec.approvalAsked = JSON.stringify(ev.data ?? {}).slice(0, 400)
          rec.bailedOnApproval = true
          bailed = true
          break
        }
        if (ev?.type === '__question') {
          if (clarified >= 3) { rec.tooManyQuestions = true; bailed = true; break }
          clarified++
          rec.clarifyQuestions = rec.clarifyQuestions ?? []
          rec.clarifyQuestions.push(JSON.stringify(ev.questions ?? []).slice(0, 400))
          try {
            const receipt = await answerQuestion(ev)
            rec.answerReceipts = rec.answerReceipts ?? []
            rec.answerReceipts.push(JSON.stringify(receipt).slice(0, 120))
          } catch (e) {
            rec.answerError = String(e).slice(0, 200)
          }
          waitingSince = Date.now()
        }
      }
      // ask 应答后的陪等判据是"停滞"不是"耗时":有新帧 = agent 在干活;且有
      // 未归的 tool/call(如 verify_preset 正在跑独立探针会话——主会话静默是
      // 正常的,s22 实测被误杀)时绝不保释,工具自己有截止期。
      if (frames.length > (rec.__lastFrameCount ?? 0)) { rec.__lastFrameCount = frames.length; if (clarified > 0) waitingSince = Date.now() }
      const pendingTools = frames.filter((e) => e.type === 'tool/call').length - frames.filter((e) => e.type === 'tool/result').length
      if (clarified > 0 && pendingTools <= 0 && frames.filter((e) => e.type === 'turn/end').length < expectedEnds && Date.now() - waitingSince > 5 * 60_000) {
        rec.clarifyUnblocked = false
        bailed = true
      }
      const ends = frames.filter((e) => e.type === 'turn/end').length
      if (ends >= expectedEnds) {
        // 轮结束:拿到验收终局 = 完;否则按流程位置扮演用户接续(B 臂交互面)。
        if (verdictSoFar() !== null) break
        if (nudges >= MAX_NUDGES) { rec.nudgesExhausted = true; break }
        nudges++
        const nudge = !toolCalled('match_catalog')
          ? '架构可以,就按这个来,继续装配,后面不用再等我确认。'
          : !toolCalled('emit_preset')
            ? '决策都由你定,继续发射和验收,完成后告诉我结论。'
            : '继续把验收跑完,告诉我结论。'
        rec.nudgeLog = rec.nudgeLog ?? []
        rec.nudgeLog.push({ at: Math.round((Date.now() - t0) / 1000), text: nudge })
        await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: nudge }] })
        expectedEnds = ends + 1
      }
      await new Promise((r) => setTimeout(r, 2500))
    }
    rec.nudges = nudges
    rec.clarifications = clarified
    rec.timedOut = !bailed && verdictSoFar() === null && frames.filter((e) => e.type === 'turn/end').length < expectedEnds
    if (rec.timedOut || bailed) { try { await rpc('session.cancel', { sessionId }) } catch {} }

    rec.frameTypes = {}
    for (const e of frames) rec.frameTypes[e.type] = (rec.frameTypes[e.type] ?? 0) + 1
    const usages = []
    for (const e of frames) findUsages(e, usages)
    rec.mainAgentUsage = usages.reduce((a, u) => ({
      inputTokens: a.inputTokens + u.inputTokens, outputTokens: a.outputTokens + u.outputTokens,
      reasoningTokens: a.reasoningTokens + u.reasoningTokens, cacheReadTokens: a.cacheReadTokens + u.cacheReadTokens,
      events: a.events + 1,
    }), { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, events: 0 })

    rec.toolCalls = frames.filter((e) => e.type === 'tool/call').map((e) => ({ name: e.data?.name, args: String(e.data?.arguments ?? '').slice(0, 800) }))
    rec.toolResults = frames.filter((e) => e.type === 'tool/result').map((e) => {
      const d = JSON.stringify(e.data ?? {})
      return d.length > 20000 ? d.slice(0, 20000) + '…[截断]' : d
    })
    rec.assistantText = frames.filter((e) => e.type === 'assistant/message').map((e) => {
      const c = e.data?.message?.content ?? e.data?.content
      if (typeof c === 'string') return c
      if (Array.isArray(c)) return c.map((b) => (b?.type === 'text' ? b.text : '')).join('')
      return ''
    }).join('\n---\n')
  } catch (err) {
    rec.error = err instanceof Error ? err.message : String(err)
  } finally {
    try { ws?.close() } catch {}
  }
  rec.seconds = Math.round((Date.now() - t0) / 1000)
  writeFileSync(join(outdir, `${s.id}.json`), JSON.stringify(rec, null, 2))
  // 终局判决 = 最后一次 verify 的结论(外科重发后的重验才是终局;首验 FAIL 只是过程)。
  const verdicts = (rec.toolResults ?? []).flatMap((t) => [...t.matchAll(/验收 (PASS|FAIL|SKIPPED|ERRORED)/g)].map((m) => m[1]))
  const verdict = verdicts.at(-1)
    ?? (rec.timedOut ? 'TIMEOUT' : rec.error ? `ERROR:${rec.error.slice(0, 60)}` : 'NO-VERDICT')
  const pipeline = ['match_catalog', 'emit_preset', 'verify_preset'].map((n) => (rec.toolCalls ?? []).some((c) => c.name === n) ? '✓' : '·').join('')
  console.log(`[${s.id}] ${rec.seconds}s 验收:${verdict} 流程:${pipeline} 反问:${rec.clarifications ?? 0} 接续:${rec.nudges ?? 0}`)
}

let cursor = 0
async function worker() {
  while (cursor < scenarios.length) {
    const i = cursor++
    await runOne(scenarios[i], i)
  }
}
const t0 = Date.now()
await Promise.all(Array.from({ length: Math.min(lanes, scenarios.length) }, () => worker()))
console.log(`批次完成:${scenarios.length} 场景,${Math.round((Date.now() - t0) / 1000)}s`)
