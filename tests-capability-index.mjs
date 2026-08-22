#!/usr/bin/env node
/**
 * 能力目录粗筛单测:分词 + set-level 召回 + 保底类。用真实目录验召回不掉链子
 * (粗筛是加速器不是过滤器——该有的能力必须进候选,否则选型报假缺口)。
 * 跑法:node tests-capability-index.mjs(先 npm run build)
 */
import { tokenize, shortlistCapabilities } from './lib/capability-index.js'
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

// 2. 打分召回:构造小目录,验 tag 命中优先
const mkMcp = (id, tags, desc) => ({ id, via: 'mcp', tags, description: desc, config: { server: id.replace('mcp-', '') } })
const mkHarness = (id, tags) => ({ id, via: 'harness', tags, description: '', config: {} })
const small = [
  mkMcp('mcp-sqlite-query-execute', ['sqlite', 'database', '数据库', '持久化'], 'run SQL on a local SQLite database'),
  mkMcp('mcp-pdf-extract-get-text', ['pdf', 'extract', '文档', '解析'], 'extract text from a PDF file'),
  mkMcp('mcp-email-send', ['email', 'smtp', '邮件', '发送'], 'send an email over SMTP'),
  mkMcp('mcp-weather-forecast', ['weather', '天气', '预报'], 'weather forecast'),
  mkHarness('web-lookup', ['web', 'search', '搜索']),
]
// 记账需求 → 必须召回 sqlite;不该因为噪音丢掉
const sl1 = shortlistCapabilities(small, ['持久化存储账目 persist bookkeeping records', '数据库查询'], { maxMcp: 3 })
check('记账需求召回 sqlite', sl1.ids.has('mcp-sqlite-query-execute'), [...sl1.ids].join(','))
check('非 mcp(harness)全保留', sl1.ids.has('web-lookup'))
// 读书需求 → 召回 pdf
const sl2 = shortlistCapabilities(small, ['解析上传的 PDF 文档 parse uploaded documents'], { maxMcp: 2 })
check('读书需求召回 pdf', sl2.ids.has('mcp-pdf-extract-get-text'))
// 邮件需求 → 召回 email
const sl3 = shortlistCapabilities(small, ['发送提醒邮件 send reminder email'], { maxMcp: 2 })
check('邮件需求召回 email', sl3.ids.has('mcp-email-send'))

// 3. set-level:多需求各自的最佳候选都要在(不被全局分挤掉)
const slMulti = shortlistCapabilities(small, ['持久化账目', '解析 PDF 文档', '发送邮件'], { perQueryTopM: 1, maxMcp: 3 })
check('set-level:三需求的候选都在', slMulti.ids.has('mcp-sqlite-query-execute') && slMulti.ids.has('mcp-pdf-extract-get-text') && slMulti.ids.has('mcp-email-send'), [...slMulti.ids].join(','))

// 4. 模拟联邦后的大目录(静态 mcp-servers 只在联邦时才变 capability,单测不联邦,
//    故手工注入一批模拟 mcp + 静态非 mcp)——验 HR 需求在噪音中精准召回、且压缩。
const cat = loadCatalog(join(process.cwd(), 'capabilities.yml'))
const staticNonMcp = cat.capabilities.filter((c) => c.config?.enabled !== false && c.via !== 'mcp')
const mcpSim = [
  mkMcp('mcp-sqlite-query-execute', ['sqlite', 'database', '数据库', '持久化', '账本'], 'run SQL on SQLite'),
  mkMcp('mcp-sqlite-query-query', ['sqlite', 'query', '查询', '数据库'], 'query SQLite'),
  mkMcp('mcp-pdf-report-create', ['pdf', 'report', '报表', '工资条', '导出'], 'create a PDF report'),
  mkMcp('mcp-pdf-extract-text', ['pdf', 'extract', '文档', '解析'], 'extract PDF text'),
  mkMcp('mcp-excel-write', ['excel', 'xlsx', '表格', '导出'], 'write xlsx'),
  mkMcp('mcp-docx-generate', ['docx', 'word', '文档', '生成'], 'generate docx'),
  mkMcp('mcp-email-send', ['email', 'smtp', '邮件', '发送', '通知'], 'send email'),
  mkMcp('mcp-http-request', ['http', 'api', '接口', '请求'], 'http request'),
  mkMcp('mcp-csv-parse', ['csv', '解析', '数据'], 'parse csv'),
  mkMcp('mcp-date-format', ['date', '日期', '时间', '格式'], 'format date'),
  mkMcp('mcp-weather-forecast', ['weather', '天气', '预报'], 'weather'),
  mkMcp('mcp-qrcode-generate', ['qrcode', '二维码', '生成'], 'qr code'),
  mkMcp('mcp-ocr-parse', ['ocr', '识别', '图片'], 'ocr'),
  mkMcp('mcp-currency-calc', ['currency', '货币', '汇率', '计算'], 'currency calc'),
  mkMcp('mcp-image-process', ['image', '图片', '处理'], 'image process'),
]
const federated = [...staticNonMcp, ...mcpSim]
check('模拟联邦目录足够大(值得粗筛)', federated.length > 20, String(federated.length))
const realSl = shortlistCapabilities(federated, ['员工考勤打卡统计持久化', '月度工资条生成导出 PDF 工资条', '员工问答查公司制度带出处'], { maxMcp: 8 })
check('HR 需求召回 sqlite 类', [...realSl.ids].some((id) => id.includes('sqlite')), [...realSl.ids].filter((id) => id.includes('sqlite')).join(','))
check('HR 需求召回 pdf 类', [...realSl.ids].some((id) => id.includes('pdf')))
check('HR 需求没被噪音淹没(天气/二维码不该进 top)', !realSl.ids.has('mcp-weather-forecast') || !realSl.ids.has('mcp-qrcode-generate'))
check('粗筛确实压缩了(候选 < 全量)', realSl.ids.size < federated.length, `${realSl.ids.size} / ${federated.length}`)
check('粗筛保留了非 mcp 架构类(frontend/persona)', [...realSl.ids].some((id) => id.includes('frontend') || id.includes('persona')))

console.log(`\n==== 能力目录单元测试: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`)
process.exit(failures === 0 ? 0 : 1)
