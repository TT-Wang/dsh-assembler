#!/usr/bin/env node
/**
 * 检索单测:分词 + rankCapabilities(search_catalog 的后端)。用真实目录验召回
 * 不掉链子——该有的能力必须进榜,否则检索面报假缺口。
 * 跑法:node tests-capability-index.mjs(先 npm run build)
 * (曾另测两阶段选型的粗筛器 shortlistCapabilities——随 pipeline 形态删除,git 备查。)
 */
import { tokenize, rankCapabilities } from './lib/capability-index.js'
import { loadCatalog } from './lib/index.js'
import { join } from 'node:path'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

// 1. 分词:中英混合,中文 bigram,英文词,单字中文剔除
const t1 = tokenize('请假审批流 attendance tracking')
check('英文词进袋', t1.includes('attendance') && t1.includes('tracking'))
check('中文 2-gram 进袋', t1.includes('审批') && t1.includes('请假'))
check('单字中文不进袋(太泛)', !tokenize('单').length)

// 2. 排名:小目录上 tag 命中优先、topN 截断、确定性
const mkMcp = (id, tags, desc) => ({ id, via: 'mcp', tags, description: desc, config: { server: id.replace('mcp-', '') } })
const mkHarness = (id, tags) => ({ id, via: 'harness', tags, description: '', config: {} })
const small = [
  mkMcp('mcp-sqlite-query-execute', ['sqlite', 'database', '数据库', '持久化'], 'run SQL on a local SQLite database'),
  mkMcp('mcp-pdf-extract-get-text', ['pdf', 'extract', '文档', '解析'], 'extract text from a PDF file'),
  mkMcp('mcp-email-send', ['email', 'smtp', '邮件', '发送'], 'send an email over SMTP'),
  mkMcp('mcp-weather-forecast', ['weather', '天气', '预报'], 'weather forecast'),
  mkHarness('web-lookup', ['web', 'search', '搜索']),
]
const r1 = rankCapabilities(small, '持久化存储账目 数据库', 3)
check('记账需求 sqlite 排第一', r1.length > 0 && r1[0].entry.id === 'mcp-sqlite-query-execute', JSON.stringify(r1.map((h) => h.entry.id)))
const r2 = rankCapabilities(small, '解析上传的 PDF 文档', 3)
check('文档需求 pdf 排第一', r2.length > 0 && r2[0].entry.id === 'mcp-pdf-extract-get-text')
check('topN 截断生效', rankCapabilities(small, '数据库 文档 邮件 天气', 2).length <= 2)
check('确定性(两跑同序)', JSON.stringify(rankCapabilities(small, '数据库', 5)) === JSON.stringify(rankCapabilities(small, '数据库', 5)))
check('零命中返回空(不硬凑)', rankCapabilities(small, '完全无关的词汇 xyzzy', 5).length === 0)

// 3. 真实目录 + 模拟联邦:HR 三类需求逐条检索,该召回的召回、噪音不进前排
const cat = loadCatalog(join(process.cwd(), 'capabilities.yml'))
const staticNonMcp = cat.capabilities.filter((c) => c.config?.enabled !== false && c.via !== 'mcp')
const mcpSim = [
  mkMcp('mcp-sqlite-query-execute', ['sqlite', 'database', '数据库', '持久化', '账本'], 'run SQL on SQLite'),
  mkMcp('mcp-sqlite-query-query', ['sqlite', 'query', '查询', '数据库'], 'query SQLite'),
  mkMcp('mcp-pdf-report-create', ['pdf', 'report', '报表', '工资条', '导出'], 'create a PDF report'),
  mkMcp('mcp-pdf-extract-text', ['pdf', 'extract', '文档', '解析'], 'extract PDF text'),
  mkMcp('mcp-excel-write', ['excel', 'xlsx', '表格', '导出'], 'write xlsx'),
  mkMcp('mcp-email-send', ['email', 'smtp', '邮件', '发送', '通知'], 'send email'),
  mkMcp('mcp-weather-forecast', ['weather', '天气', '预报'], 'weather'),
  mkMcp('mcp-qrcode-generate', ['qrcode', '二维码', '生成'], 'qr code'),
]
const federated = [...staticNonMcp, ...mcpSim]
const top = (q, n = 8) => rankCapabilities(federated, q, n).map((h) => h.entry.id)
check('考勤持久化 → sqlite 进榜', top('员工考勤打卡统计持久化 数据库').some((id) => id.includes('sqlite')), top('员工考勤打卡统计持久化 数据库').join(','))
check('工资条导出 → pdf 报表进榜', top('月度工资条生成导出 PDF').some((id) => id.includes('pdf')))
check('噪音不进前排(考勤查询不含天气/二维码)', !top('员工考勤打卡统计持久化 数据库', 5).some((id) => id.includes('weather') || id.includes('qrcode')))

console.log(`\n==== 检索单元测试: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`)
process.exit(failures === 0 ? 0 : 1)
