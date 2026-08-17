/**
 * assembly-bench:装配质量基准。
 *
 * 40 条自然语言需求 → 每条走一遍完整 find → assemble → verify 闭环
 * (/assemble 命令,装配即验证默认开启),统计自动验证 PASS 率。
 * 通过标准:≥80%(32/40)。
 *
 * 跑法:
 *   1. 起一个挂了 assembler 的 web profile:dsh --profile web [--patch <port.yml>]
 *   2. node scripts/assembly-bench.mjs [port]     (默认 3096)
 *
 * 结果落盘 bench/results/<date>-assembly-bench.json(run-tagged 唯一名,
 * 附每题的判定行原文),供 git 收录复核。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.argv[2] ?? 3096)
const BASE = `http://127.0.0.1:${PORT}`
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 40 题:29 单件 + 11 组合;1-20 为初版基线题(保持不变以便跨目录规模对比),21-40 覆盖扩容批次。 */
const REQUIREMENTS = [
  // —— 单件 ——
  { slug: 'currency', req: '我要一个货币汇率换算助手,能解析金额、按汇率换算并格式化输出' },
  { slug: 'qrcode', req: '帮我装一个二维码生成器,把文字或链接变成二维码图片' },
  { slug: 'dates', req: '需要一个日期助手,能做日期加减、格式化和星期几计算' },
  { slug: 'numfmt', req: '数字格式化助手:千分位、百分比、四舍五入' },
  { slug: 'csv', req: '一个 CSV 数据助手,能解析 CSV 文本并按列筛选汇总' },
  { slug: 'mdrender', req: '把 Markdown 文本渲染成 HTML 的助手' },
  { slug: 'html2text', req: '把 HTML 页面源码转成干净纯文本的助手' },
  { slug: 'xml', req: 'XML 解析助手,能从 XML 文档里取出指定节点的值' },
  { slug: 'template', req: '模板渲染助手:把变量填进模板字符串生成最终文本' },
  { slug: 'fuzzy', req: '模糊搜索助手,在一组字符串里找出和输入最接近的项' },
  { slug: 'ics', req: '日历助手,能生成 ics 日历事件文件内容' },
  { slug: 'files', req: '文件助手,能在工作目录里读写和整理文本文件' },
  { slug: 'binfile', req: '能把 base64 内容落盘成二进制文件的助手' },
  { slug: 'zip', req: '压缩助手,把几个文件打包成 zip' },
  { slug: 'htmlparse', req: 'HTML 解析助手,用选择器从网页源码里抽取元素内容' },
  // —— 组合 ——
  { slug: 'cur-qr', req: '既能算汇率又能把结果生成二维码的助手' },
  { slug: 'csv-num', req: '读 CSV 数据、汇总后用千分位格式输出报表数字的助手' },
  { slug: 'date-ics', req: '先算出下周同一天的日期,再生成那天的 ics 日历事件' },
  { slug: 'md-file', req: '把 Markdown 渲染成 HTML 并保存到工作目录文件里' },
  { slug: 'tpl-qr', req: '用模板填充生成一段文字,再把这段文字做成二维码' },

  // —— 扩容批次覆盖(21-40):14 单件 + 6 组合 ——
  { slug: 'math', req: '数学计算助手,能安全求值表达式,也能做单位换算' },
  { slug: 'cron', req: 'cron 表达式助手,解析表达式并算出接下来几次执行时间' },
  { slug: 'phone', req: '电话号码助手,解析号码、判断有效性并格式化成国际格式' },
  { slug: 'semver', req: '版本号助手,比较两个版本大小、判断版本是否满足范围' },
  { slug: 'yaml', req: 'YAML 配置助手,YAML 和 JSON 互相转换' },
  { slug: 'pinyin', req: '拼音助手,把中文转成拼音,支持带声调和首字母' },
  { slug: 'fanjian', req: '简繁转换助手,简体转繁体、繁体转简体' },
  { slug: 'html2md', req: '把 HTML 网页源码转成 Markdown 的助手' },
  { slug: 'hash', req: '校验助手,能算文本的 sha256 指纹,也能生成 UUID' },
  { slug: 'jsonq', req: 'JSON 数据助手,用 JMESPath 表达式查询和投影 JSON' },
  { slug: 'faker', req: '测试数据助手,按字段说明批量生成假的人名邮箱等记录' },
  { slug: 'barcode', req: '条形码助手,把文本或编号生成 code128 条形码图片' },
  { slug: 'geo', req: '地理助手,算两个经纬度坐标之间的距离和方位' },
  { slug: 'jwt', req: 'JWT 助手,解码 token 看 header 和 payload,判断是否过期' },
  { slug: 'math-rmb', req: '账目助手:先算一个算式的结果,再把金额转成人民币大写' },
  { slug: 'fake-schema', req: '先生成几条测试用户数据,再用 JSON Schema 校验它们合规' },
  { slug: 'yaml-query', req: '把 YAML 配置转成 JSON,再用查询表达式取出指定字段的值' },
  { slug: 'docx-roundtrip', req: '生成一个 Word 文档,再把它的正文提取回纯文本' },
  { slug: 'slug-qr', req: '把一个中文标题转成 URL slug,再把 slug 生成二维码' },
  { slug: 'dns-ip', req: '解析一个域名的 IP,再判断这个 IP 是公网还是内网地址' },
]

