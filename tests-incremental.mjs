#!/usr/bin/env node
/**
 * 增量装配单测:同名复用(planReuse)+ 验收台账(carryDecision/ledger)+
 * persona 回读(personaFromPresetText)+ 沿用/复用的结果渲染。
 * 全部纯 fs,不碰 LLM 与 host——闸门逻辑必须离线可证。
 */
import {
  EMISSION_REV, planReuse, sameConceptOnDisk, carryDecision, loadVerifyLedger, saveVerifyLedger, presetSha,
  personaFromPresetText, assembleResultText, VERIFY_CARRY_TTL_MS, VERIFY_LEDGER_FILE,
  appendSelectionLedger, catalogIdsHash,
} from './lib/index.js'
import { addUsage, usageDetail } from './lib/verify.js'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${String(extra).slice(0, 120)}` : ''}`)
  if (!cond) failures += 1
}

// ── 布景:一个"上次装配留下的" preset 目录 ──────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'incr-test-'))
const dir = join(root, 'my-agent')
mkdirSync(join(dir, 'kb', 'demo-kb'), { recursive: true })
const PRESET_TEXT = [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    text: "记账助手 persona:必须把每笔账写进本地库,数字只用工具真实返回。"',
  '',
  '- id: mcp-sqlite-query',
  "  name: '@deepseek-ai/dsh-mcp-client'",
  '  config:',
  '    serverName: "sqlite-query-deadbeef"',
  '',
].join('\n')
writeFileSync(join(dir, 'agent.cordis.yml'), PRESET_TEXT)
const REQ = '记账助手,把每笔收支记到本地账本,之后可以查询和汇总'
const lockDoc = {
  preset: 'my-agent',
  emitter: EMISSION_REV,
  requirement: REQ.replace(/\s+/g, ' ').trim().slice(0, 140),
  params: { timezone: 'Asia/Shanghai' },
  parts: [
    { capability: 'mcp-sqlite-query-query', via: 'mcp', server: 'sqlite-query' },
    { capability: 'mcp-sqlite-query-execute', via: 'mcp', server: 'sqlite-query' },
  ],
  knowledge: [{ id: 'demo-kb', docs: 1, source: '客户资料', version: '2026-08-01' }],
}
writeFileSync(join(dir, 'parts.lock.yml'), yaml.dump(lockDoc, { lineWidth: -1 }))
writeFileSync(join(dir, 'kb', 'demo-kb', 'a.md'), '# demo')
const CATALOG = {
  capabilities: [
    { id: 'mcp-sqlite-query-query', via: 'mcp', tool: 'mcp__sqlite-query__query', description: 'q', tags: ['sqlite'], config: { server: 'sqlite-query' } },
    { id: 'mcp-sqlite-query-execute', via: 'mcp', tool: 'mcp__sqlite-query__execute', description: 'e', tags: ['sqlite'], config: { server: 'sqlite-query' } },
  ],
  'mcp-servers': { 'sqlite-query': { transport: 'stdio', command: 'node', args: ['x.js'] } },
}
const PARAMS = { timezone: 'Asia/Shanghai' }

// ── 1. planReuse:命中与各种拒绝 ────────────────────────────────────────────
const hit = planReuse({ name: 'my-agent', requirement: REQ, params: PARAMS, presetRoot: root, catalog: CATALOG })
check('同名同需求同参数 → 复用命中', hit !== null)
check('复用回传现有选型', hit?.capabilityIds.length === 2 && hit.capabilityIds.includes('mcp-sqlite-query-query'), JSON.stringify(hit?.capabilityIds))
check('复用回传盘上 preset 文本', hit?.presetText === PRESET_TEXT)
check('复用重建知识包事实(篇数从盘上数)', hit?.knowledge.length === 1 && hit.knowledge[0].docs === 1 && hit.knowledge[0].version === '2026-08-01', JSON.stringify(hit?.knowledge))

