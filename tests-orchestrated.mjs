#!/usr/bin/env node
/**
 * 编排模式(B 臂)纯件单测:match_catalog 的输入归一/prompt 契约/响应整形、
 * emit_preset 的入参机械校验、verify_preset 的草图归一。跑法:node tests-orchestrated.mjs
 * (先 npm run build)。LLM 调用与探针执行不在此测(那是 E2E 与 A/B 战役的事)。
 */
import {
  assemblerMode, buildDraftPrompt, buildMatchPrompt, normalizeProbeSketch, normalizeSpecInput,
  orchestratedMode, parseDraftResponse, parseMatchResponse, validateEmitArgs,
} from './lib/orchestrated-tools.js'
import { rankCapabilities } from './lib/capability-index.js'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

// ── normalizeSpecInput ──────────────────────────────────────────────────────
const s1 = normalizeSpecInput({ capabilities: ['记账', { name: '导出报表', why: '月底要交' }, { name: '' }, 42], dataModel: '流水(金额/分类)', workflow: '记→查', interfaces: '网页' })
check('spec 归一:字符串/对象混合都收、空名与非法项剔除', s1 !== null && s1.capabilities.length === 2 && s1.capabilities[0].why === '' && s1.capabilities[1].why === '月底要交')
check('spec 归一:dataModel/workflow/interfaces 原样带出', s1?.dataModel === '流水(金额/分类)' && s1?.interfaces === '网页')
check('spec 归一:无能力清单 = null', normalizeSpecInput({ dataModel: 'x' }) === null && normalizeSpecInput('nope') === null)

// ── buildMatchPrompt ────────────────────────────────────────────────────────
const catalog = {
  capabilities: [
    { id: 'sqlite-store', via: 'mcp', description: '持久 SQLite 存取', tags: ['sqlite', 'state'], config: { server: 'sqlite' } },
    { id: 'mcp-semver-check-compare', via: 'mcp', description: '比较 semver', tags: ['semver'], config: { server: 'semver-check' } },
    { id: 'disabled-part', via: 'mcp', description: '停用件', tags: [], config: { enabled: false } },
    { id: 'frontend-data-desk', via: 'frontend', description: '记录台前端', tags: ['ui'], config: {} },
  ],
  'mcp-servers': {},
}
const spec = { capabilities: [{ name: '持久保存流水', why: '跨会话' }, { name: '语音识别', why: '' }], dataModel: '流水表', workflow: '', interfaces: '网页记录台' }
const bp = buildMatchPrompt('记账 agent', spec, catalog)
check('prompt:停用件不进候选集', !bp.ids.includes('disabled-part') && bp.ids.includes('sqlite-store'))
check('prompt:逐条覆盖契约在(one row per need / null+gap)', bp.prompt.includes('exactly one row per architectural need') && bp.prompt.includes('"gap"'))
check('prompt:GAP DISCIPLINE 保留', bp.prompt.includes('GAP DISCIPLINE'))
check('prompt:不做 persona/schema/name(职责边界写明)', bp.prompt.includes('do NOT write personas'))
check('prompt:需求清单逐条编号进 prompt', bp.prompt.includes('1. 持久保存流水 — 跨会话') && bp.prompt.includes('2. 语音识别'))

// ── parseMatchResponse ──────────────────────────────────────────────────────
const needs = spec.capabilities.map((c) => c.name)
const m1 = parseMatchResponse({
  coverage: [
    { need: '持久保存流水', capabilityId: 'sqlite-store' },
    { need: '语音识别', capabilityId: null, gap: '语音转文字能力' },
  ],
  extraIds: ['frontend-data-desk', 'sqlite-store'],
  missingEntries: [
    { id: 'speech-to-text', via: 'mcp', description: '语音转文字', tags: ['speech'] },
    { id: 'bad', via: 'frontend', description: '非法 via 应剔除', tags: [] },
  ],
}, bp.ids, needs)
check('响应整形:命中行保留 id、缺口行保留 gap', m1.coverage[0].capabilityId === 'sqlite-store' && m1.coverage[1].capabilityId === null && m1.coverage[1].gap === '语音转文字能力')
check('响应整形:capabilityIds = 覆盖行 ∪ extraIds 去重', JSON.stringify([...m1.capabilityIds].sort()) === JSON.stringify(['frontend-data-desk', 'sqlite-store']))
check('响应整形:missing 从 null 行派生(单一事实源)', JSON.stringify(m1.missing) === JSON.stringify(['语音转文字能力']))
check('响应整形:missingEntries 过形状闸(via:frontend 剔除)', m1.missingEntries.length === 1 && m1.missingEntries[0].id === 'speech-to-text')

