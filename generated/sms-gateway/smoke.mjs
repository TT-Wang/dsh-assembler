#!/usr/bin/env node
/**
 * 冒烟:@dsh-index/sms-gateway
 *
 * 真实调用覆盖(不是"能启动"):
 *   1. listTools ≥ 3 且含三个工具名
 *   2. sms-send provider=mock      → 真实返回 messageId/status(不发网络)
 *   3. sms-send provider=generic   → 真实 HTTP 往返:零件 POST 到本冒烟起的
 *                                    本地网关服务器,断言服务器收到 {to, content}
 *   4. sms-send provider=auto      → 只配了通用网关时 auto 自动选中 generic
 *   5. sms-send provider=aliyun    → 零凭证降级:isError 且点名缺的变量
 *   6. sms-send provider=tencent   → 零凭证降级:isError 且点名缺的变量
 *   7. sms-send 缺必填 to          → 参数校验错误路径
 *   8. sms-send 未知 provider      → 明确报错
 *   9. sms-delivery-status mock    → 模拟回执(发送成功)
 *  10. sms-delivery-status auto    → 通用网关不支持回执,给出可行动错误
 *  11. sms-provider-info           → 掩码展示各网关配置状态
 *
 * 凭证纪律:传给零件的 env 显式清掉所有 SMS_* 变量(只留 SMS_GENERIC_ENDPOINT),
 * 保证零凭证路径是真的零凭证,不被宿主环境偶然污染。
 */
import http from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// ── 本地"通用网关"测试服务器:记录收到的 POST,回一个带 MessageId 的 JSON ──
const received = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    received.push({ url: req.url, body })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ MessageId: `gw-${received.length}`, Status: 'OK', echo: body }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const endpoint = `http://127.0.0.1:${server.address().port}/sms`

// ── 零件子进程 env:清掉一切 SMS_* 凭据,只注入本地网关端点 ────────────────
const PART_ENV = { ...process.env }
for (const k of Object.keys(PART_ENV)) if (k.startsWith('SMS_')) delete PART_ENV[k]
PART_ENV.SMS_GENERIC_ENDPOINT = endpoint
// 网络零件冒烟:必须把代理环境显式传给零件子进程(MCP SDK 的 stdio transport
// 默认只透传白名单 env,HTTPS_PROXY / NODE_USE_ENV_PROXY 都不在其中)。
if ((PART_ENV.HTTPS_PROXY || PART_ENV.https_proxy || PART_ENV.HTTP_PROXY || PART_ENV.http_proxy) && PART_ENV.NODE_USE_ENV_PROXY === undefined) {
  PART_ENV.NODE_USE_ENV_PROXY = '1'
}

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!cond) failures += 1
}
const text = (r) => (r.content ?? []).map((b) => b.text ?? '').join('')
const json = (r) => { try { return JSON.parse(text(r)) } catch { return null } }

const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname], env: PART_ENV })
const client = new Client({ name: 'sms-gateway-smoke', version: '0.0.1' })
await client.connect(transport)

const call = async (name, args) => {
  try {
    return await client.callTool({ name, arguments: args })
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `callTool 抛出:${e?.message ?? String(e)}` }] }
  }
}

// 1) listTools
const { tools } = await client.listTools()
const names = tools.map((t) => t.name)
console.log(`TOOLS (${tools.length}): ${names.join(', ')}`)
check('listTools ≥ 3 个工具', tools.length >= 3, `实际 ${tools.length}`)
check('含 sms-send', names.includes('sms-send'))
check('含 sms-delivery-status', names.includes('sms-delivery-status'))
check('含 sms-provider-info', names.includes('sms-provider-info'))
console.log('---')

// 2) mock 发送(真实返回 messageId/status,不发网络)
const r2 = await call('sms-send', { to: '13800138000', content: '测试 TOKEN-MOCK-1', provider: 'mock' })
const j2 = json(r2)
check('sms-send mock 返回 ok:true', j2?.ok === true, text(r2).slice(0, 120))
check('mock messageId 形如 mock-*', typeof j2?.messageId === 'string' && j2.messageId.startsWith('mock-'), String(j2?.messageId))
check('mock status=delivered', j2?.status === 'delivered')
console.log('---')

