#!/usr/bin/env node
// 双面交付实战(2026-08-24 四件套验收):
//   A. m30-ledger 同名重发(吃进新 data-desk 模板 + 带服务脸的 sqlite 零件)
//   B. ① 服务脸链路:会话触发零件挂载 → .service.json → host /.service → 直连 SQL
//   C. selfcheck 重考(考卷随行的意义:改动后同卷复验)+ 前端双门
//   D. ② record-desk 以 DB_PATH 共享 m30 的账 → verify_app(真 AI 解析入库)
//   E. ③ 双面交接考:app 面写一行(token+payload)→ m30 会话面按 token 取回报 payload
//   F. ④ 触发面:发射 ops-heartbeat preset → cron-trigger fire-task 开真会话 → 库里长出心跳行
// 用法:node bench/battle-two-faced.mjs [port]   (默认 3097,战场 host)
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import yaml from 'js-yaml'

const PORT = Number(process.argv[2] ?? 3097)
const REPO = join(import.meta.dirname, '..')
const PRESETS = join(homedir(), '.dsh', '.agent-presets')
const M30 = join(PRESETS, 'm30-ledger')

// 凭证借读(值不打印)
for (const line of readFileSync(join(homedir(), '.dsh', '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}

const results = []
const record = (step, pass, evidence) => {
  results.push({ step, pass, evidence })
  console.log(`${pass ? '✅' : '❌'} ${step} — ${evidence}`)
}
const fakeCtx = { get: (k) => (k === 'webServer' ? { port: PORT } : undefined), effect: () => {}, tools: { register: () => {} } }

const { emitPresetToolDefinition, emitAppToolDefinition, verifyAppToolDefinition } = await import(join(REPO, 'lib', 'orchestrated-tools.js'))
const { runScenario, runFrontendGate } = await import(join(REPO, 'lib', 'verify.js'))

// ── A. m30 同名重发 ─────────────────────────────────────────────────────────
const cordis = yaml.load(readFileSync(join(M30, 'agent.cordis.yml'), 'utf8'))
const persona = cordis.find((r) => r.id === 'persona').config.text
const requirement = yaml.load(readFileSync(join(M30, 'preset.yml'), 'utf8')).description
const stateSchema = readFileSync(join(M30, 'equipment', 'init.sql'), 'utf8')
const capabilityIds = ['mcp-sqlite-query-execute', 'mcp-sqlite-query-query', 'frontend-data-desk', 'mcp-excel-read-write-write-csv-file', 'mcp-excel-read-write-read-csv-file']
const emitDef = emitPresetToolDefinition(fakeCtx, { verify: false })
const emitOut = await emitDef.execute({ name: 'm30-ledger', requirement, capabilityIds, persona, stateSchema })
record('A 同名重发', emitOut.includes('m30-ledger'), emitOut.split('\n')[0].slice(0, 100))

// ── B. 服务脸链路(先开一轮会话触发零件挂载,再走 /.service 直连)────────────
const gate = await runFrontendGate(PORT, 'm30-ledger', M30, { loop: true })
record('B1 前端双门(顺带触发零件挂载)', gate.pass, gate.reason ?? '')
await new Promise((r) => setTimeout(r, 1200))
let svc = null
try {
  svc = await (await fetch(`http://127.0.0.1:${PORT}/assembler/ui/m30-ledger/.service`)).json()
} catch { /* below */ }
record('B2 host /.service 路由可达且含 sqlite 面', svc?.sqlite?.url !== undefined, JSON.stringify(svc ?? {}).slice(0, 120))
let faceRows = null
if (svc?.sqlite) {
  const r = await (await fetch(`${svc.sqlite.url}/sql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-token': svc.sqlite.token },
    body: JSON.stringify({ sql: 'SELECT count(*) AS n FROM ledger_entries' }),
  })).json()
  faceRows = r.rows?.[0]?.n
  record('B3 直连 SQL(零模型零轮次)', typeof faceRows === 'number', `ledger_entries 现有 ${faceRows} 行`)
  const sch = await (await fetch(`${svc.sqlite.url}/schema`, { headers: { 'x-service-token': svc.sqlite.token } })).json()
  record('B4 /schema 报共享账表结构', sch.tables?.some((t) => t.name === 'ledger_entries') && sch.tables?.some((t) => t.name === 'budgets'), sch.tables?.map((t) => t.name).join(','))
}

// ── C. selfcheck 重考(同一张考卷复验重发后的机器)───────────────────────────
const selfcheck = JSON.parse(readFileSync(join(M30, 'selfcheck.json'), 'utf8'))
const scn = await runScenario(PORT, 'm30-ledger', selfcheck.plan.scenario, 240_000, (l) => console.log('  ·', l), join(M30, 'workspace'))
record('C selfcheck 同卷重考', scn.status === 'PASS', scn.status === 'PASS' ? `${selfcheck.plan.scenario.turns.length} 轮全过` : (scn.reason ?? scn.status))

// ── D. record-desk 双面实例(共享 m30 的账)→ verify_app ─────────────────────
const appDir = join(homedir(), 'apps', 'm30-ledger-desk')
const emitApp = emitAppToolDefinition(fakeCtx, {})
const appOut = await emitApp.execute({
  recipeId: 'record-desk',
  name: 'm30-ledger-desk',
  targetDir: appDir,
  fresh: true,
  params: {
    APP_NAME: 'm30 记账台(双面)',
    ROLE_LINE: '你是 m30 记账台的记录员,把口语收支解析成 ledger_entries 规范行(type 只能是 收入 或 支出)。',
    DB_PATH: join(M30, 'workspace', 'data.db'),
    SELFTEST_TEXT: '记一笔支出:战役验收咖啡 9.9 元,备注 TWFACE-D77 双面考',
    SELFTEST_MARKER: 'TWFACE-D77',
  },
})
record('D1 emit_app 共享账实例化', appOut.includes('m30-ledger-desk'), appOut.split('\n')[0].slice(0, 100))
const verifyApp = verifyAppToolDefinition(fakeCtx, {})
const vOut = await verifyApp.execute({ targetDir: appDir })
record('D2 verify_app(真 AI 解析入共享账)', vOut.startsWith('app 验收 PASS'), vOut.split('\n')[0])

// ── E. ③ 双面交接考:app 面写 → 会话面读(照抄闸:读方指令不含 payload)───────
const appProc = spawn('node', ['--no-warnings', 'server.mjs'], { cwd: appDir, env: { ...process.env, PORT: '4750' }, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1200))
const TOKEN = 'TWF-3391'
const PAYLOAD = 'HANDOFF-8842-OK'
try {
  const w = await (await fetch('http://127.0.0.1:4750/api/sql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql: `INSERT INTO ledger_entries(type, amount, category, note, entry_date) VALUES ('支出', 0.01, '其他', '${TOKEN} ${PAYLOAD}', date('now','localtime'))` }),
  })).json()
  record('E1 app 面写入(token+payload 行)', w.changes === 1, JSON.stringify(w))
  const reader = await runScenario(PORT, 'm30-ledger', {
    goal: '双面交接考·读',
    turns: [{ prompt: `查询 ledger_entries 里备注包含 ${TOKEN} 的那一笔,把它备注里 ${TOKEN} 之后的完整代码原样报给我,不要问任何人。`, mustInclude: [PAYLOAD] }],
  }, 180_000, (l) => console.log('  ·', l), join(M30, 'workspace'))
  record('E2 会话面按 token 取回并报出 payload', reader.status === 'PASS', reader.status === 'PASS' ? '两张脸共享同一本账,交接可信' : (reader.reason ?? reader.status))
} finally {
  appProc.kill('SIGTERM')
}

// ── F. ④ 触发面:heartbeat preset + cron-trigger fire → 库里长出心跳行 ────────
const HB = 'ops-heartbeat'
const hbDdl = "CREATE TABLE IF NOT EXISTS heartbeat (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now','localtime')));"
const hbOut = await emitDef.execute({
  name: HB,
  requirement: '无人值守心跳记录 agent:被定时任务唤醒时,在 heartbeat 表插入一行指定 note 的心跳记录',
  capabilityIds: ['mcp-sqlite-query-execute', 'mcp-sqlite-query-query'],
  persona: '你是无人值守的心跳记录员。被唤醒后:按任务指令用 mcp-sqlite-query-execute 往 heartbeat 表插入心跳行(note 按指令给定值),插入后用 query 复核并简短报告行数。绝不提问,绝不建新表(表已预建)。数据只认数据库。',
  stateSchema: hbDdl,
})
record('F1 心跳 preset 发射', hbOut.includes(HB), hbOut.split('\n')[0].slice(0, 90))

// cron-trigger 进程(考官姿势:直接拉起零件,fire-task 走真 wire 开真会话)
const { Client } = await import(join(REPO, 'generated', 'cron-trigger', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js'))
const { StdioClientTransport } = await import(join(REPO, 'generated', 'cron-trigger', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'stdio.js'))
const hbWorkspace = join(PRESETS, HB, 'workspace')
const transport = new StdioClientTransport({
  command: 'node',
  args: [join(REPO, 'generated', 'cron-trigger', 'index.js')],
  env: { ...process.env, PART_WORKDIR: hbWorkspace, CRON_WIRE_PORT: String(PORT) },
})
const cronClient = new Client({ name: 'battle-trigger', version: '0.0.1' })
await cronClient.connect(transport)
const HBMARK = `HB-${Date.now().toString(36).toUpperCase()}`
const HBTASK = `hb-battle-${Date.now().toString(36)}`
await cronClient.callTool({ name: 'schedule-task', arguments: { id: HBTASK, cron: '0 9 1 * *', presetId: HB, prompt: `往 heartbeat 表插入一行,note 必须精确等于 ${HBMARK};插入后复核。` } })
const fired = JSON.parse((await cronClient.callTool({ name: 'fire-task', arguments: { id: HBTASK } })).content[0].text)
record('F2 fire-task 经 wire 开真会话', typeof fired.sessionId === 'string', `session ${String(fired.sessionId).slice(0, 18)}`)
// 触发考:打一发,验后果——轮询共享库直到心跳行出现(无人值守的完成判据=落库效果)
let hbFound = false
const { DatabaseSync } = await import('node:sqlite')
for (let i = 0; i < 40 && !hbFound; i++) {
  await new Promise((r) => setTimeout(r, 3000))
  try {
    const db = new DatabaseSync(join(hbWorkspace, 'data.db'), { readOnly: true })
    hbFound = db.prepare('SELECT count(*) AS n FROM heartbeat WHERE note = ?').get(HBMARK).n > 0
    db.close()
  } catch { /* 库可能尚未建立 */ }
}
record('F3 触发考:库里长出心跳行(打一发验后果)', hbFound, hbFound ? `note=${HBMARK} 落库 ✓(无人值守闭环)` : '120s 内未见心跳行')
await transport.close()

// ── 汇总 ────────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.pass).length
console.log(`\n═══ 双面交付实战:${passed}/${results.length} PASS ═══`)
process.exit(passed === results.length ? 0 : 1)