const m2 = parseMatchResponse({
  coverage: [{ need: '持久保存流水', capabilityId: 'MCP_Semver_Check_Compare' }],
}, bp.ids, needs)
check('响应整形:机械近失 id 修复(下划线/大小写/mcp 前缀)', m2.coverage[0].capabilityId === 'mcp-semver-check-compare')
check('响应整形:模型漏行 → 按缺口补齐,绝不静默丢', m2.coverage.length === 2 && m2.coverage[1].need === '语音识别' && m2.coverage[1].capabilityId === null)

const m3 = parseMatchResponse({ coverage: [{ need: '持久保存流水', capabilityId: 'invented-vendor-part' }] }, bp.ids, needs)
check('响应整形:编造 id 调和不上 → 该行降级缺口(gap=need)', m3.coverage[0].capabilityId === null && m3.coverage[0].gap === '持久保存流水')

// ── validateEmitArgs ────────────────────────────────────────────────────────
const throwsWith = (args, needle) => {
  try {
    validateEmitArgs(args)
    return false
  } catch (e) {
    return String(e.message).includes(needle)
  }
}
check('emit 校验:缺 name 报错点名', throwsWith({}, '"name"'))
check('emit 校验:缺 requirement 报错点名', throwsWith({ name: 'a-bot' }, '"requirement"'))
check('emit 校验:缺 capabilityIds 报错点名', throwsWith({ name: 'a-bot', requirement: 'r' }, '"capabilityIds"'))
check('emit 校验:缺 persona 报错点名(组装决策归编排者)', throwsWith({ name: 'a-bot', requirement: 'r', capabilityIds: ['x'] }, '"persona"'))
const e1 = validateEmitArgs({
  name: 'A Bot!', requirement: ' 记账 ', capabilityIds: ['sqlite-store', ''],
  persona: '你是记账助手', params: { tz: 'Asia/Shanghai', n: 3, ok: true, nested: { a: 1 } },
  missingEntries: [{ id: 'stt', via: 'mcp', description: '语音转文字', tags: [] }],
})
check('emit 校验:params 拍平(数字/布尔转字符串,嵌套丢弃)', e1.params.n === '3' && e1.params.ok === 'true' && !('nested' in e1.params))
check('emit 校验:missing 缺省从 missingEntries 派生', JSON.stringify(e1.missing) === JSON.stringify(['语音转文字']))
check('emit 校验:name 保留原文(消毒在发射层)、空 id 剔除', e1.name === 'A Bot!' && e1.capabilityIds.length === 1)
check('emit 校验:sharedDb 相对路径拒绝(零件 cwd 教训)', throwsWith({ name: 'a-bot', requirement: 'r', capabilityIds: ['x'], persona: 'p', sharedDb: 'shared/data.db' }, '绝对路径'))
const e2 = validateEmitArgs({ name: 'a-bot', requirement: 'r', capabilityIds: ['x'], persona: 'p', sharedDb: '/tmp/suite/shared.db' })
check('emit 校验:sharedDb 绝对路径通过', e2.sharedDb === '/tmp/suite/shared.db')

// ── normalizeProbeSketch ────────────────────────────────────────────────────
const sk1 = normalizeProbeSketch({ createTask: '建档 T-1', retrieveTask: '取 T-1', token: 'T-1', marks: [500, '张三'] })
check('草图归一:有 createTask 缺 kind → scenario;marks 字符串化', sk1?.kind === 'scenario' && sk1?.marks?.[0] === '500')
const sk2 = normalizeProbeSketch({ task: '算 1+1', marks: ['2'] })
check('草图归一:只有 task → single', sk2?.kind === 'single')
check('草图归一:非对象 = null', normalizeProbeSketch('x') === null && normalizeProbeSketch(null) === null)

