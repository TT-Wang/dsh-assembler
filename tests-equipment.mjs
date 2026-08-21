#!/usr/bin/env node
/**
 * 装备槽单测:双次执行门(validateStateSchema)、装备安装(installStateEquipment)、
 * emitPreset 的 extraServerEnv 注入、BOM equipment 记录、planReuse 知识版本闸。
 * 全部离线(node:sqlite 内存库),不碰 LLM 与 host。
 */
import {
  validateStateSchema, installStateEquipment, emitPreset, renderPartsLock, planReuse, EMISSION_REV,
} from './lib/index.js'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${String(extra).slice(0, 110)}` : ''}`)
  if (!cond) failures += 1
}

// ── 1. 双次执行门 ──────────────────────────────────────────────────────────
const GOOD_DDL = 'CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY, item TEXT, amount REAL);\nCREATE INDEX IF NOT EXISTS idx_item ON ledger(item);'
check('幂等 DDL 过门', validateStateSchema(GOOD_DDL) === null)
check('语法垃圾被拒', validateStateSchema('CREATE TABLE broken (') !== null)
check('无 IF NOT EXISTS → 第二遍执行失败被拒', validateStateSchema('CREATE TABLE t (id INTEGER)') !== null)
check('带 INSERT(种子数据破幂等)被词法清单拒', String(validateStateSchema('CREATE TABLE IF NOT EXISTS t(id INTEGER); INSERT INTO t VALUES (1);')).includes('不收'))
check('带 DROP 被拒', validateStateSchema('DROP TABLE IF EXISTS t; CREATE TABLE IF NOT EXISTS t(id INTEGER);') !== null)
check('带 PRAGMA 被拒', validateStateSchema('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t(id INTEGER);') !== null)

// ── 2. 装备安装 ────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'equip-test-'))
const dir = join(root, 'agent-a')
mkdirSync(dir, { recursive: true })
const SQLITE_CAP = { id: 'mcp-sqlite-query-execute', via: 'mcp', tool: 'x', description: 'x', tags: [], config: { server: 'sqlite-query' } }
const OTHER_CAP = { id: 'mcp-http-request-get', via: 'mcp', tool: 'y', description: 'y', tags: [], config: { server: 'http-request' } }

const eq = installStateEquipment({ stateSchema: GOOD_DDL, selected: [SQLITE_CAP, OTHER_CAP], dir })
check('选了 sqlite + 合法 DDL → 装备落地', eq !== null)
check('equipment/init.sql 写盘', existsSync(join(dir, 'equipment', 'init.sql')))
check('env 只指向 sqlite 服务器', eq !== null && Object.keys(eq.extraServerEnv).join(',') === 'sqlite-query' && eq.extraServerEnv['sqlite-query'].SQLITE_INIT_DDL_FILE.endsWith('init.sql'))
check('默认库钉为本 preset 的绝对 workspace/data.db', eq !== null && eq.extraServerEnv['sqlite-query'].SQLITE_DEFAULT_DB === join(dir, 'workspace', 'data.db'))
check('persona 句点名"禁止重新设计"', eq?.personaText.includes('禁止重新设计') === true)
check('BOM 文件清单', JSON.stringify(eq?.files) === '["equipment/init.sql"]')

// 方案共享库(G1):给了 sharedDb,默认库钉到共享路径而非自己的 workspace,persona 明示共享。
const dirS = join(root, 'agent-shared'); mkdirSync(dirS, { recursive: true })
const SHARED = join(root, '_sol', 'shared', 'data.db')
const eqS = installStateEquipment({ stateSchema: GOOD_DDL, selected: [SQLITE_CAP], dir: dirS, sharedDb: SHARED })
check('sharedDb → 默认库钉到方案共享路径', eqS !== null && eqS.extraServerEnv['sqlite-query'].SQLITE_DEFAULT_DB === SHARED)
check('sharedDb → 本 agent DDL 仍自动执行(补专属表)', eqS !== null && eqS.extraServerEnv['sqlite-query'].SQLITE_INIT_DDL_FILE.endsWith('init.sql'))
check('sharedDb → persona 点名"方案共享库"', eqS?.personaText.includes('方案共享库') === true)

const dirB = join(root, 'agent-b'); mkdirSync(dirB, { recursive: true })
check('没选 sqlite → 不装备', installStateEquipment({ stateSchema: GOOD_DDL, selected: [OTHER_CAP], dir: dirB }) === null)
check('没起草 schema → 不装备', installStateEquipment({ selected: [SQLITE_CAP], dir: dirB }) === null)
check('坏 DDL → 不装备且不写文件', installStateEquipment({ stateSchema: 'CREATE TABLE broken (', selected: [SQLITE_CAP], dir: dirB }) === null && !existsSync(join(dirB, 'equipment', 'init.sql')))

