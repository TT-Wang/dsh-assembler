// express-track:快递物流查询(快递鸟即时查询薄壳)。
//
// 采购判据(docs/research/sourcing-express-stocks.md,2026-08-27 侦察):合法快递
// 查询不存在零凭证上游;唯一可持续免费层是快递鸟(500 单/天,个人可注册)。
// npm 采件全被凭证/费用卡脖子(17track 免费层 2026-01 改一次性;快递100 企业向),
// 转的库全部陈化——签名就十几行,故走"造"。
//
// 凭证契约(speech-io ASR 同款先例):没配凭证也起得来、listTools 正常、调用回
// **可行动错误**(点名两个 env + 注册地址)。真单号模型面 smoke 在用户注册快递鸟
// 后扣扳机(见 smoke.mjs 的 creds 腿)。
//
// 协议(快递鸟官方文档口径,真凭证 smoke 前按"待实弹核验"对待):
//   POST https://api.kdniao.com/Ebusiness/EbusinessOrderHandle.aspx
//   x-www-form-urlencoded:RequestData(urlencode 的 JSON)/ EBusinessID /
//   RequestType(1002 即时查询;2002 单号识别)/ DataSign / DataType=2
//   DataSign = urlencode(base64(md5hex(RequestData明文 + ApiKey)))
import { createHash } from 'node:crypto'
import { readFileSync as __secRead } from 'node:fs'
import { join as __secJoin } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// 全库纪律(host 会擦凭证形状 env,直读 process.env 在运行时永远拿不到值):
// 零件自己从凭证库读,查找顺序:进程环境 → $DSH_HOME/.env → ~/.dsh/.env。
// 值不进 preset、不进环境、不进日志。
function readSecret(name) {
  const direct = process.env[name]
  if (typeof direct === 'string' && direct !== '') return direct
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const files = [
    process.env.DSH_HOME ? __secJoin(process.env.DSH_HOME, '.env') : null,
    home ? __secJoin(home, '.dsh', '.env') : null,
  ].filter(Boolean)
  for (const f of files) {
    try {
      for (const line of __secRead(f, 'utf8').split('\n')) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
        if (m !== null && m[1] === name && !line.trimStart().startsWith('#')) {
          return m[2].trim().replace(/^["']|["']$/g, '')
        }
      }
    } catch { /* 无凭证库文件,继续下一处 */ }
  }
  return ''
}

const API = process.env.KDNIAO_API_URL ?? 'https://api.kdniao.com/Ebusiness/EbusinessOrderHandle.aspx'
const REG_URL = 'https://www.kdniao.com(注册→实名→订"免费套餐"即得 EBusinessID 与 ApiKey,免费 500 单/天)'

/** 快递鸟签名:md5 小写 hex → 整串 base64。导出给 smoke 做离线向量断言。 */
export function kdniaoSign(requestData, apiKey) {
  const md5hex = createHash('md5').update(requestData + apiKey, 'utf8').digest('hex')
  return Buffer.from(md5hex, 'utf8').toString('base64')
}

function creds() {
  const id = readSecret('KDNIAO_EBUSINESS_ID')
  const key = readSecret('KDNIAO_API_KEY')
  if (id === '' || key === '') {
    throw new Error(
      `快递鸟凭证未配置:需要环境变量 KDNIAO_EBUSINESS_ID 与 KDNIAO_API_KEY(当前缺:${[id === '' ? 'KDNIAO_EBUSINESS_ID' : null, key === '' ? 'KDNIAO_API_KEY' : null].filter(Boolean).join('、')})。`
      + `注册:${REG_URL}。凭证配到 host 环境变量,绝不进装配参数。`,
    )
  }
  return { id, key }
}

async function kdniaoCall(requestType, payload) {
  const { id, key } = creds()
  const requestData = JSON.stringify(payload)
  const form = new URLSearchParams({
    RequestData: requestData,
    EBusinessID: id,
    RequestType: requestType,
    DataSign: kdniaoSign(requestData, key),
    DataType: '2',
  })
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: form.toString(),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await r.text()
  let j
  try { j = JSON.parse(text) } catch {
    throw new Error(`快递鸟返回非 JSON(HTTP ${r.status}):${text.slice(0, 200)}——接口形态变了或被网关拦截`)
  }
  return j
}

// 常见承运商编码表(快递鸟编码;查询时 ShipperCode 必填)
const CARRIERS = {
  SF: '顺丰', YTO: '圆通', ZTO: '中通', STO: '申通', YD: '韵达', JTSD: '极兔',
  EMS: 'EMS', YZPY: '邮政快递包裹', JD: '京东物流', DBL: '德邦', HTKY: '百世/汇通',
}

const server = new McpServer({ name: 'express-track', version: '0.0.1' })

server.registerTool('query-express', {
  description: '查快递轨迹(快递鸟即时查询,2700+ 承运商)。需 carrier(承运商编码,如 SF/YTO/ZTO/STO/YD/JTSD/EMS/JD)+ trackingNo;顺丰需收/寄件人手机后四位(phone)。返回按时间排序的轨迹节点。',
  inputSchema: {
    carrier: z.string().describe('承运商编码(快递鸟编码,如 SF、YTO、ZTO;不知道就先调 detect-carrier)'),
    trackingNo: z.string().describe('运单号'),
    phone: z.string().optional().describe('顺丰必填:收/寄件人手机后四位'),
  },
}, async ({ carrier, trackingNo, phone }) => {
  const code = String(carrier).toUpperCase().trim()
  const payload = {
    ShipperCode: code,
    LogisticCode: String(trackingNo).trim(),
    ...(code === 'SF' && phone !== undefined ? { CustomerName: String(phone).slice(-4) } : {}),
  }
  if (code === 'SF' && phone === undefined) {
    return { content: [{ type: 'text', text: '顺丰查询必须带 phone(收/寄件人手机后四位)——快递鸟对 SF 强制校验,不带必拒。' }], isError: true }
  }
  const j = await kdniaoCall('1002', payload)
  if (j.Success !== true) {
    return { content: [{ type: 'text', text: `查询未成功:${String(j.Reason ?? '无原因')}(State=${String(j.State ?? '?')})——单号/编码对不上,或免费套餐未订/超量(免费 500 单/天,次日恢复)` }], isError: true }
  }
  const traces = Array.isArray(j.Traces) ? j.Traces : []
  const lines = traces.map((t) => `${String(t.AcceptTime ?? '')} ${String(t.AcceptStation ?? '')}`)
  const stateMap = { 0: '暂无轨迹', 1: '已揽收', 2: '在途中', 3: '已签收', 4: '问题件' }
  return {
    content: [{
      type: 'text',
      text: `${CARRIERS[code] ?? code} ${payload.LogisticCode}:${stateMap[Number(j.State)] ?? `状态 ${String(j.State)}`}\n${lines.join('\n') || '(暂无轨迹节点)'}`,
    }],
  }
})

server.registerTool('detect-carrier', {
  description: '按运单号识别承运商(快递鸟单号识别)。返回候选承运商编码列表,供 query-express 的 carrier 用。注:识别接口是否在免费套餐内以真凭证实测为准(采购侦察未能核实)。',
  inputSchema: { trackingNo: z.string().describe('运单号') },
}, async ({ trackingNo }) => {
  const j = await kdniaoCall('2002', { LogisticCode: String(trackingNo).trim() })
  const shippers = Array.isArray(j.Shippers) ? j.Shippers : []
  if (j.Success !== true || shippers.length === 0) {
    return { content: [{ type: 'text', text: `识别未成功:${String(j.Reason ?? '无候选')}——让用户直接给承运商编码(常见:${Object.entries(CARRIERS).map(([k, v]) => `${k}=${v}`).join(' ')})` }], isError: true }
  }
  return { content: [{ type: 'text', text: `候选承运商:${shippers.map((x) => `${String(x.ShipperCode)}(${String(x.ShipperName ?? '')})`).join('、')}` }] }
})

// 直接执行时才起服(smoke 以模块方式 import kdniaoSign 做离线向量,不起服)
if (import.meta.url === `file://${process.argv[1]}`) {
  await server.connect(new StdioServerTransport())
}