// ── 模式矩阵(2026-08-23 身份裁定:默认 = 检索形态)─────────────────────────
const saved = process.env.DSH_ASSEMBLER_MODE
delete process.env.DSH_ASSEMBLER_MODE
const modeDefault = assemblerMode() === 'search' && orchestratedMode() === false
const modeChecks = ['pipeline', 'orchestrated', 'draft', 'dialogue', 'search'].every((m) => {
  process.env.DSH_ASSEMBLER_MODE = m
  return assemblerMode() === m
})
process.env.DSH_ASSEMBLER_MODE = 'bogus'
const modeBogus = assemblerMode() === 'search'
if (saved === undefined) delete process.env.DSH_ASSEMBLER_MODE
else process.env.DSH_ASSEMBLER_MODE = saved
check('模式矩阵:默认 search(身份裁定)、五形态显式可选、非法值回退 search', modeDefault && modeChecks && modeBogus)

// ── 承重契约句(改契约掉了哪句立刻红——阶段1 的回归底线)────────────────────
import('./lib/orchestrated-tools.js').then(() => {})
const { BASELINE_RULE, MINIMAL_SET_RULE, FRONTEND_FACT, PROBE_SKETCH_EXAMPLES } = await import('./lib/orchestrated-tools.js')
check('契约钉:基线判据在(LLM 能干的不装 + 10-15 件阈值文献)', BASELINE_RULE.includes('real-world I/O') && BASELINE_RULE.includes('10-15'))
check('契约钉:最小覆盖集 + least-privilege 在', MINIMAL_SET_RULE.includes('least privilege') && MINIMAL_SET_RULE.includes('MINIMAL'))
check('契约钉:前端物理事实在(仅首个模板生效)', FRONTEND_FACT.includes('首个') && FRONTEND_FACT.includes('生效'))
check('契约钉:出题范例双形状在(scenario+single,token 两轮自足)', PROBE_SKETCH_EXAMPLES.includes('"kind":"scenario"') && PROBE_SKETCH_EXAMPLES.includes('"kind":"single"') && PROBE_SKETCH_EXAMPLES.includes('PO-4471'))

// ── C 臂:parseDraftResponse / buildDraftPrompt ─────────────────────────────
const dp = buildDraftPrompt('记账 agent', catalog)
check('C prompt:两遍法(先架构后映射)+ GAP DISCIPLINE + 探针规则齐', dp.prompt.includes('PASS 1') && dp.prompt.includes('GAP DISCIPLINE') && dp.prompt.includes('"probe"'))
const draft = parseDraftResponse({
  spec: { purpose: '记账', capabilities: [{ name: '持久保存流水', why: '' }, '语音识别'], dataModel: '流水表', workflow: '记→查', interfaces: '网页' },
  coverage: [
    { need: '持久保存流水', capabilityId: 'sqlite-store' },
    { need: '语音识别', capabilityId: null, gap: '语音转文字' },
  ],
  extraIds: ['frontend-data-desk'],
  name: 'Expense Butler!',
  persona: ' 你是记账助手 ',
  stateSchema: 'CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY)',
  probe: { createTask: '记一笔 T-9 打车 30 元', retrieveTask: '查 T-9 那笔', token: 'T-9', marks: ['30'] },
}, dp.ids)
check('C 整形:spec 宽进(字符串能力也收)+ purpose 带出', draft.spec.capabilities.length === 2 && draft.spec.purpose === '记账')
check('C 整形:coverage 走同一套调和,capabilityIds 并 extraIds', draft.capabilityIds.includes('sqlite-store') && draft.capabilityIds.includes('frontend-data-desk') && draft.missing.length === 1)
check('C 整形:name 消毒成 kebab、persona 修剪、schema 带出', draft.name === 'expense-butler' && draft.persona === '你是记账助手' && draft.stateSchema?.startsWith('CREATE TABLE'))
check('C 整形:探针草图归一(缺 kind 推断 scenario)', draft.probe?.kind === 'scenario' && draft.probe?.token === 'T-9')
const draftEmpty = parseDraftResponse({}, dp.ids)
check('C 整形:全缺字段不炸(空洞留给审阅人红笔)', draftEmpty.spec.capabilities.length === 0 && draftEmpty.name === '' && draftEmpty.persona === '' && draftEmpty.probe === null)

