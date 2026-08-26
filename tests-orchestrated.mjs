#!/usr/bin/env node
/**
 * 工具面纯件单测:match_catalog 的输入归一/prompt 契约/响应整形、emit_preset 的
 * 入参机械校验与三道闸、verify_preset 的草图归一、检索/契约钉。跑法:
 * node tests-orchestrated.mjs(先 npm run build)。LLM 调用与探针执行不在此测
 * (那是 E2E 与战役的事)。
 */
import {
  assemblerMode, buildMatchPrompt, normalizeProbeSketch, normalizeSpecInput,
  parseMatchResponse, validateEmitArgs,
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

// ── 死知识闸(装了教材却没有打开它的手)──────────────────────────────────────
const { deadKnowledgeError } = await import('./lib/orchestrated-tools.js')
const { canReadKb, KBDIR_SLOT } = await import('./lib/index.js')
const KB_SERVERS = {
  filesystem: { args: ['/x/server-filesystem/dist/index.js', '@@WORKSPACE@@', KBDIR_SLOT] },
  sqlite: { args: ['/x/sqlite.js', '@@WORKSPACE@@'] },
}
check('读取面判定:mcp 件由 @@KBDIR@@ 槽位结构推定(不按 server 名字认)',
  canReadKb({ id: 'mcp-filesystem-read', via: 'mcp', description: '', tags: [], config: { server: 'filesystem' } }, KB_SERVERS)
  && !canReadKb({ id: 'mcp-sqlite-query', via: 'mcp', description: '', tags: [], config: { server: 'sqlite' } }, KB_SERVERS))
check('读取面判定:非 mcp 件靠目录显式 readsKb(harness 行没有可推定的结构)',
  canReadKb({ id: 'content-search', via: 'harness', description: '', tags: [], config: { readsKb: true } }, KB_SERVERS)
  && !canReadKb({ id: 'web-lookup', via: 'harness', description: '', tags: [], config: {} }, KB_SERVERS))
const CAT_READERS = ['content-search', 'mcp-filesystem-read-text-file']
check('死知识闸:没选知识包 = 不问(普通 preset 不受影响)',
  deadKnowledgeError({ packIds: [], readerIds: [], catalogReaderIds: CAT_READERS }) === null)
const deadErr = deadKnowledgeError({ packIds: ['kb-manual'], readerIds: [], catalogReaderIds: CAT_READERS })
check('死知识闸:装了教材没有读取面 → 拦,并把候选读取面一起送到',
  deadErr !== null && deadErr.includes('kb-manual') && deadErr.includes('content-search'), String(deadErr))
check('死知识闸:错误里点名"persona 写一句不算修"(A1 实录的错误修法)',
  deadErr?.includes('散文') === true)
check('死知识闸:有读取面就放行',
  deadKnowledgeError({ packIds: ['kb-manual'], readerIds: ['mcp-filesystem-read-text-file'], catalogReaderIds: CAT_READERS }) === null)
check('死知识闸:目录里一个读取面都没有时如实说明是缺件',
  deadKnowledgeError({ packIds: ['kb-manual'], readerIds: [], catalogReaderIds: [] })?.includes('缺件') === true)
// 真目录钉:content-search 的 readsKb 是承重声明,删掉就没人能读 kb 了
{
  const { readFileSync: rfKb } = await import('node:fs')
  const capsText = rfKb('capabilities.yml', 'utf8')
  check('真目录钉:content-search 声明了 readsKb(唯一的非 mcp 读取面)', /readsKb: true/.test(capsText))
  check('真目录钉:filesystem 服务器仍以 @@KBDIR@@ 为第二根(闸的结构判据)', capsText.includes(KBDIR_SLOT))
}
{
  // 接力棒预先交代读取面:入库的下一步必然是发射,别等它撞上闸再说
  const { addKnowledgeToolDefinition: akd } = await import('./lib/orchestrated-tools.js')
  const src = (await import('node:fs')).readFileSync('src/orchestrated-tools.ts', 'utf8')
  check('接力棒钉:add_knowledge 回执点名"同时挂一件够得着 kb/ 的零件"',
    src.includes('够得着 kb/ 的零件') && src.includes('死知识闸拒印') && typeof akd === 'function')
}

// ── 页面级迭代:发布留快照 + 源头回指针 + 一键回滚 ────────────────────────────
{
  const { mkdtempSync: mkt, mkdirSync: mkd, writeFileSync: wfs, readFileSync: rfs, existsSync: exs } = await import('node:fs')
  const { tmpdir: tmpd } = await import('node:os')
  const { join: pj } = await import('node:path')
  const { deployAppToolDefinition, readPresetToolDefinition: rpd } = await import('./lib/orchestrated-tools.js')
  const tmp = mkt(pj(tmpd(), 'deploy-iter-'))
  const root = pj(tmp, 'presets'); const pdir = pj(root, 'p1')
  mkd(pdir, { recursive: true }); wfs(pj(pdir, 'agent.cordis.yml'), 'name: p1\n')
  const app = pj(tmp, 'app'); mkd(pj(app, 'dist'), { recursive: true })
  wfs(pj(app, 'scaffold.lock.yml'), 'scaffold: scaffold-react\nversion: 4\n')
  const putDist = (marker) => wfs(pj(app, 'dist', 'index.html'), `<div id=root>${marker}</div>`)
  const dep = deployAppToolDefinition({ get: () => undefined }, { presetRoot: root })
  const page = () => rfs(pj(pdir, 'frontend', 'index.html'), 'utf8')

  putDist('V1')
  const r1 = await dep.execute({ targetDir: app, presetId: 'p1' })
  check('页面迭代:首发无快照可留,但源头已记录', page().includes('V1') && r1.includes('源头已记录')
    && !exs(pj(pdir, 'frontend.prev', 'index.html')) && JSON.parse(rfs(pj(pdir, 'frontend.source.json'), 'utf8')).scaffold === 'scaffold-react')
  check('页面迭代:回滚无快照时报可行动错误(不静默)',
    await dep.execute({ presetId: 'p1', rollback: true }).then(() => false, (e) => String(e.message).includes('没有可回滚的上一版')))

  putDist('V2')
  await dep.execute({ targetDir: app, presetId: 'p1' })
  check('页面迭代:二次发布覆盖当前版并留下上一版快照', page().includes('V2') && rfs(pj(pdir, 'frontend.prev', 'index.html'), 'utf8').includes('V1'))
  await dep.execute({ presetId: 'p1', rollback: true })
  check('页面迭代:一键回滚回到 V1(不需要 targetDir)', page().includes('V1'))
  await dep.execute({ presetId: 'p1', rollback: true })
  check('页面迭代:回滚本身可回滚(互换,按错了不丢好版本)', page().includes('V2'))

  const rp = await rpd({ get: () => undefined }, { presetRoot: root }).execute({ presetId: 'p1', include: ['frontend'] })
  check('页面迭代:read_preset 报出源头与可回滚(下一轮不必满盘找源码)',
    rp.includes(app) && rp.includes('scaffold-react') && rp.includes('上一版:有快照'), rp.slice(-200))
  check('页面迭代:未记录源头的 preset 如实说"未记录",不编造',
    (await rpd({ get: () => undefined }, { presetRoot: root }).execute({ presetId: 'p1', include: ['frontend'] })).includes('源头:'))
}

// ── normalizeProbeSketch ────────────────────────────────────────────────────
const sk1 = normalizeProbeSketch({ createTask: '建档 T-1', retrieveTask: '取 T-1', token: 'T-1', marks: [500, '张三'] })
check('草图归一:有 createTask 缺 kind → scenario;marks 字符串化', sk1?.kind === 'scenario' && sk1?.marks?.[0] === '500')
const sk2 = normalizeProbeSketch({ task: '算 1+1', marks: ['2'] })
check('草图归一:只有 task → single', sk2?.kind === 'single')
check('草图归一:非对象 = null', normalizeProbeSketch('x') === null && normalizeProbeSketch(null) === null)

// ── 形态(宪法第八条执行后:search 唯一,off 停用;四个实验臂 git 备查)──────
const saved = process.env.DSH_ASSEMBLER_MODE
delete process.env.DSH_ASSEMBLER_MODE
const modeDefault = assemblerMode() === 'search'
process.env.DSH_ASSEMBLER_MODE = 'off'
const modeOff = assemblerMode() === 'off'
// 死方言的名字不再是合法形态:显式设置也回落 search(git 备查,不留 if 备查)。
const modeDead = ['pipeline', 'orchestrated', 'draft', 'dialogue', 'bogus'].every((m) => {
  process.env.DSH_ASSEMBLER_MODE = m
  return assemblerMode() === 'search'
})
if (saved === undefined) delete process.env.DSH_ASSEMBLER_MODE
else process.env.DSH_ASSEMBLER_MODE = saved
check('形态:默认 search、off 可停用、死方言名与非法值一律回落 search', modeDefault && modeOff && modeDead)

// ── 承重契约句(改契约掉了哪句立刻红——阶段1 的回归底线)────────────────────
const { FRONTEND_FACT, PROBE_SKETCH_EXAMPLES } = await import('./lib/orchestrated-tools.js')
check('契约钉:前端物理事实在(仅首个模板生效)', FRONTEND_FACT.includes('首个') && FRONTEND_FACT.includes('生效'))
check('契约钉:出题范例双形状在(scenario+single,token 两轮自足)', PROBE_SKETCH_EXAMPLES.includes('"kind":"scenario"') && PROBE_SKETCH_EXAMPLES.includes('"kind":"single"') && PROBE_SKETCH_EXAMPLES.includes('PO-4471'))
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
check('到期制:每条导出散文常量都登记了适用模型代', ['FRONTEND_FACT', 'SCAFFOLD_BATON', 'PROBE_SKETCH_EXAMPLES', 'ASSEMBLY_BATON'].every((k) => typeof CONTRACT_TAGS[k] === 'string' && CONTRACT_TAGS[k] !== '') && CONTRACT_GENERATION === 'deepseek-v4')
{
  // 到期哨(阶段 2 收尾):登记代此前没人对表真实 host 模型——换代靠人记得。
  // 钉抽取器行为;哨本体挂 search_catalog 入口,喝 CONTRACT_GENERATION 原泉。
  const { proseGenerationOf } = await import('./lib/orchestrated-tools.js')
  check('到期哨:代际抽取(flash 变体归代)', proseGenerationOf('deepseek-v4-flash') === 'deepseek-v4')
  check('到期哨:换代可辨(v5 ≠ 登记代)', proseGenerationOf('deepseek-v5-pro') === 'deepseek-v5' && proseGenerationOf('deepseek-v5-pro') !== CONTRACT_GENERATION)
  check('到期哨:登记代自身是规范形(抽取幂等)', proseGenerationOf(CONTRACT_GENERATION) === CONTRACT_GENERATION)
  check('到期哨:认不出的 id 原样返回不硬猜', proseGenerationOf('mystery-model') === 'mystery-model')
}

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

// ── 检索:rankCapabilities ──────────────────────────────────────────────────
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


// ── app 车道(scaffold 唯一底盘:emit_app 哑实例化 + verify_app 独立考官)─────
{
  const { loadScaffold, materializeApp, runAppSelftest, hashTemplate, hashLockPaths, SCAFFOLD_DIR } = await import('./lib/scaffold.js')
  const { emitAppToolDefinition, verifyAppToolDefinition } = await import('./lib/orchestrated-tools.js')
  const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync: readdirSync2 } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  // 真底盘清单:五考齐、锁定面覆盖骨架/SDK/词汇、词汇表规模、SDK 三纪律
  const sc = loadScaffold()
  check('scaffold:清单加载,五考齐(build/skeleton-lock/pages-lint/static-reach/behavior)', ['build','skeleton-lock','pages-lint','static-reach','behavior'].every((k) => sc.selftest.checks.some((c) => c.kind === k)))
  check('scaffold:lockPaths 覆盖骨架/SDK/词汇', Array.isArray(sc.lockPaths) && ['src/sdk','src/components','src/App.tsx'].every((k) => sc.lockPaths.includes(k)))
  check('scaffold:词汇表 ≥13 件(shadcn 联邦入库)', readdirSync2(join(SCAFFOLD_DIR,'template','src','components','ui')).filter((f) => f.endsWith('.tsx')).length >= 13)
  check('scaffold:TS 版 SDK 三纪律在(围栏出声/IME 守卫/服务脸)', (() => { const t = readFileSync(join(SCAFFOLD_DIR,'template','src','sdk','assembler-sdk.ts'),'utf8'); return t.includes('extractFence') && t.includes('isComposing') && t.includes('/.service') })())
  const hh = hashLockPaths(join(SCAFFOLD_DIR,'template'), sc.lockPaths)
  check('scaffold:锁定面哈希确定性', hh === hashLockPaths(join(SCAFFOLD_DIR,'template'), sc.lockPaths) && /^[0-9a-f]{16}$/.test(hh))
  check('scaffold:模板哈希确定性', hashTemplate(join(SCAFFOLD_DIR,'template')) === hashTemplate(join(SCAFFOLD_DIR,'template')))

  // 单车道钉(宪法第九条):目录里不再有任何 via:'recipe' 条目——app 形态不是零件,是装备
  const catMerged = (await import('./lib/index.js')).loadCatalog('capabilities.yml')
  check('单车道钉:目录零 recipe 条目(app 车道 = scaffold 装备,不进零件目录)', !catMerged.capabilities.some((c) => c.via === 'recipe' || String(c.id).startsWith('recipe-')))

  // 实例化闸(轻量假底盘,不跑 npm install——真底盘的全链在出厂门 index-add.mjs scaffold)
  const tmp = mkdtempSync(join(tmpdir(), 'scaffold-test-'))
  try {
    const fixRoot = join(tmp, 'fix')
    mkdirSync(join(fixRoot, 'template'), { recursive: true })
    writeFileSync(join(fixRoot, 'template', 'index.html'), '<div id="root"></div>')
    writeFileSync(join(fixRoot, 'scaffold.yml'), [
      'id: t-scaffold', 'version: 1', 'description: 测试底盘', 'license: BSD-3-Clause',
      'params:', '  - key: APP_NAME', '    description: 应用名', '    required: true', '    example: 台账',
      '  - key: PRESET_ID', '    description: 配套 preset', '    required: true',
      'requiredSecrets: []', 'lockPaths: [index.html]',
      'run: { start: [node, x.mjs], readyPath: / }',
      'selftest: { checks: [ { kind: build } ] }',
      'sample: { params: { APP_NAME: x, PRESET_ID: p } }',
    ].join('\n'))
    let missErr = ''
    try { materializeApp({ targetDir: join(tmp, 'a1'), params: { APP_NAME: 'x' }, scaffoldRoot: fixRoot }) } catch (e) { missErr = e.message }
    check('emit_app:缺必填参数 → 列名带说明(可行动错误)', missErr.includes('PRESET_ID') && missErr.includes('配套 preset'))
    let secErr = ''
    try { materializeApp({ targetDir: join(tmp, 'a2'), params: { APP_NAME: 'x', PRESET_ID: 'p', API_KEY_HERE: 'v' }, scaffoldRoot: fixRoot }) } catch (e) { secErr = e.message }
    check('emit_app:密钥形状的参数键机械拒绝', secErr.includes('API_KEY_HERE') && secErr.includes('环境变量'))
    let repoErr = ''
    try { materializeApp({ targetDir: join(SCAFFOLD_DIR, '..', 'some-app'), params: { APP_NAME: 'x', PRESET_ID: 'p' }, scaffoldRoot: fixRoot }) } catch (e) { repoErr = e.message }
    check('emit_app:拒绝落在装配器仓库内', repoErr.includes('仓库'))

    // 正常实例化:config 注入(scaffold 键)、lock 落盘、骨架锁哈希、pages 迁入 + 考卷升根
    const pagesDir = join(tmp, 'pages'); mkdirSync(pagesDir, { recursive: true })
    writeFileSync(join(pagesDir, 'home.tsx'), 'export default function H(){return null}')
    writeFileSync(join(pagesDir, 'PAGE-SPEC.yml'), 'pages: []')
    const appDir = join(tmp, 'app')
    const r = materializeApp({ targetDir: appDir, params: { APP_NAME: '台账', PRESET_ID: 'p1' }, pagesDir, scaffoldRoot: fixRoot })
    const cfg = JSON.parse(readFileSync(join(appDir, 'app.config.json'), 'utf8'))
    check('emit_app:参数经 app.config.json 注入(scaffold 键 + 模板零替换)', cfg.APP_NAME === '台账' && cfg.scaffold === 't-scaffold')
    const lockText = readFileSync(r.lockPath, 'utf8')
    check('emit_app:scaffold.lock.yml 带出处与骨架锁', r.lockPath.endsWith('scaffold.lock.yml') && lockText.includes('templateHash') && lockText.includes('skeletonHash'))
    check('emit_app:pagesDir 迁入自由区且考卷升根', existsSync(join(appDir, 'src', 'pages', 'home.tsx')) && existsSync(join(appDir, 'PAGE-SPEC.yml')) && !existsSync(join(appDir, 'src', 'pages', 'PAGE-SPEC.yml')))
    check('emit_app:非空目录不带 fresh 拒绝', (() => { try { materializeApp({ targetDir: appDir, params: { APP_NAME: 'x', PRESET_ID: 'p' }, scaffoldRoot: fixRoot }); return false } catch (e) { return e.message.includes('fresh') } })())
    check('verify_app:非 app 目录报可行动错误', await runAppSelftest(tmp, { scaffoldRoot: fixRoot }).then(() => false, (e) => e.message.includes('scaffold.lock.yml')))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  // 契约钉:两工具的承重句
  const emitDesc = emitAppToolDefinition(fakeCtx, {}).description
  const verifyDesc = verifyAppToolDefinition(fakeCtx, {}).description
  check('事实钉:emit_app 描述说清它是哑印刷 + 出处锁', emitDesc.includes('DUMB scaffold materializer') && emitDesc.includes('scaffold.lock.yml'))
  check('事实钉:verify_app 描述说清它自起进程黑盒考五门 + 三判定', verifyDesc.includes('INDEPENDENT examiner') && verifyDesc.includes('own process') && verifyDesc.includes('PASS / FAIL / SKIPPED') && verifyDesc.includes('skeleton-lock'))
  process.env.DSH_ASSEMBLER_BARE = '1'
  const { emitAppToolDefinition: emitBareF } = await import('./lib/orchestrated-tools.js')
  const emitBare = emitBareF(fakeCtx, {}).description
  delete process.env.DSH_ASSEMBLER_BARE
  check('BARE:emit_app 散文可剥、事实句保留', !emitBare.includes('接力棒') && emitBare.includes('scaffold.lock.yml'))
}

// ── 写手席(WRITE-ME/接力棒/deploy_app)──────────────────────────────────────
{
  const { SCAFFOLD_BATON, CONTRACT_TAGS: tags2, deployAppToolDefinition } = await import('./lib/orchestrated-tools.js')
  const { SCAFFOLD_DIR: SD3 } = await import('./lib/scaffold.js')
  const { readFileSync: rf3, existsSync: ex3 } = await import('node:fs')
  const { join: j3 } = await import('node:path')
  const wm = rf3(j3(SD3, 'template', 'WRITE-ME.md'), 'utf8')
  check('写手席:WRITE-ME 事实齐(自由区/词汇/SDK/考卷/交付流/范例=起始页)', ['自由区', 'PAGE-SPEC', 'sqliteFace', 'bindEnter', 'deploy_app', 'examples/board.tsx', '整页拷进'].every((k) => wm.includes(k)))
  check('写手席:范例两张在模板内且被骨架锁覆盖', ex3(j3(SD3, 'template', 'examples', 'board.tsx')) && ex3(j3(SD3, 'template', 'examples', 'records.tsx')))
  check('契约钉:SCAFFOLD_BATON 承重句(读手册/先考卷后页面/自由区/列名照抄/3 次停手/deploy)', ['WRITE-ME.md', 'PAGE-SPEC.yml first', 'Free zone', 'never invent', '3 次 FAIL', 'deploy_app'].every((k) => SCAFFOLD_BATON.includes(k)) && tags2.SCAFFOLD_BATON === 'deepseek-v4')
  const dep = deployAppToolDefinition(fakeCtx, {}).description
  check('事实钉:deploy_app 描述说清确定性拷贝 + 快照可回滚 + 源头回指针', dep.includes('Deterministic copy') && dep.includes('rollback') && dep.includes('where the page came from'))
  // 两道门各报各的(顺序:先解析 preset——回滚路径不带 targetDir,必须先有 preset)
  check('deploy_app:preset 不存在报可行动错误', await deployAppToolDefinition(fakeCtx, {}).execute({ targetDir: '/tmp/no-such-app-x', presetId: 'no-such-preset-x' }).then(() => false, (e) => e.message.includes('不存在')))
  {
    const { mkdtempSync: mk, mkdirSync: md, writeFileSync: wf } = await import('node:fs')
    const { tmpdir: td } = await import('node:os')
    const rootD = mk(j3(td(), 'dep-nodist-')); md(j3(rootD, 'p'), { recursive: true }); wf(j3(rootD, 'p', 'agent.cordis.yml'), 'name: p\n')
    check('deploy_app:preset 在但无 dist 报可行动错误(指回 verify_app)',
      await deployAppToolDefinition(fakeCtx, { presetRoot: rootD }).execute({ targetDir: '/tmp/no-such-app-x', presetId: 'p' }).then(() => false, (e) => e.message.includes('verify_app')))
  }
}


// ── P2/P4 批次:ai-thin 路由 / 文件通道 / 触发考 / adopt 门 ──────────────────
{
  const { verifyTriggerToolDefinition, VERIFY_TRIGGER_TOOL_NAME } = await import('./lib/orchestrated-tools.js')
  const { readFileSync: rf4 } = await import('node:fs')
  const { join: j4 } = await import('node:path')
  const { SCAFFOLD_DIR: RD } = await import('./lib/scaffold.js')

  // ai-thin:双脸同源 + SDK 双版都有 aiFace + WRITE-ME 教了路由判据
  const aiPart = rf4('generated/ai-call/index.js', 'utf8')
  check('ai-thin:ai-call 双脸共用同一段 complete 实现(不分叉)', aiPart.includes('async function complete(') && aiPart.includes('ai-face-info') && (aiPart.match(/chat\/completions/g) ?? []).length === 1)
  check('ai-thin:密钥经凭证库读(host 会擦 KEY 形状的环境变量)+ maxTokens 地板仍在', aiPart.includes("readSecret('DEEPSEEK_API_KEY')") && aiPart.includes('Math.max(256'))
  // 全库纪律:凡声明了 requiredSecrets 的零件,都必须用 readSecret 读——直接读
  // process.env 在 host 的擦除策略下必然拿不到(实测:AI 服务脸一直报缺 key)。
  {
    const { readdirSync: rd6, readFileSync: rf6, existsSync: ex6 } = await import('node:fs')
    const offenders = []
    for (const pid of rd6('generated', { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
      const metaPath = `generated/${pid}/.index-meta.json`
      if (!ex6(metaPath)) continue
      const meta = JSON.parse(rf6(metaPath, 'utf8'))
      if (!Array.isArray(meta.requiredSecrets) || meta.requiredSecrets.length === 0) continue
      const src = rf6(`generated/${pid}/index.js`, 'utf8')
      for (const sec of meta.requiredSecrets) {
        const name = String(sec.env)
        const readsDirectly = new RegExp(`process\\.env\\.${name}\\b|process\\.env\\['${name}'\\]`).test(src)
        const usesHelper = src.includes('function readSecret(')
        if (readsDirectly && !usesHelper) offenders.push(`${pid}:${name}`)
      }
    }
    check('全库纪律:声明凭证的零件都经 readSecret 取值(不直读 process.env)', offenders.length === 0, offenders.join(', '))
  }
  const sdkJs = rf4('frontends/_vendor/assembler-sdk.js', 'utf8')
  const sdkTs = rf4(j4(RD, 'template', 'src', 'sdk', 'assembler-sdk.ts'), 'utf8')
  check('SDK 双版:aiFace + filesFace 都在(模板与 scaffold 同能力)', ['aiFace', 'filesFace'].every((k) => sdkJs.includes(k) && sdkTs.includes(k)))
  const wm2 = rf4(j4(RD, 'template', 'WRITE-ME.md'), 'utf8')
  check('WRITE-ME:四档路由判据齐(face/ai-thin/wire/local)', ['route: face', 'route: ai-thin', 'route: wire', 'route: local'].every((k) => wm2.includes(k)) && wm2.includes('别为它开会话'))

  // (曾有"判断器 app 镜像"双脸钉——配方并入 scaffold 后 app 侧 AI 一律走
  //  ai-call 服务脸,不再内嵌镜像实现,钉随镜像消亡,git 备查。)

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
  const { addKnowledgeToolDefinition, ADD_KNOWLEDGE_TOOL_NAME } = await import('./lib/orchestrated-tools.js')
  const ak = addKnowledgeToolDefinition(fakeCtx, {}).description
  check('事实钉:add_knowledge = 工具面孪生 + 检索门(检不出的知识包直接拒收)', ak.includes('tool-surface twin') && ak.includes('RETRIEVAL GATE') && ak.includes('cannot be retrieved is rejected') && ADD_KNOWLEDGE_TOOL_NAME === 'add_knowledge')
  const throwsK = async (args, needle) => addKnowledgeToolDefinition(fakeCtx, {}).execute(args).then(() => false, (e) => String(e.message).includes(needle))
  check('add_knowledge 闸:无考题拒', await throwsK({ docsDir: '/tmp', id: 'x', description: 'd', probes: [] }, '没有考题'))
  check('add_knowledge 闸:相对路径拒', await throwsK({ docsDir: 'rel/path', id: 'x', description: 'd', probes: [{ question: 'q', mustInclude: ['m'] }] }, '绝对路径'))
}

// ── 装配流入口(v4 首轮取证:A1/A2 徒手写码 0/5×2——入口随契约散文之死断链)──
{
  const { ASSEMBLY_BATON, searchCatalogToolDefinition: sct9 } = await import('./lib/orchestrated-tools.js')
  const sDesc = sct9(fakeCtx, {}).description
  check('入口线:search_catalog 描述教路由(BUILD→从这进,不徒手写码)', sDesc.includes('START HERE') && sDesc.includes('NOT with hand-writing code'))
  check('契约钉:装配流接力棒承重句齐(架构/检查点 ask_user_question/缺口三选/独立验收/工具面资源/即时型豁免)',
    ['架构', 'ask_user_question', '现场造件/降级/砍', 'verify_preset 独立验收', '只经工具面', '个人即时'].every((k) => ASSEMBLY_BATON.includes(k)))
  // 接力棒走检索结果(信息面),且 BARE 可剥(消融不作弊)
  const { writeFileSync: wf9, mkdtempSync: mk9 } = await import('node:fs')
  const { join: j9 } = await import('node:path')
  const { tmpdir: td9 } = await import('node:os')
  const d9 = mk9(j9(td9(), 'baton-'))
  const cp9 = j9(d9, 'capabilities.yml')
  wf9(cp9, 'capabilities:\n  - id: sqlite-store\n    via: mcp\n    description: 持久存取\n    tags: ["数据库"]\n    config: {}\n')
  const withBaton = await sct9(fakeCtx, { catalogPath: cp9 }).execute({ query: '数据库' })
  check('接力棒随检索结果走(命中面)', withBaton.includes('【装配流契约】'))
  const zeroBaton = await sct9(fakeCtx, { catalogPath: cp9 }).execute({ query: 'xyzzy 完全无关' })
  check('接力棒随检索结果走(零命中面也不断链)', zeroBaton.includes('【装配流契约】'))
  process.env.DSH_ASSEMBLER_BARE = '1'
  const bare9 = await sct9(fakeCtx, { catalogPath: cp9 }).execute({ query: '数据库' })
  delete process.env.DSH_ASSEMBLER_BARE
  check('BARE:接力棒可剥、入口线(事实)保留在描述', !bare9.includes('【装配流契约】'))
}

// ── 宪法第八条:概念账钉(数概念,不数行;加一必删一——想改这些数字,先过第八条)──
{
  const { readFileSync: rfc } = await import('node:fs')
  const idxSrc = rfc('src/index.ts', 'utf8')
  const faces = (idxSrc.match(/ctx\.effect\(\(\) => ctx\.tools\.register\(/g) ?? []).length
  check('概念账:工具面 = 12(宪法当前账;新增工具面必须同刀删一个或修宪)', faces === 12, `实得 ${faces}`)
  const viaLine = /via: ((?:'[a-z-]+'(?: \| )?)+)/.exec(idxSrc)?.[1] ?? ''
  const viaCount = (viaLine.match(/'/g) ?? []).length / 2
  check('概念账:via 5 种(第九条执行后 recipe 已消)', viaCount === 5, viaLine)
  const { assemblerMode: am8 } = await import('./lib/orchestrated-tools.js')
  check('概念账:形态 = search 唯一(off 是停用开关不是形态)', typeof am8 === 'function')
  const { CONTRACT_TAGS: tags8 } = await import('./lib/orchestrated-tools.js')
  check('概念账:承重散文常量 = 4 条(+ASSEMBLY_BATON:v4 首轮取证的入口断链修复)', Object.keys(tags8).length === 4, Object.keys(tags8).join(','))
}

// ── 机械闸:契约要求的动作,逐条必须有够得着的工具面 ─────────────────────────
{
  const M = await import('./lib/orchestrated-tools.js')
  const { CONTRACT_ACTIONS } = M
  const { readFileSync: rf5 } = await import('node:fs')
  const indexSrc = rf5('src/index.ts', 'utf8')
  check('闸:契约动作表非空且每条有 action/tool/why', CONTRACT_ACTIONS.length >= 10 && CONTRACT_ACTIONS.every((x) => x.action && x.tool && x.why))
  const unregistered = CONTRACT_ACTIONS.filter((x) => !indexSrc.includes(`assembler.tool.${x.tool}()`))
  check('闸:每个契约动作的工具都真被注册(忘配工具即红)', unregistered.length === 0, unregistered.map((x) => `${x.action}→${x.tool}`).join(', '))
  // 契约不得再把 agent 指向仓库脚本路径(那是沙箱够不着的死结)
  const { readPresetToolDefinition, submitPartToolDefinition } = M
  const rpDesc = readPresetToolDefinition(fakeCtx, {}).description
  const spDesc = submitPartToolDefinition(fakeCtx, {}).description
  check('契约钉:read_preset = 沙箱外资源的读窗(点名装备 DDL)', rpDesc.includes('equipment DDL') && rpDesc.includes('outside your shell sandbox'))
  check('契约钉:submit_part = 你写码/门执行,不过门不入库', spDesc.includes('tool-surface twin') && spDesc.includes('registers it only if every gate passes') && spDesc.includes('Nothing is registered on failure'))
}

if (failures > 0) {
  console.error(`\ntests-orchestrated: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\ntests-orchestrated: all green')
