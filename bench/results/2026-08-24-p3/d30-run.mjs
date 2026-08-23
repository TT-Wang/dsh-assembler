// 第 30 天战·装配臂:种子账 → 三连需求变更(每次全新会话=陌生工程师维护条件,
// 同名重发+重验)→ 每轮后断言老数据存活。输出逐轮工时与判决。
const PORT = 3096, PRESET = 'm30-ledger'
const WORKDIR = `/Users/tongtao/.dsh/.agent-presets/${PRESET}/workspace`
const rpc = async (m, p) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `d30-${Date.now()}-${Math.random().toString(36).slice(2)}`, method: m, payload: p }), signal: AbortSignal.timeout(30000) })
  const j = await r.json()
  if (!j.result?.ok) throw new Error(`${m}: ${JSON.stringify(j.result?.error ?? '').slice(0, 200)}`)
  return j.result.value
}
function mkSession(preset, cwd) {
  return rpc('session.create', { cwd, ...(preset ? { agentPreset: preset } : {}) }).then(async ({ sessionId }) => {
    const frames = []
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/events.mux`)
    ws.onmessage = (m) => { try { const f = JSON.parse(String(m.data));
      if (f.payload?.type === 'session/event' && f.payload.sessionId === sessionId) frames.push(f.payload.event)
      else if (f.payload?.type === 'question/requested' && f.payload.sessionId === sessionId) frames.push({ type: '__q', rpcId: f.rpcId, questions: f.payload.questions })
    } catch {} }
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    return { sessionId, frames, ws }
  })
}
async function answerQ(s, q) {
  const answers = (q.questions ?? []).map((item) => {
    const labels = (item.options ?? []).map((o) => String(o.label ?? ''))
    const pick = labels.find((l) => /推荐|Recommended|确认|按此|继续|可以|是|好/.test(l)) ?? labels[0]
    return pick ? { id: String(item.id), selected: [pick] } : { id: String(item.id), selected: [], custom: '你看着办,不用问我。' }
  })
  await fetch(`http://127.0.0.1:${PORT}/api/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-response', rpcId: q.rpcId, result: { ok: true, value: { sessionId: s.sessionId, answer: { answers } } } }) })
}
async function turn(s, text, until, timeoutMs) {
  const ends = s.frames.filter((e) => e.type === 'turn/end').length
  const start = s.frames.length
  await rpc('session.prompt', { sessionId: s.sessionId, mode: 'queue', content: [{ type: 'text', text }] })
  const t0 = Date.now()
  let scanned = start
  let expected = ends + 1
  while (Date.now() - t0 < timeoutMs) {
    for (; scanned < s.frames.length; scanned++) {
      const ev = s.frames[scanned]
      if (ev?.type === '__q') { await answerQ(s, ev) }
    }
    const nowEnds = s.frames.filter((e) => e.type === 'turn/end').length
    const results = s.frames.slice(start).filter((e) => e.type === 'tool/result').map((e) => JSON.stringify(e.data ?? {})).join('\n')
    if (until && until.test(results)) return { results }
    if (!until && nowEnds >= expected) {
      return { reply: s.frames.slice(start).filter((e) => e.type === 'assistant/message')
        .map((e) => { const c = e.data?.message?.content ?? []; return Array.isArray(c) ? c.map((b) => b?.type === 'text' ? b.text : '').join('') : '' }).join('\n') }
    }
    if (until && nowEnds >= expected) expected = nowEnds + 1 // 变更轮可能多轮,继续等验收
    await new Promise((r) => setTimeout(r, 1200))
  }
  throw new Error('turn 超时')
}

const CHANGES = [
  'R1|给记账 agent「m30-ledger」升级:加预算功能——可设每月总预算,记账后若当月支出超预算要在回复里提醒。同名重发并独立重验;历史账目数据绝不能丢。本次不要造新零件。',
  'R2|给「m30-ledger」再升级:支持导出当月账目为 CSV 文件到工作区。同名重发并独立重验;历史数据绝不能丢。不要造新零件。',
  'R3|给「m30-ledger」再升级:分类体系新增「订阅」类,并在 persona 里规定:备注含「会员/订阅/年费」的支出记为订阅类。同名重发并独立重验;历史数据绝不能丢。不要造新零件。',
]
const t00 = Date.now()
const log = (s) => console.log(`[${((Date.now()-t00)/1000).toFixed(0)}s] ${s}`)

// 0. 种子账(绑 preset 的会话)
{
  const s = await mkSession(PRESET, WORKDIR)
  const r = await turn(s, '记两笔账:8月1日 午饭 25 元 分类餐饮;8月2日 打车 30 元 分类出行。记完报一句确认。', null, 240000)
  log('种子账完成:' + (r.reply ?? '').slice(0, 80).replace(/\n/g, ' '))
  try { await rpc('session.cancel', { sessionId: s.sessionId }) } catch {}
  s.ws.close()
}
// 1-3. 三连变更(主 agent 全新会话)+ 每轮数据存活断言
for (const [i, change] of CHANGES.entries()) {
  const tA = Date.now()
  const s = await mkSession(null, '/Users/tongtao/Desktop')
  const r = await turn(s, change, /验收 (PASS|FAIL|SKIPPED|ERRORED)/, 20 * 60000)
  const verdict = ([...(r.results ?? '').matchAll(/验收 (PASS|FAIL|SKIPPED|ERRORED)/g)].at(-1) ?? [])[1] ?? '?'
  try { await rpc('session.cancel', { sessionId: s.sessionId }) } catch {}
  s.ws.close()
  const secs = ((Date.now()-tA)/1000).toFixed(0)
  // 数据存活断言
  const chk = await mkSession(PRESET, WORKDIR)
  const q = await turn(chk, '查 8 月全部账目,逐笔列出金额与分类。', null, 240000)
  const alive = (q.reply ?? '').includes('25') && (q.reply ?? '').includes('30')
  try { await rpc('session.cancel', { sessionId: chk.sessionId }) } catch {}
  chk.ws.close()
  log(`R${i+1} 变更 ${secs}s 验收:${verdict} 老数据存活:${alive ? '✓(25/30 都在)' : '✗'}`)
}
log('第30天战·装配臂完成')
process.exit(0)
