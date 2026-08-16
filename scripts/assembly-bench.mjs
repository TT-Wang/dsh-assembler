/**
 * assembly-bench:装配质量基准。
 *
 * 20 条自然语言需求 → 每条走一遍完整 find → assemble → verify 闭环
 * (/assemble 命令,装配即验证默认开启),统计自动验证 PASS 率。
 * 通过标准:≥80%(16/20)。
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

/** 20 题:15 单件 + 5 组合;全部可用目录内零件在一轮内自包含完成。 */
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

/** 一题:独立会话发 /assemble 命令,等 command/done,抽出结果文本。 */
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
    content: [{ type: 'text', text: `/assemble ${item.req} --name ${name}` }],
  })
  const t0 = Date.now()
  let done
  while (Date.now() - t0 < 10 * 60_000) {
    done = frames.find((e) => e.type === 'command/done')
    if (done !== undefined) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  ws.close()
  const text = JSON.stringify(done?.data ?? {})
  const verdict = text.includes('自动验证:PASS') ? 'PASS'
    : text.includes('自动验证:FAIL') ? 'FAIL'
      : text.includes('自动验证:跳过') ? 'SKIPPED'
        : done === undefined ? 'TIMEOUT' : 'UNKNOWN'
  const line = (text.match(/自动验证[^\\"]*/) ?? [''])[0].slice(0, 300)
  console.log(`[${index + 1}/20] ${name}: ${verdict}  ${line.slice(0, 120)}`)
  return { name, requirement: item.req, verdict, verifyLine: line, wallSeconds: Math.round((Date.now() - t0) / 1000) }
}

const startedAt = new Date().toISOString()
const results = []
for (let i = 0; i < REQUIREMENTS.length; i++) {
  try {
    results.push(await runOne(REQUIREMENTS[i], i))
  } catch (error) {
    console.log(`[${i + 1}/20] ${REQUIREMENTS[i].slug}: ERROR ${error.message.slice(0, 200)}`)
    results.push({ name: REQUIREMENTS[i].slug, requirement: REQUIREMENTS[i].req, verdict: 'ERROR', verifyLine: error.message.slice(0, 300), wallSeconds: 0 })
  }
}

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
