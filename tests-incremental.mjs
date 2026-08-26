#!/usr/bin/env node
/**
 * 增量验收单测:验收台账(carryDecision/ledger)+ 同概念判定(sameConceptOnDisk)
 * + persona 回读(personaFromPresetText)+ 辅助调用计量 + 目录指纹。
 * 全部纯 fs,不碰 LLM 与 host——闸门逻辑必须离线可证。
 * (曾另测同名复用 planReuse 与选型台账/一条龙结果渲染——随 pipeline 形态删除,git 备查。)
 */
import {
  EMISSION_REV, sameConceptOnDisk, carryDecision, loadVerifyLedger, saveVerifyLedger, presetSha,
  personaFromPresetText, VERIFY_CARRY_TTL_MS, VERIFY_LEDGER_FILE, catalogIdsHash,
} from './lib/index.js'
import { addUsage, usageDetail } from './lib/verify.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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
const PARAMS = { timezone: 'Asia/Shanghai' }

// ── 1. 同概念判定(emit_preset 同名占用裁决的判据)──────────────────────────
check('同概念判定:同需求同参数为真(与代际无关)', sameConceptOnDisk({ name: 'my-agent', requirement: REQ, params: PARAMS, presetRoot: root }) === true)
check('同概念判定:需求变了为假', sameConceptOnDisk({ name: 'my-agent', requirement: REQ + 'x', params: PARAMS, presetRoot: root }) === false)
check('同概念判定:参数变了为假', sameConceptOnDisk({ name: 'my-agent', requirement: REQ, params: { timezone: 'UTC' }, presetRoot: root }) === false)
check('同概念判定:目录不存在为假', sameConceptOnDisk({ name: 'no-such', requirement: REQ, params: PARAMS, presetRoot: root }) === false)
check('同概念判定:没点名 name 为假', sameConceptOnDisk({ requirement: REQ, params: PARAMS, presetRoot: root }) === false)
const dir2 = join(root, 'broken-agent')
mkdirSync(dir2, { recursive: true })
writeFileSync(join(dir2, 'agent.cordis.yml'), PRESET_TEXT)
writeFileSync(join(dir2, 'parts.lock.yml'), 'requirement: [未闭合')
check('同概念判定:lock 损坏为假不抛错', sameConceptOnDisk({ name: 'broken-agent', requirement: REQ, params: PARAMS, presetRoot: root }) === false)

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

// ── 5. 辅助调用计量:usage 累计 + 明细渲染 ──────────────────────────────────
const u = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 }
addUsage(u, { type: 'usage', usage: { inputTokens: 1200, outputTokens: 6800, reasoningTokens: 5900, cacheReadTokens: 12300 } })
addUsage(u, { type: 'text', text: 'noise' })              // 非 usage chunk 不计
addUsage(u, { type: 'usage', usage: { outputTokens: 200 } }) // 缺字段按 0
check('usage 跨 chunk 累计', u.outputTokens === 7000 && u.reasoningTokens === 5900 && u.cacheReadTokens === 12300)
check('账单明细紧凑渲染', usageDetail(u) === '出7.0k/思5.9k/缓12.3k', usageDetail(u))
check('全零(拿不到 usage)不渲染空括号', usageDetail({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 }) === '')

// ── 6. 目录指纹 ─────────────────────────────────────────────────────────────
const h1 = catalogIdsHash({ capabilities: [{ id: 'b' }, { id: 'a' }] })
const h2 = catalogIdsHash({ capabilities: [{ id: 'a' }, { id: 'b' }] })
check('目录哈希与声明顺序无关', h1 === h2 && /^[0-9a-f]{16}$/.test(h1))
check('目录变则哈希变', catalogIdsHash({ capabilities: [{ id: 'a' }] }) !== h1)

rmSync(root, { recursive: true, force: true })
console.log(`\n==== 增量验收单元测试: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`)
process.exit(failures === 0 ? 0 : 1)
