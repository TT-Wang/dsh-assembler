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
const { ARCHITECTURE_CONTRACT } = await import('./lib/orchestrated-tools.js')
check('契约钉:架构骨架六维在(数据模型/工作流/边界交付)', ARCHITECTURE_CONTRACT.includes('data model') && ARCHITECTURE_CONTRACT.includes('workflow') && ARCHITECTURE_CONTRACT.includes('boundary'))
check('契约钉:确认检查点硬措辞在(点名 ask_user_question + STOP + 未批不许搜/发/验)', ARCHITECTURE_CONTRACT.includes('ask_user_question') && ARCHITECTURE_CONTRACT.includes('STOP') && ARCHITECTURE_CONTRACT.includes('do NOT search, emit, or verify'))
check('契约钉:深度线在(五行清单不是架构)', ARCHITECTURE_CONTRACT.includes('NOT an architecture'))
check('契约钉:缺口处置是用户选择(造件/降级/砍掉)+ 静默降级禁令', ARCHITECTURE_CONTRACT.includes('现场造件') && ARCHITECTURE_CONTRACT.includes('降级方案') && ARCHITECTURE_CONTRACT.includes('Silently downgrading'))
check('契约钉:三岔口路由在(应用型/个人即时/铸造三分 + 铸造非默认)', ARCHITECTURE_CONTRACT.includes('SHAPE ROUTING') && ARCHITECTURE_CONTRACT.includes('应用型') && ARCHITECTURE_CONTRACT.includes('个人即时') && ARCHITECTURE_CONTRACT.includes('NOT the'))
check('契约钉:造件必须走 index-add 质检门', ARCHITECTURE_CONTRACT.includes('index-add.mjs') && ARCHITECTURE_CONTRACT.includes('bypasses the quality gate'))
check('契约钉:夹具模式在范例里(禁内嵌大载荷)', PROBE_SKETCH_EXAMPLES.includes('LARGE FIXTURES') && PROBE_SKETCH_EXAMPLES.includes('NEVER paste'))
// §09 借法钉:缓存段序(动态段沉尾)+ 重试预算封顶
const bpCache = buildMatchPrompt('req-X', { capabilities: [{ name: 'NEED-Y', why: '' }], dataModel: '', workflow: '', interfaces: '' }, catalog)
check('缓存段序:目录在前、动态需求沉尾(match)', bpCache.prompt.indexOf('Catalog:') < bpCache.prompt.indexOf('NEED-Y') && bpCache.prompt.indexOf('GAP DISCIPLINE') < bpCache.prompt.indexOf('NEED-Y'))

// ── P0:BARE 消融 / 契约到期制 / 自检包 ─────────────────────────────────────
const { bareMode, CONTRACT_TAGS, CONTRACT_GENERATION, planToSketch, renderSelfCheck, searchCatalogToolDefinition, matchCatalogToolDefinition } = await import('./lib/orchestrated-tools.js')
const savedBare = process.env.DSH_ASSEMBLER_BARE
const fakeCtx = { get: () => undefined, effect: () => {}, tools: { register: () => {} } }
delete process.env.DSH_ASSEMBLER_BARE
const descFull = searchCatalogToolDefinition(fakeCtx, {}).description
process.env.DSH_ASSEMBLER_BARE = '1'
const descBare = searchCatalogToolDefinition(fakeCtx, {}).description
const matchBare = matchCatalogToolDefinition(fakeCtx, {}).description
if (savedBare === undefined) delete process.env.DSH_ASSEMBLER_BARE
else process.env.DSH_ASSEMBLER_BARE = savedBare
check('BARE:默认关、=1 开', bareMode() === false)
check('BARE:满装描述含契约散文(检查点/基线/硬预算)', descFull.includes('ask_user_question') && descFull.includes('real-world I/O') && descFull.includes('LAST-RESORT'))
check('BARE:消融描述剥净散文、保留事实性一句话', !descBare.includes('ask_user_question') && !descBare.includes('real-world I/O') && descBare.includes('BM25') && descBare.length < descFull.length / 3)
check('BARE:match 描述同样消融', !matchBare.includes('LAST-RESORT') && matchBare.includes('capability id or a GAP'))
check('到期制:每条导出散文常量都登记了适用模型代', ['BASELINE_RULE', 'MINIMAL_SET_RULE', 'FRONTEND_FACT', 'RECIPE_FACT', 'ARCHITECTURE_CONTRACT', 'PROBE_SKETCH_EXAMPLES'].every((k) => typeof CONTRACT_TAGS[k] === 'string' && CONTRACT_TAGS[k] !== '') && CONTRACT_GENERATION === 'deepseek-v4')

