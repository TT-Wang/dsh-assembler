#!/usr/bin/env node
/**
 * 编排模式(B 臂)纯件单测:match_catalog 的输入归一/prompt 契约/响应整形、
 * emit_preset 的入参机械校验、verify_preset 的草图归一。跑法:node tests-orchestrated.mjs
 * (先 npm run build)。LLM 调用与探针执行不在此测(那是 E2E 与 A/B 战役的事)。
 */
import {
  buildMatchPrompt, normalizeProbeSketch, normalizeSpecInput, orchestratedMode,
  parseMatchResponse, validateEmitArgs,
} from './lib/orchestrated-tools.js'

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

// ── orchestratedMode ────────────────────────────────────────────────────────
const saved = process.env.DSH_ASSEMBLER_MODE
delete process.env.DSH_ASSEMBLER_MODE
const offDefault = orchestratedMode() === false
process.env.DSH_ASSEMBLER_MODE = 'orchestrated'
const onFlag = orchestratedMode() === true
if (saved === undefined) delete process.env.DSH_ASSEMBLER_MODE
else process.env.DSH_ASSEMBLER_MODE = saved
check('模式开关:默认关、=orchestrated 才开', offDefault && onFlag)

if (failures > 0) {
  console.error(`\ntests-orchestrated: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\ntests-orchestrated: all green')