// ── 3. emitPreset 注入 env ─────────────────────────────────────────────────
const catalog = {
  capabilities: [SQLITE_CAP],
  'mcp-servers': { 'sqlite-query': { transport: 'stdio', command: 'node', args: ['s.js'], env: { LANG: 'zh' } } },
}
const req = { capabilityIds: ['mcp-sqlite-query-execute'], missing: [], rationale: '', persona: 'p' }
const WSE = '/tmp/ws-eq/workspace'
const withEq = emitPreset(req, catalog, '{{extraRows}}', 'agent-a', '', eq.extraServerEnv, WSE)
const rows = yaml.load(withEq)
const mcpRow = rows.find((r) => r?.name === '@deepseek-ai/dsh-mcp-client')
check('env 合并目录声明 + 装备指针', mcpRow?.config?.env?.LANG === 'zh' && String(mcpRow?.config?.env?.SQLITE_INIT_DDL_FILE ?? '').endsWith('init.sql'), JSON.stringify(mcpRow?.config?.env))
const noEq = emitPreset(req, catalog, '{{extraRows}}', 'agent-a', '', undefined, WSE)
const noEqRow = yaml.load(noEq).find((r) => r?.name === '@deepseek-ai/dsh-mcp-client')
check('不传装备时 env 只有目录声明', noEqRow?.config?.env?.LANG === 'zh' && noEqRow?.config?.env?.SQLITE_INIT_DDL_FILE === undefined)
// 目录本无 env、仅装备注入时,env 行也要出现
const catalogNoEnv = { capabilities: [SQLITE_CAP], 'mcp-servers': { 'sqlite-query': { transport: 'stdio', command: 'node', args: ['s.js'] } } }
const onlyEq = yaml.load(emitPreset(req, catalogNoEnv, '{{extraRows}}', 'agent-a', '', eq.extraServerEnv, WSE)).find((r) => r?.name === '@deepseek-ai/dsh-mcp-client')
check('目录无 env 仅装备时 env 行仍出现', String(onlyEq?.config?.env?.SQLITE_INIT_DDL_FILE ?? '').endsWith('init.sql'))

// ── 4. BOM equipment 记录 ─────────────────────────────────────────────────
const lock = renderPartsLock({ presetId: 'agent-a', requirement: 'r', selected: [SQLITE_CAP], presetText: withEq, index: [], equipment: ['equipment/init.sql'] })
check('lock 记录 equipment', yaml.load(lock).equipment?.[0] === 'equipment/init.sql')
const lockNo = renderPartsLock({ presetId: 'agent-a', requirement: 'r', selected: [SQLITE_CAP], presetText: withEq, index: [] })
check('无装备时 lock 不出现 equipment 键', yaml.load(lockNo).equipment === undefined)

// ── 5. planReuse 知识版本闸 ────────────────────────────────────────────────
const catRoot = join(root, 'cat'); mkdirSync(join(catRoot, 'knowledge', 'kb-x'), { recursive: true })
writeFileSync(join(catRoot, 'knowledge', 'kb-x', '.knowledge-meta.json'), JSON.stringify({ id: 'kb-x', version: '2026-08-21' }))
const pDir = join(root, 'agent-kb'); mkdirSync(join(pDir, 'kb', 'kb-x'), { recursive: true })
writeFileSync(join(pDir, 'agent.cordis.yml'), '- id: persona\n  name: x\n  config: { text: "p" }\n')
const REQ2 = '知识台'
const mkLock = (ver) => yaml.dump({ requirement: REQ2, emitter: EMISSION_REV, parts: [{ capability: 'mcp-sqlite-query-execute' }], knowledge: [{ id: 'kb-x', docs: 1, version: ver }] }, { lineWidth: -1 })
writeFileSync(join(pDir, 'parts.lock.yml'), mkLock('2026-08-21'))
const cat2 = { capabilities: [SQLITE_CAP], 'mcp-servers': {} }
check('kb 版本一致 → 复用', planReuse({ name: 'agent-kb', requirement: REQ2, params: {}, presetRoot: root, catalog: cat2, catalogRoot: catRoot }) !== null)
writeFileSync(join(pDir, 'parts.lock.yml'), mkLock('2026-08-17'))
check('目录 kb 已升版 → 拒绝复用(新知识必须进 preset)', planReuse({ name: 'agent-kb', requirement: REQ2, params: {}, presetRoot: root, catalog: cat2, catalogRoot: catRoot }) === null)
check('不给 catalogRoot(旧调用形)→ 不做版本闸,照常复用', planReuse({ name: 'agent-kb', requirement: REQ2, params: {}, presetRoot: root, catalog: cat2 }) !== null)

rmSync(root, { recursive: true, force: true })
console.log(`\n==== 装备槽单元测试: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`)
process.exit(failures === 0 ? 0 : 1)
