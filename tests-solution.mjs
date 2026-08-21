#!/usr/bin/env node
/**
 * 方案包(多 agent 交付)单测:writeHandover 从工件汇总 + renderSolutionResult
 * 的调用方契约。跑法:node tests-solution.mjs(先 npm run build)
 */
import { writeHandover } from './lib/solution.js'
import { renderSolutionResult } from './lib/solution-tool.js'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

// 造两个 preset 的 parts.lock.yml + equipment/init.sql,验 HANDOVER 汇总。
const root = mkdtempSync(join(tmpdir(), 'sol-test-'))
const mkAgent = (id, lock, ddl) => {
  mkdirSync(join(root, id), { recursive: true })
  writeFileSync(join(root, id, 'parts.lock.yml'), yaml.dump(lock, { lineWidth: -1 }))
  if (ddl) { mkdirSync(join(root, id, 'equipment'), { recursive: true }); writeFileSync(join(root, id, 'equipment', 'init.sql'), ddl) }
}
mkAgent('cs-agent', {
  preset: 'cs-agent', emitter: 6, parts: [
    { capability: 'crm_query', via: 'package' },
    { capability: 'mcp-sqlite-query-query', via: 'mcp', server: 'sqlite-query', repo: 'first-party', license: 'MIT' },
  ],
  requiredSecrets: [{ env: 'CRM_TOKEN', purpose: 'CRM 访问', configured: false }],
  knowledge: [{ id: 'refund-policy', docs: 3, source: '客户导出', version: '2026-08' }],
}, 'CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY);\nCREATE TABLE IF NOT EXISTS tickets (id INTEGER);')
mkAgent('recon-agent', {
  preset: 'recon-agent', emitter: 6, parts: [
    { capability: 'mcp-sqlite-query-query', via: 'mcp', server: 'sqlite-query', repo: 'first-party', license: 'MIT' },
    { capability: 'mcp-csv-parse-parse', via: 'mcp', server: 'csv-parse', repo: 'mholt/papaparse', rev: 'v5.4.1', license: 'MIT' },
  ],
}, 'CREATE TABLE IF NOT EXISTS reconciliations (id INTEGER);\nCREATE TABLE IF NOT EXISTS orders (id INTEGER);')

const results = [
  { id: 'cs-agent', requirement: '客服:查订单开工单转人工', verdict: 'PASS', parts: 2, gaps: 0, seconds: 30, frontendUrl: 'http://127.0.0.1:3097/assembler/ui/cs-agent' },
  { id: 'recon-agent', requirement: '对账:平台订单与银行流水对账出差异', verdict: 'PASS', parts: 2, gaps: 1, seconds: 40 },
]
const solDir = join(root, '_sol')
mkdirSync(solDir, { recursive: true })
// 共享表由 solution 层传入(不再从各 agent 的 init.sql 反推)——这是 G1 修复:
// 方案级共享库,products/orders 是全班子共用的表。
const hp = writeHandover(solDir, { name: 'ecommerce-suite', client: '示例电商', params: { timezone: 'Asia/Shanghai' } }, results, root, ['products', 'orders'])
const md = readFileSync(hp, 'utf8')

check('HANDOVER 列出两个 agent 及验收', md.includes('cs-agent') && md.includes('recon-agent') && (md.match(/PASS/g) ?? []).length >= 2, md.slice(0, 200))
check('每个 agent 的职责有据', md.includes('查订单开工单转人工') && md.includes('对账'))
check('共享表来自方案层(products+orders)', md.includes('`products`') && md.includes('`orders`'), md.slice(md.indexOf('共享数据'), md.indexOf('共享数据') + 120))
check('待配置凭证汇总', md.includes('CRM_TOKEN') && md.includes('**待配置**'))
check('知识包随行', md.includes('refund-policy') && md.includes('2026-08'))
check('BOM 去重(sqlite-query 两 agent 共用只列一次)', (md.match(/sqlite-query/g) ?? []).length === 1, md)
check('BOM 出处含上游 rev', md.includes('mholt/papaparse@v5.4.1'))
check('部署参数列出', md.includes('timezone') && md.includes('Asia/Shanghai'))
check('缺件工单在 agent 表体现', md.includes('1 份'))

// renderSolutionResult 的调用方契约
const text = renderSolutionResult({
  name: 'ecommerce-suite', agents: results, handoverPath: hp, solutionPath: join(solDir, 'solution.yml'), ok: true, failed: [],
})
check('结果文本报 PASS 比例', text.includes('2/2 PASS'))
check('结果文本列前端 URL', text.includes('/assembler/ui/cs-agent'))
check('结果文本给行为契约', text.includes('行为契约') && text.includes('HANDOVER'))
check('结果文本指向交付文档', text.includes(hp))

// 失败态:契约必须含"不要自行改 preset"
const failText = renderSolutionResult({
  name: 'x', agents: [{ id: 'a', requirement: 'r', verdict: 'FAIL', verdictReason: '探针未过', parts: 1, gaps: 0, seconds: 10 }],
  handoverPath: hp, solutionPath: 'x', ok: false, failed: ['a'],
})
check('有 agent FAIL 时契约含"等用户定夺"', failText.includes('等用户定夺') && failText.includes('未通过'))

rmSync(root, { recursive: true, force: true })
console.log(`\n==== 方案包单元测试: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`)
process.exit(failures === 0 ? 0 : 1)