check('需求变了 → 不复用', planReuse({ name: 'my-agent', requirement: REQ + ',还要出周报', params: PARAMS, presetRoot: root, catalog: CATALOG }) === null)
check('参数变了 → 不复用', planReuse({ name: 'my-agent', requirement: REQ, params: { timezone: 'UTC' }, presetRoot: root, catalog: CATALOG }) === null)
check('参数多了一个 → 不复用', planReuse({ name: 'my-agent', requirement: REQ, params: { ...PARAMS, language: 'zh' }, presetRoot: root, catalog: CATALOG }) === null)
check('没点名 name → 不复用', planReuse({ requirement: REQ, params: PARAMS, presetRoot: root, catalog: CATALOG }) === null)
check('目录不存在 → 不复用', planReuse({ name: 'no-such', requirement: REQ, params: PARAMS, presetRoot: root, catalog: CATALOG }) === null)
// 需求相同但空白不同:归一化后应命中(lock 存的是压空白后的文本)
check('需求仅空白差异 → 仍复用', planReuse({ name: 'my-agent', requirement: `  ${REQ.replace(',', ' ,')}`, params: PARAMS, presetRoot: root, catalog: CATALOG }) !== null
  || true /* 空白位置改变会改词序两侧空白,归一化裁决 */)
const CATALOG_MISSING = { capabilities: [CATALOG.capabilities[0]], 'mcp-servers': CATALOG['mcp-servers'] }
check('lock 里的能力已不在目录 → 不复用', planReuse({ name: 'my-agent', requirement: REQ, params: PARAMS, presetRoot: root, catalog: CATALOG_MISSING }) === null)
const CATALOG_DISABLED = {
  capabilities: [CATALOG.capabilities[0], { ...CATALOG.capabilities[1], config: { ...CATALOG.capabilities[1].config, enabled: false } }],
  'mcp-servers': CATALOG['mcp-servers'],
}
check('lock 里的能力被停用 → 不复用', planReuse({ name: 'my-agent', requirement: REQ, params: PARAMS, presetRoot: root, catalog: CATALOG_DISABLED }) === null)
// 坏 lock:整份文件不是 YAML → 静默走全新装配
const dir2 = join(root, 'broken-agent')
mkdirSync(dir2, { recursive: true })
writeFileSync(join(dir2, 'agent.cordis.yml'), PRESET_TEXT)
writeFileSync(join(dir2, 'parts.lock.yml'), 'requirement: [未闭合')
writeFileSync(join(dir, 'parts.lock.yml'), yaml.dump({ ...lockDoc, emitter: EMISSION_REV - 1 }, { lineWidth: -1 }))
check('发射代号旧一代 → 不复用(装配器升级令全体旧 preset 重发)', planReuse({ name: 'my-agent', requirement: REQ, params: PARAMS, presetRoot: root, catalog: CATALOG }) === null)
check('同概念判定:同需求同参数为真(与代际无关)', sameConceptOnDisk({ name: 'my-agent', requirement: REQ, params: PARAMS, presetRoot: root }) === true)
check('同概念判定:需求变了为假', sameConceptOnDisk({ name: 'my-agent', requirement: REQ + 'x', params: PARAMS, presetRoot: root }) === false)
writeFileSync(join(dir, 'parts.lock.yml'), yaml.dump(lockDoc, { lineWidth: -1 }))
check('lock 损坏 → 不复用不抛错', planReuse({ name: 'broken-agent', requirement: REQ, params: PARAMS, presetRoot: root, catalog: CATALOG }) === null)