// 3) generic 发送:真实 HTTP 往返到本地网关
const r3 = await call('sms-send', { to: '13800138000', content: '测试 TOKEN-GW-2', provider: 'generic' })
const j3 = json(r3)
check('sms-send generic 返回 ok:true', j3?.ok === true, text(r3).slice(0, 120))
check('generic messageId 来自网关回执 gw-1', j3?.messageId === 'gw-1', String(j3?.messageId))
check('本地网关确实收到 POST 且载荷正确', received.length >= 1, `收到 ${received.length} 次`)
const sent = received[0] ? JSON.parse(received[0].body) : null
check('网关收到的 to/content 与调用一致', sent?.to === '13800138000' && sent?.content === '测试 TOKEN-GW-2', JSON.stringify(sent))
console.log('---')

// 4) auto:只配了通用网关 → 自动选中 generic
const r4 = await call('sms-send', { to: '13800138000', content: '测试 TOKEN-AUTO-3' })
const j4 = json(r4)
check('auto 在只有通用网关时自动走 generic', j4?.ok === true && j4?.gateway === 'generic' && j4?.messageId === 'gw-2', text(r4).slice(0, 120))
console.log('---')

// 5) aliyun 零凭证降级:isError 且点名缺的变量
const r5 = await call('sms-send', { to: '13800138000', content: 'x', provider: 'aliyun' })
check('sms-send aliyun 无凭证 → isError', r5.isError === true)
check('aliyun 错误点名 SMS_ALIYUN_ACCESS_KEY_ID', text(r5).includes('SMS_ALIYUN_ACCESS_KEY_ID'), text(r5).slice(0, 120))
console.log('---')

// 6) tencent 零凭证降级
const r6 = await call('sms-send', { to: '13800138000', content: 'x', provider: 'tencent' })
check('sms-send tencent 无凭证 → isError', r6.isError === true)
check('tencent 错误点名 SMS_TENCENT_SECRET_ID', text(r6).includes('SMS_TENCENT_SECRET_ID'), text(r6).slice(0, 120))
console.log('---')

// 7) 缺必填参数 to → 参数校验错误
const r7 = await call('sms-send', { content: 'x' })
check('sms-send 缺 to → isError', r7.isError === true, text(r7).slice(0, 100))
check('缺参错误信息非空', text(r7).length > 0)
console.log('---')

// 8) 未知 provider → 明确报错
const r8 = await call('sms-send', { to: '13800138000', content: 'x', provider: 'bogus' })
check('sms-send 未知 provider → isError', r8.isError === true, text(r8).slice(0, 100))
console.log('---')

// 9) delivery-status mock:模拟回执
const r9 = await call('sms-delivery-status', { phone: '13800138000', provider: 'mock' })
const j9 = json(r9)
check('delivery-status mock 返回 ok:true', j9?.ok === true, text(r9).slice(0, 120))
check('mock 回执为发送成功(sendStatus=3)', j9?.records?.[0]?.sendStatus === 3, JSON.stringify(j9?.records?.[0]))
console.log('---')

// 10) delivery-status auto(只有通用网关)→ 可行动错误
const r10 = await call('sms-delivery-status', { phone: '13800138000' })
check('delivery-status auto(仅通用网关)→ isError', r10.isError === true, text(r10).slice(0, 120))
check('错误说明通用网关不支持回执', text(r10).includes('通用 HTTP 网关不提供'), text(r10).slice(0, 120))
console.log('---')

// 11) provider-info:掩码状态
const r11 = await call('sms-provider-info', {})
const j11 = json(r11)
check('provider-info 返回 ok', r11.isError !== true && j11 !== null, text(r11).slice(0, 120))
check('provider-info 显示通用网关端点', typeof j11?.generic?.endpoint === 'string' && j11.generic.endpoint === endpoint)
check('provider-info 点名 aliyun 缺 SMS_ALIYUN_ACCESS_KEY_ID', Array.isArray(j11?.aliyun?.missing) && j11.aliyun.missing.includes('SMS_ALIYUN_ACCESS_KEY_ID'))
check('provider-info 显示 auto 选中 generic', j11?.autoPick === 'generic', String(j11?.autoPick))
console.log('---')

await client.close()
await new Promise((r) => server.close(r))
console.log(failures === 0 ? 'SMOKE DONE — ALL PASS' : `SMOKE DONE — ${failures} FAILURE(S)`)
process.exit(failures)