// ── F 臂:rankCapabilities ──────────────────────────────────────────────────
const hits1 = rankCapabilities(catalog.capabilities, 'sqlite 持久存储', 5)
check('F 检索:sqlite 需求命中 sqlite 零件且排第一', hits1.length > 0 && hits1[0].entry.id === 'sqlite-store')
const hitsFe = rankCapabilities(catalog.capabilities, '记录台 ui 前端', 5)
check('F 检索:非 mcp 条目(frontend)也可检得', hitsFe.some((h) => h.entry.id === 'frontend-data-desk'))
check('F 检索:停用件不出、空查询空结果、确定性(两跑同序)', !rankCapabilities(catalog.capabilities, '停用件', 5).some((h) => h.entry.id === 'disabled-part')
  && rankCapabilities(catalog.capabilities, '', 5).length === 0
  && JSON.stringify(rankCapabilities(catalog.capabilities, 'sqlite', 5)) === JSON.stringify(rankCapabilities(catalog.capabilities, 'sqlite', 5)))

// ── BM25 IDF:烂大街词降权,稀有词的命中赢过通用词命中 ──────────────────────
const idfCat = {
  capabilities: [
    { id: 'part-a', via: 'mcp', description: '数据 数据 处理', tags: ['数据'], config: { server: 's1' } },
    { id: 'part-b', via: 'mcp', description: '数据 工具', tags: ['数据'], config: { server: 's2' } },
    { id: 'part-c', via: 'mcp', description: '数据 面板', tags: ['数据'], config: { server: 's3' } },
    { id: 'part-rare', via: 'mcp', description: '发票 识别', tags: ['发票'], config: { server: 's4' } },
  ],
  'mcp-servers': {},
}
const idfHits = rankCapabilities(idfCat.capabilities, '数据 发票', 4)
check('BM25:稀有词(发票,df=1)命中排在烂大街词(数据,df=3)命中之前', idfHits[0]?.entry.id === 'part-rare')

// ── persona-lint 完备性(阶段1 ④):持久化约束 + 敏感领域边界 ────────────────
const { lintPersona } = await import('./lib/persona-lint.js')
const statePart = [{ id: 'sq', via: 'mcp', tool: 'mcp__sqlite-query__execute', description: '', tags: [], config: { server: 'sqlite-query' } }]
const f1 = lintPersona('你是记账助手,认真负责,回答简洁,服务中文用户,金额按元展示。', statePart)
check('lint 完备性:挂状态零件 + 无持久化约束 → missing-durability', f1.some((f) => f.kind === 'missing-durability'))
const f2 = lintPersona('你是记账助手,跨轮事实必须写入数据库账本,不依赖会话记忆,金额按元展示。', statePart)
check('lint 完备性:有持久化约束不误报', !f2.some((f) => f.kind === 'missing-durability'))
const f3 = lintPersona('你是医院导诊助手,根据症状描述推荐科室,帮助患者预约挂号,答疑常见健康问题。', [])
check('lint 完备性:医疗域无边界句 → missing-safety-boundary', f3.some((f) => f.kind === 'missing-safety-boundary'))
const f4 = lintPersona('你是医院导诊助手,根据症状推荐科室,绝不诊断开药,涉及病情一律建议就医,仅限导诊与科普。', [])
check('lint 完备性:医疗域有红线句不误报', !f4.some((f) => f.kind === 'missing-safety-boundary'))
const f5 = lintPersona('你是看板助手,帮团队管理任务流转,语气干脆,拖拽操作在网页完成。', [])
check('lint 完备性:非敏感域不查边界(task-agnostic)', !f5.some((f) => f.kind === 'missing-safety-boundary'))

if (failures > 0) {
  console.error(`\ntests-orchestrated: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\ntests-orchestrated: all green')