const planScn = { kind: 'scenario', scenario: { goal: 'g', turns: [{ prompt: '记 T-9 打车 30 元', mustInclude: ['T-9'] }, { prompt: '查 T-9 报分类', mustInclude: ['打车'] }] } }
const sk = planToSketch(planScn)
check('自检包:2 轮场景计划可还原成草图(token=轮1标记)', sk?.kind === 'scenario' && sk?.token === 'T-9' && sk?.createTask === '记 T-9 打车 30 元')
check('自检包:单轮计划还原', planToSketch({ kind: 'single', probe: { task: '算 1+1', mustInclude: ['2'] } })?.kind === 'single')
check('自检包:3+ 轮场景如实返回 null(rerun 走重推导)', planToSketch({ kind: 'scenario', scenario: { goal: 'g', turns: [{ prompt: 'a', mustInclude: ['x'] }, { prompt: 'b', mustInclude: ['y'] }, { prompt: 'c', mustInclude: ['z'] }] } }) === null)
const scJson = JSON.parse(renderSelfCheck({ presetId: 'p1', presetSha256: 'abc', plan: planScn, verifiedAt: '2026-08-23T00:00:00Z' }))
check('自检包:渲染带版本/代际/rerun 参数(reverify+probe)', scJson.version === 1 && scJson.generation === CONTRACT_GENERATION && scJson.rerun.args.reverify === true && scJson.rerun.args.probe.token === 'T-9')

// ── P2:registry 联邦适配器(纯件)────────────────────────────────────────────
const { validateRegistryItem, fileTargetOf } = await import('./scripts/registry-add.mjs')
check('registry 校验:合法条目过门', validateRegistryItem({ name: 'button', type: 'registry:ui', files: [{ path: 'ui/button.tsx', content: 'x' }] }).length === 0)
check('registry 校验:越界 target 拒绝', validateRegistryItem({ name: 'evil', type: 'registry:ui', files: [{ path: 'a', target: '../../etc/passwd', content: 'x' }] }).some((p) => p.includes('越界')))
check('registry 校验:缺 content/坏 name/坏 type 全报', (() => {
  const p = validateRegistryItem({ name: 'Bad Name', type: 'component', files: [{ path: 'a.tsx' }] })
  return p.some((x) => x.includes('name')) && p.some((x) => x.includes('type')) && p.some((x) => x.includes('content'))
})())
check('registry 落盘名:target 优先且剥 ~/ 前缀', fileTargetOf({ path: 'r/x.tsx', target: '~/components/x.tsx' }) === 'components/x.tsx')

// ── 大载荷机械闸 ────────────────────────────────────────────────────────────
const { probePayloadViolation } = await import('./lib/verify.js')
check('载荷闸:2KB base64 任务被抓', probePayloadViolation(['解析这本书:' + 'A'.repeat(80) + 'Zm9v'.repeat(60)]))
check('载荷闸:正常任务不误伤(短 token/中文/路径)', !probePayloadViolation(['解析工作区 uploads/weichen.epub,报出书名与第二章标题', '记一笔 PO-4471 采购单', undefined]))

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