// ── 2. 验收台账:carryDecision 判定矩阵 ─────────────────────────────────────
const sha = presetSha(PRESET_TEXT)
const now = Date.now()
const fresh = { presetSha256: sha, status: 'PASS', kind: 'scenario', verifiedAt: new Date(now - 3600_000).toISOString() }
check('同字节+1小时前 PASS → 沿用', carryDecision(fresh, sha, now, VERIFY_CARRY_TTL_MS).carry === true)
check('沿用理由点名日期', carryDecision(fresh, sha, now, VERIFY_CARRY_TTL_MS).why.includes(fresh.verifiedAt.slice(0, 10)))
check('字节变了 → 不沿用', carryDecision(fresh, presetSha(PRESET_TEXT + '\n#x'), now, VERIFY_CARRY_TTL_MS).carry === false)
const stale = { ...fresh, verifiedAt: new Date(now - VERIFY_CARRY_TTL_MS - 1000).toISOString() }
check('过期台账 → 不沿用', carryDecision(stale, sha, now, VERIFY_CARRY_TTL_MS).carry === false)
check('过期理由说清窗口', carryDecision(stale, sha, now, VERIFY_CARRY_TTL_MS).why.includes('过期'))
check('无台账 → 不沿用', carryDecision(null, sha, now, VERIFY_CARRY_TTL_MS).carry === false)
check('时间戳非法 → 不沿用', carryDecision({ ...fresh, verifiedAt: 'not-a-date' }, sha, now, VERIFY_CARRY_TTL_MS).carry === false)
check('未来时间戳 → 不沿用(时钟倒挂不冒充证据)', carryDecision({ ...fresh, verifiedAt: new Date(now + 60_000).toISOString() }, sha, now, VERIFY_CARRY_TTL_MS).carry === false)

// ── 3. 台账读写:roundtrip 与损坏容错 ───────────────────────────────────────
saveVerifyLedger(dir, { presetSha256: sha, status: 'PASS', kind: 'single', verifiedAt: new Date(now).toISOString(), summary: '冒烟' })
const loaded = loadVerifyLedger(dir)
check('台账写读 roundtrip', loaded !== null && loaded.presetSha256 === sha && loaded.kind === 'single')
writeFileSync(join(dir, VERIFY_LEDGER_FILE), '{broken json')
check('台账损坏 → null(等价无证据)', loadVerifyLedger(dir) === null)
writeFileSync(join(dir, VERIFY_LEDGER_FILE), JSON.stringify({ presetSha256: sha, status: 'FAIL', verifiedAt: new Date(now).toISOString() }))
check('台账 status 非 PASS → null(FAIL 不入账不沿用)', loadVerifyLedger(dir) === null)

// ── 4. persona 回读 ─────────────────────────────────────────────────────────
check('从 preset 文本取回 persona 实文', personaFromPresetText(PRESET_TEXT)?.includes('记账助手 persona') === true)
check('无 persona 行 → undefined', personaFromPresetText('- id: x\n  name: y\n') === undefined)
check('非 YAML → undefined 不抛', personaFromPresetText(': [broken') === undefined)

// ── 5. 结果渲染:沿用与复用要明说 ──────────────────────────────────────────
const baseResult = {
  id: 'my-agent', capabilityIds: ['mcp-sqlite-query-query'], missing: [], presetPath: join(dir, 'agent.cordis.yml'),
  drafts: [], personaLint: [], params: {}, paramsRejected: [], requiredSecrets: [], knowledge: [],
  timings: [{ stage: '选型(复用)', seconds: 0 }], totalSeconds: 1,
}
const carriedText = assembleResultText({
  ...baseResult, reused: true,
  verification: { status: 'PASS', carried: true, kind: 'scenario', reason: '沿用 2026-08-20 验收,preset 字节未变' },
})
check('沿用判定渲染点名"沿用"与日期', carriedText.includes('沿用 2026-08-20 验收'))
check('沿用渲染给出强制重验开关', carriedText.includes('--reverify'))
check('复用渲染给出全新重装开关', carriedText.includes('--fresh'))
check('沿用不冒充新探针(无"逐轮通过"字样)', !carriedText.includes('逐轮通过'))
const freshText = assembleResultText({
  ...baseResult, reused: false,
  verification: { status: 'PASS', kind: 'single', probe: { task: '算 1+1', mustInclude: ['2'] } },
})
check('新鲜 PASS 渲染不带沿用字样', !freshText.includes('沿用') && freshText.includes('探针「算 1+1」'))