const rpc = async (method, payload) => {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `bench-${Math.random().toString(36).slice(2)}`, method, payload }),
  })
  const j = await res.json()
  if (!j.result?.ok) throw new Error(`${method}: ${JSON.stringify(j.result?.error ?? j).slice(0, 600)}`)
  return j.result.value
}

/**
 * 一题:独立会话让 agent 调 assemble 工具(裸 wire 的 session.prompt 不走
 * slash 命令管线——那是 web 客户端的 token 认领;'/assemble' 文本会被当普通
 * 聊天),等 turn/end,从 tool/result 事件里抽"自动验证"判定行。
 */
async function runOne(item, index) {
  const cwd = mkdtempSync(join(tmpdir(), `bench-${item.slug}-`))
  const { sessionId } = await rpc('session.create', { cwd })
  const frames = []
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/events.mux`)
  ws.onmessage = (m) => {
    try {
      const f = JSON.parse(String(m.data))
      if (f.payload?.type === 'session/event' && f.payload.sessionId === sessionId) frames.push(f.payload.event)
    } catch {}
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')) })
  const name = `bench-${String(index + 1).padStart(2, '0')}-${item.slug}`
  await rpc('session.prompt', {
    sessionId, mode: 'queue',
    content: [{ type: 'text', text: `请调用 assemble 工具,requirement 为"${item.req}",name 参数用 "${name}"。工具返回后直接复述结果,不要做任何其他探索或额外工具调用。` }],
  })
  const t0 = Date.now()
  while (Date.now() - t0 < 8 * 60_000 && !frames.some((e) => e.type === 'turn/end')) {
    await new Promise((r) => setTimeout(r, 2000))
  }
  ws.close()
  const finished = frames.some((e) => e.type === 'turn/end')
  const toolText = frames
    .filter((e) => e.type === 'tool/result' || e.type === 'tool/end')
    .map((e) => JSON.stringify(e.data ?? {}))
    .find((s) => s.includes('自动验证')) ?? ''
  const verdict = toolText.includes('自动验证:PASS') ? 'PASS'
    : toolText.includes('自动验证:FAIL') ? 'FAIL'
      : toolText.includes('自动验证:跳过') ? 'SKIPPED'
        : finished ? 'UNKNOWN' : 'TIMEOUT'
  const line = (toolText.match(/自动验证[^\\"]*/) ?? [''])[0].slice(0, 300)
  console.log(`[${index + 1}/${REQUIREMENTS.length}] ${name}: ${verdict}  ${line.slice(0, 120)}`)
  return { name, requirement: item.req, verdict, verifyLine: line, wallSeconds: Math.round((Date.now() - t0) / 1000) }
}

const startedAt = new Date().toISOString()
const LANES = 3
const results = new Array(REQUIREMENTS.length)
let cursor = 0
const lane = async () => {
  while (cursor < REQUIREMENTS.length) {
    const i = cursor++
    try {
      results[i] = await runOne(REQUIREMENTS[i], i)
    } catch (error) {
      console.log(`[${i + 1}/${REQUIREMENTS.length}] ${REQUIREMENTS[i].slug}: ERROR ${error.message.slice(0, 200)}`)
      results[i] = { name: REQUIREMENTS[i].slug, requirement: REQUIREMENTS[i].req, verdict: 'ERROR', verifyLine: error.message.slice(0, 300), wallSeconds: 0 }
    }
  }
}
await Promise.all(Array.from({ length: LANES }, () => lane()))

const passes = results.filter((r) => r.verdict === 'PASS').length
const rate = Math.round((passes / REQUIREMENTS.length) * 100)
const summary = { startedAt, finishedAt: new Date().toISOString(), port: PORT, total: REQUIREMENTS.length, passes, rate, criterion: 'PASS ≥ 80%', met: rate >= 80, results }

const outDir = join(REPO, 'bench', 'results')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, `${startedAt.slice(0, 10)}-assembly-bench-${Date.now().toString(36)}.json`)
writeFileSync(outPath, JSON.stringify(summary, null, 2))
console.log(`\n==== assembly-bench: ${passes}/${REQUIREMENTS.length} PASS (${rate}%) — 标准 ≥80% ${rate >= 80 ? '达标 ✅' : '未达标 ❌'} ====`)
console.log(`结果已落盘:${outPath}`)
process.exit(rate >= 80 ? 0 : 1)