// ── 配方车道(via:'recipe':emit_app 哑实例化 + verify_app 独立考官)──────────
{
  const { loadRecipe, materializeApp, runAppSelftest, hashTemplate, RECIPES_DIR } = await import('./lib/recipe.js')
  const { emitAppToolDefinition, verifyAppToolDefinition } = await import('./lib/orchestrated-tools.js')
  const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  // 清单校验
  const spec = loadRecipe('rag-qa')
  check('recipe:清单加载且考卷非空', spec.version >= 1 && spec.selftest.checks.length >= 2 && spec.run.start[0] === 'node')
  let threw = ''
  try { loadRecipe('no-such-recipe') } catch (e) { threw = e.message }
  check('recipe:不存在的配方报可行动错误', threw.includes('no-such-recipe'))

  // 实例化:缺参可行动、密钥形参拒、仓库内落地拒
  const tmp = mkdtempSync(join(tmpdir(), 'recipe-test-'))
  try {
    let missErr = ''
    try { materializeApp({ recipeId: 'rag-qa', targetDir: join(tmp, 'a1'), params: { APP_NAME: 'x' } }) } catch (e) { missErr = e.message }
    check('emit_app:缺必填参数 → 列名带说明(可行动错误)', missErr.includes('SELFTEST_QUESTION') && missErr.includes('ROLE_LINE') && missErr.includes(':'))
    let secErr = ''
    try { materializeApp({ recipeId: 'rag-qa', targetDir: join(tmp, 'a2'), params: { ...spec.sample.params, API_KEY_HERE: 'v' } }) } catch (e) { secErr = e.message }
    check('emit_app:密钥形状的参数键机械拒绝', secErr.includes('API_KEY_HERE') && secErr.includes('环境变量'))
    let repoErr = ''
    try { materializeApp({ recipeId: 'rag-qa', targetDir: join(RECIPES_DIR, '..', 'some-app'), params: spec.sample.params }) } catch (e) { repoErr = e.message }
    check('emit_app:拒绝落在装配器仓库内', repoErr.includes('仓库'))

    // 正常实例化(带 sample 语料):config 注入、语料自包含、ingest 预跑、lock 落盘
    const appDir = join(tmp, 'app')
    const r = materializeApp({ recipeId: 'rag-qa', targetDir: appDir, params: spec.sample.params, corpusDir: join(RECIPES_DIR, 'rag-qa', spec.sample.corpusDir) })
    const cfg = JSON.parse(readFileSync(join(appDir, 'app.config.json'), 'utf8'))
    check('emit_app:参数经 app.config.json 注入(模板零替换)', cfg.APP_NAME === spec.sample.params.APP_NAME && cfg.recipe === 'rag-qa')
    check('emit_app:语料拷入 corpus/ 且 ingest 预跑出块', r.corpus !== null && r.corpus.files === 2 && r.chunks > 0 && existsSync(join(appDir, 'data', 'index.json')))
    check('emit_app:recipe.lock.yml 带出处与考题参数', readFileSync(r.lockPath, 'utf8').includes('templateHash') && readFileSync(r.lockPath, 'utf8').includes('SELFTEST_MARKER'))
    check('emit_app:非空目录不带 fresh 拒绝', (() => { try { materializeApp({ recipeId: 'rag-qa', targetDir: appDir, params: spec.sample.params }); return false } catch (e) { return e.message.includes('fresh') } })())

    // 独立考官(接口模式:确保无 key)
    const savedKey = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    try {
      const st = await runAppSelftest(appDir)
      check('verify_app:无 key 接口模式 → SKIPPED 且检索半边过、AI 半边点名环境变量', st.status === 'SKIPPED' && st.checks.some((c) => c.check === 'healthz' && c.status === 'PASS') && st.checks.some((c) => c.check === 'ask' && c.status === 'SKIPPED' && c.evidence.includes('DEEPSEEK_API_KEY')))
    } finally {
      if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey
    }
    check('verify_app:非配方目录报可行动错误', await runAppSelftest(tmp).then(() => false, (e) => e.message.includes('recipe.lock.yml')))

    // 模板哈希稳定性(同字节同哈希)
    check('recipe:模板哈希确定性', hashTemplate(join(RECIPES_DIR, 'rag-qa', 'template')) === r.templateHash)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  // 契约钉:两工具的承重句
  const emitDesc = emitAppToolDefinition(fakeCtx, {}).description
  const verifyDesc = verifyAppToolDefinition(fakeCtx, {}).description
  check('契约钉:emit_app = 哑印刷 + 考题参数职责 + 密钥不落文件 + 接力棒', emitDesc.includes('DUMB app materializer') && emitDesc.includes('SELFTEST_QUESTION') && emitDesc.includes('Secrets NEVER') && emitDesc.includes('verify_app'))
  check('契约钉:verify_app = 独立考官 + 外科修复 + 凭证≠失败 + 3 次停手', verifyDesc.includes('INDEPENDENT examiner') && verifyDesc.includes('surgical') && verifyDesc.includes('SKIPPED') && verifyDesc.includes('3 次 FAIL'))
  process.env.DSH_ASSEMBLER_BARE = '1'
  const { emitAppToolDefinition: emitBareF } = await import('./lib/orchestrated-tools.js')
  const emitBare = emitBareF(fakeCtx, {}).description
  delete process.env.DSH_ASSEMBLER_BARE
  check('BARE:emit_app 散文可剥、事实句保留', !emitBare.includes('接力棒') && emitBare.includes('recipe.lock.yml'))

  // 检索行:via:'recipe' 价签与凭证(不起进程,直接考 rank + 目录条目)
  const cat2 = (await import('./lib/index.js')).loadCatalog('capabilities.yml')
  const entry = cat2.capabilities.find((c) => c.id === 'recipe-rag-qa')
  check('目录:recipe-rag-qa 已登记且凭证声明直挂条目', entry !== undefined && entry.via === 'recipe' && Array.isArray(entry.config.requiredSecrets) && entry.config.requiredSecrets[0].env === 'DEEPSEEK_API_KEY')
  const hits2 = rankCapabilities(cat2.capabilities, '把产品文档变成问答网页 app', 3)
  check('检索:app 型问答需求 → 配方第一名', hits2[0]?.entry.id === 'recipe-rag-qa')
}


// ── scaffold 车道(S1-S3:词汇/骨架/五考)────────────────────────────────────
{
  const { loadRecipe, hashLockPaths, RECIPES_DIR } = await import('./lib/recipe.js')
  const { join } = await import('node:path')
  const { existsSync, readdirSync, readFileSync: rf2 } = await import('node:fs')
  const sc = loadRecipe('scaffold-react')
  check('scaffold:配方加载,五考齐(build/skeleton-lock/pages-lint/static-reach/behavior)', ['build','skeleton-lock','pages-lint','static-reach','behavior'].every((k) => sc.selftest.checks.some((c) => c.kind === k)))
  check('scaffold:lockPaths 覆盖骨架/SDK/词汇', Array.isArray(sc.lockPaths) && ['src/sdk','src/components','src/App.tsx'].every((k) => sc.lockPaths.includes(k)))
  check('scaffold:词汇表 ≥13 件(shadcn 联邦入库)', readdirSync(join(RECIPES_DIR,'scaffold-react','template','src','components','ui')).filter((f) => f.endsWith('.tsx')).length >= 13)
  check('scaffold:TS 版 SDK 三纪律在(围栏出声/IME 守卫/服务脸)', (() => { const t = rf2(join(RECIPES_DIR,'scaffold-react','template','src','sdk','assembler-sdk.ts'),'utf8'); return t.includes('extractFence') && t.includes('isComposing') && t.includes('/.service') })())
  const h1 = hashLockPaths(join(RECIPES_DIR,'scaffold-react','template'), sc.lockPaths)
  check('scaffold:锁定面哈希确定性', h1 === hashLockPaths(join(RECIPES_DIR,'scaffold-react','template'), sc.lockPaths) && /^[0-9a-f]{16}$/.test(h1))
  const cat3 = (await import('./lib/index.js')).loadCatalog('capabilities.yml')
  const hits3 = rankCapabilities(cat3.capabilities, '定制前端页面 react 界面', 3)
  check('scaffold:目录已登记且可检得', cat3.capabilities.some((c) => c.id === 'recipe-scaffold-react') && hits3.some((h) => h.entry.id === 'recipe-scaffold-react'))
}


// ── 写手席(WRITE-ME/接力棒/deploy_app)──────────────────────────────────────
{
  const { SCAFFOLD_BATON, CONTRACT_TAGS: tags2, deployAppToolDefinition } = await import('./lib/orchestrated-tools.js')
  const { RECIPES_DIR } = await import('./lib/recipe.js')
  const { readFileSync: rf3, existsSync: ex3 } = await import('node:fs')
  const { join: j3 } = await import('node:path')
  const wm = rf3(j3(RECIPES_DIR, 'scaffold-react', 'template', 'WRITE-ME.md'), 'utf8')
  check('写手席:WRITE-ME 事实齐(自由区/词汇/SDK/考卷/交付流/范例)', ['自由区', 'PAGE-SPEC', 'sqliteFace', 'bindEnter', 'deploy_app', 'examples/board.tsx'].every((k) => wm.includes(k)))
  check('写手席:范例两张在模板内且被骨架锁覆盖', ex3(j3(RECIPES_DIR, 'scaffold-react', 'template', 'examples', 'board.tsx')) && ex3(j3(RECIPES_DIR, 'scaffold-react', 'template', 'examples', 'records.tsx')))
  check('契约钉:SCAFFOLD_BATON 承重句(读手册/先考卷后页面/自由区/列名照抄/3 次停手/deploy)', ['WRITE-ME.md', 'PAGE-SPEC.yml first', 'Free zone', 'never invent', '3 次 FAIL', 'deploy_app'].every((k) => SCAFFOLD_BATON.includes(k)) && tags2.SCAFFOLD_BATON === 'deepseek-v4')
  const dep = deployAppToolDefinition(fakeCtx, {}).description
  check('契约钉:deploy_app = 确定性发布 + 先考后发', dep.includes('Deterministic copy') && dep.includes('verify_app PASS'))
  check('deploy_app:无 dist 报可行动错误', await deployAppToolDefinition(fakeCtx, {}).execute({ targetDir: '/tmp/no-such-app-x', presetId: 'x' }).then(() => false, (e) => e.message.includes('verify_app')))
}


// ── P2/P4 批次:ai-thin 路由 / 文件通道 / 触发考 / adopt 门 ──────────────────
{
  const { verifyTriggerToolDefinition, VERIFY_TRIGGER_TOOL_NAME } = await import('./lib/orchestrated-tools.js')
  const { readFileSync: rf4 } = await import('node:fs')
  const { join: j4 } = await import('node:path')
  const { RECIPES_DIR: RD } = await import('./lib/recipe.js')

  // ai-thin:双脸同源 + SDK 双版都有 aiFace + WRITE-ME 教了路由判据
  const aiPart = rf4('generated/ai-call/index.js', 'utf8')
  check('ai-thin:ai-call 双脸共用同一段 complete 实现(不分叉)', aiPart.includes('async function complete(') && aiPart.includes('ai-face-info') && (aiPart.match(/chat\/completions/g) ?? []).length === 1)
  check('ai-thin:密钥纪律与 maxTokens 地板仍在', aiPart.includes('process.env.DEEPSEEK_API_KEY') && aiPart.includes('Math.max(256'))
  const sdkJs = rf4('frontends/_vendor/assembler-sdk.js', 'utf8')
  const sdkTs = rf4(j4(RD, 'scaffold-react', 'template', 'src', 'sdk', 'assembler-sdk.ts'), 'utf8')
  check('SDK 双版:aiFace + filesFace 都在(模板与 scaffold 同能力)', ['aiFace', 'filesFace'].every((k) => sdkJs.includes(k) && sdkTs.includes(k)))
  const wm2 = rf4(j4(RD, 'scaffold-react', 'template', 'WRITE-ME.md'), 'utf8')
  check('WRITE-ME:四档路由判据齐(face/ai-thin/wire/local)', ['route: face', 'route: ai-thin', 'route: wire', 'route: local'].every((k) => wm2.includes(k)) && wm2.includes('别为它开会话'))

  // 判断器 app 镜像与零件纪律一致(双脸制度化的机械钉)
  for (const rec of ['rag-qa', 'record-desk']) {
    const mirror = rf4(j4(RD, rec, 'template', 'lib', 'ai.mjs'), 'utf8')
    check(`双脸制度化:${rec} 的 app 镜像守同款纪律(env-only key + 256 地板)`, mirror.includes('process.env.DEEPSEEK_API_KEY') && mirror.includes('Math.max(256'))
  }

  // file-channel:登记 + 服务脸声明
  const cat4 = (await import('./lib/index.js')).loadCatalog('capabilities.yml')
  check('file-channel:已登记且声明服务脸', (cat4['mcp-servers'] ?? {})['file-channel']?.serviceAnnounce === 'file-channel-info')
  check('ai-call:声明服务脸(检索行会报"浏览器可直连")', (cat4['mcp-servers'] ?? {})['ai-call']?.serviceAnnounce === 'ai-face-info')

  // verify_trigger 契约与闸门
  const vt = verifyTriggerToolDefinition(fakeCtx, {})
  check('契约钉:verify_trigger = 打一发验后果 + 不看回复', vt.description.includes('judges by EFFECT') && vt.description.includes('never read') && VERIFY_TRIGGER_TOOL_NAME === 'verify_trigger')
  const vtThrows = async (args, needle) => vt.execute(args).then(() => false, (e) => String(e.message).includes(needle))
  check('verify_trigger 闸:task 必须含口令', await vtThrows({ presetId: 'x', task: '干活', effectSql: 'SELECT 1', expect: 'TOK-1234' }, '必须包含'))
  check('verify_trigger 闸:effectSql 必须只读', await vtThrows({ presetId: 'x', task: 'TOK-1234', effectSql: 'DELETE FROM t', expect: 'TOK-1234' }, '只读'))
  check('verify_trigger 闸:expect 太短拒', await vtThrows({ presetId: 'x', task: 'ok', effectSql: 'SELECT 1', expect: 'ok' }, '≥4'))

  // adopt 门:收编件出处链
  const catalogText = rf4('index/catalog.yml', 'utf8')
  check('adopt:收编件出处链完整(adopted/pkg/rev/repo/license)', /- id: kg-memory\n  adopted: true\n  pkg: "@modelcontextprotocol\/server-memory"\n  rev: "v[\d.]+"/.test(catalogText))
  check('adopt:入口指向包内 bin(不是自造 index.js)', JSON.stringify((cat4['mcp-servers'] ?? {})['kg-memory'] ?? {}).includes('node_modules/@modelcontextprotocol/server-memory'))
}


// ── 采购批(2026-08-25):目录出处 + 服务脸声明 + 凭证声明 ────────────────────
{
  const cat5 = (await import('./lib/index.js')).loadCatalog('capabilities.yml')
  const servers5 = cat5['mcp-servers'] ?? {}
  const NEW = ['speech-io', 'vector-store', 'embed-text', 'translate-text', 'route-plan', 'im-bot', 'object-store']
  check('采购批:7 件全部登记进联邦面', NEW.every((k) => servers5[k] !== undefined), NEW.filter((k) => servers5[k] === undefined).join(','))
  check('采购批:该长服务脸的两件声明了(音频/向量),该单脸的没乱长', servers5['speech-io']?.serviceAnnounce === 'speech-info' && servers5['vector-store']?.serviceAnnounce === 'vector-info' && servers5['translate-text']?.serviceAnnounce === undefined && servers5['route-plan']?.serviceAnnounce === undefined)
  const secretOf = (k) => (servers5[k]?.requiredSecrets ?? []).map((x) => x.env)
  check('采购批:凭证只声明名字(值不进目录)', secretOf('object-store').includes('S3_ACCESS_KEY') && secretOf('im-bot').includes('WECOM_WEBHOOK') && secretOf('embed-text').includes('EMBED_API_KEY') && !JSON.stringify(servers5).includes('sk-'))
  check('采购批:零凭证件不声明凭证(translate/route/vector 干净)', ['translate-text', 'route-plan', 'vector-store'].every((k) => secretOf(k).length === 0))
  const catalogText5 = (await import('node:fs')).readFileSync('index/catalog.yml', 'utf8')
  check('采购批:服务型出处带条款与速率(供应链诚实)', /- id: translate-text\n  kind: service\n[\s\S]*?terms: "https:\/\/mymemory/.test(catalogText5) && /- id: route-plan\n  kind: service\n[\s\S]*?Api-usage-policy/.test(catalogText5))
  // 检索可见性:mcp 件的能力条目由装配时的联邦实探生成(federateMcpTools),
  // 不落静态 capabilities.yml——这里验"联邦所需的两件事都在":连接配置 + 目录
  // 里登记的工具清单(带描述,检索靠它)。
  const toolsOf = (id) => { const m = new RegExp(`- id: ${id}\\n(?:  .*\\n)*?  tools:\\n((?:    - .*\\n)+)`).exec(catalogText5); return m === null ? [] : m[1].trim().split('\n') }
  check('采购批:目录登记了工具清单(联邦检索的素材)', toolsOf('speech-io').length === 4 && toolsOf('speech-io').some((l) => l.includes('speak')) && toolsOf('vector-store').length === 4)
}


// ── 契约:车道判据 + 管道可达(泛化战役发现的两处修补)──────────────────────
{
  const { ARCHITECTURE_CONTRACT: AC, addKnowledgeToolDefinition, ADD_KNOWLEDGE_TOOL_NAME } = await import('./lib/orchestrated-tools.js')
  check('契约钉:配方 vs preset 车道判据在(重叠时怎么选 + 要说出来)', AC.includes('LANE TIE-BREAK') && AC.includes('RECIPE (self-contained') && AC.includes('PRESET (双面交付') && AC.includes('SAY which lane you picked'))
  check('契约钉:知识包走工具面(沙箱现实),造件仍走管道且够不着就上报', AC.includes('add_knowledge TOOL') && AC.includes('sandbox cannot reach') && AC.includes('hand the work order to the user'))
  const ak = addKnowledgeToolDefinition(fakeCtx, {}).description
  check('契约钉:add_knowledge = 工具面孪生 + 检索门 + 自己写考题', ak.includes('tool-surface twin') && ak.includes('RETRIEVAL GATE') && ak.includes('YOU write the probes') && ADD_KNOWLEDGE_TOOL_NAME === 'add_knowledge')
  const throwsK = async (args, needle) => addKnowledgeToolDefinition(fakeCtx, {}).execute(args).then(() => false, (e) => String(e.message).includes(needle))
  check('add_knowledge 闸:无考题拒', await throwsK({ docsDir: '/tmp', id: 'x', description: 'd', probes: [] }, '没有考题'))
  check('add_knowledge 闸:相对路径拒', await throwsK({ docsDir: 'rel/path', id: 'x', description: 'd', probes: [{ question: 'q', mustInclude: ['m'] }] }, '绝对路径'))
}

if (failures > 0) {
  console.error(`\ntests-orchestrated: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\ntests-orchestrated: all green')