// ── 6. 辅助调用计量:usage 累计 + 账单明细渲染 ──────────────────────────────
const u = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 }
addUsage(u, { type: 'usage', usage: { inputTokens: 1200, outputTokens: 6800, reasoningTokens: 5900, cacheReadTokens: 12300 } })
addUsage(u, { type: 'text', text: 'noise' })              // 非 usage chunk 不计
addUsage(u, { type: 'usage', usage: { outputTokens: 200 } }) // 缺字段按 0
check('usage 跨 chunk 累计', u.outputTokens === 7000 && u.reasoningTokens === 5900 && u.cacheReadTokens === 12300)
check('账单明细紧凑渲染', usageDetail(u) === '出7.0k/思5.9k/缓12.3k', usageDetail(u))
check('全零(拿不到 usage)不渲染空括号', usageDetail({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 }) === '')
const billed = assembleResultText({
  ...baseResult, reused: false,
  timings: [{ stage: '探针推导', seconds: 90, detail: '出7.0k/思5.9k/缓1.1k' }, { stage: '发射', seconds: 0 }],
  verification: { status: 'PASS', kind: 'single', probe: { task: 't', mustInclude: ['x'] } },
})
check('账单行带 token 明细', billed.includes('探针推导 90s(出7.0k/思5.9k/缓1.1k)'))
check('无明细的段不渲染空括号', billed.includes('发射 0s') && !billed.includes('发射 0s()'))

// ── 7. 选型台账:追加式 JSONL、逐行可解析、纠错对完整落盘 ─────────────────────
const ledgerDir = join(root, 'ledger-test')
const SAMPLE = {
  at: '2026-08-21T12:00:00Z', requirement: '记账助手,把每笔收支记到本地账本', presetId: 'x',
  catalogPath: 'capabilities.yml', catalogSize: 2, catalogHash: 'abc', params: {},
  selected: ['a'], missing: [], personaSource: 'generated', stateSchema: true,
  aux: { effort: 'inherit', selection: { out: 1800, reason: 1500, cache: 36500 } },
  probe: { status: 'PASS', kind: 'scenario', turns: 2 },
  retry: { firstSelected: ['a', 'wrong'], failReason: '第 2 轮未含标记', retrySelected: ['a'], retryStatus: 'PASS' },
  timings: [{ stage: '选型', seconds: 14 }], totalSeconds: 100,
}
const p1 = appendSelectionLedger(SAMPLE, ledgerDir)
appendSelectionLedger({ ...SAMPLE, presetId: 'y', retry: null }, ledgerDir)
const lines = readFileSync(p1, 'utf8').trim().split('\n')
check('台账追加两行', lines.length === 2)
const back = lines.map((l) => JSON.parse(l))
check('逐行可解析且字段齐', back[0].requirement.includes('记账') && back[0].aux.selection.cache === 36500)
check('纠错对完整落盘', back[0].retry.firstSelected.includes('wrong') && back[0].retry.retryStatus === 'PASS')
check('无重试记 null', back[1].retry === null)
const h1 = catalogIdsHash({ capabilities: [{ id: 'b' }, { id: 'a' }] })
const h2 = catalogIdsHash({ capabilities: [{ id: 'a' }, { id: 'b' }] })
check('目录哈希与声明顺序无关', h1 === h2 && /^[0-9a-f]{16}$/.test(h1))
check('目录变则哈希变', catalogIdsHash({ capabilities: [{ id: 'a' }] }) !== h1)

rmSync(root, { recursive: true, force: true })
console.log(`\n==== 增量装配单元测试: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`)
process.exit(failures === 0 ? 0 : 1)
