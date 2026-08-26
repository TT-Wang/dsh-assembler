// 冒烟验证：连接本 MCP stdio server，listTools() 后做真实调用（打开页面/截图/提取）+ 缺参校验
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js']
})

const client = new Client({ name: 'browser-automate-smoke', version: '0.0.1' })

function textOf(res) {
  return res.content.map((c) => (c.type === 'text' ? c.text : `[image block: ${c.mimeType} ${(c.data ?? '').length} chars]`)).join('\n')
}

async function main() {
  await client.connect(transport)

  // 1) listTools
  const { tools } = await client.listTools()
  console.log('=== listTools() ===')
  for (const t of tools) {
    console.log(`- ${t.name}: ${t.description.split('\n')[0]}`)
  }
  if (tools.length < 2) throw new Error(`工具数量异常: ${tools.length}`)

  // 2) 真实调用 1：browser-open
  console.log('\n=== call browser-open { url: "https://example.com" } ===')
  const r1 = await client.callTool({ name: 'browser-open', arguments: { url: 'https://example.com', waitUntil: 'domcontentloaded' } })
  const t1 = textOf(r1)
  console.log('返回:\n' + t1.slice(0, 500))
  if (r1.isError) throw new Error('browser-open 返回 isError: ' + t1)
  const opened = JSON.parse(t1)
  if (opened.status !== 200 && opened.status !== 304) throw new Error(`browser-open 状态码异常: ${opened.status}`)
  console.log('→ title =', opened.title, ', status =', opened.status)

  // 3) 真实调用 2：browser-extract（提取 h1）
  console.log('\n=== call browser-extract { selector: "h1" } ===')
  const r2 = await client.callTool({ name: 'browser-extract', arguments: { selector: 'h1' } })
  const t2 = textOf(r2)
  console.log('返回:', t2.slice(0, 200))
  if (r2.isError) throw new Error('browser-extract 返回 isError: ' + t2)
  if (!/Example Domain/i.test(t2)) throw new Error(`h1 内容不符: ${t2}`)
  console.log('→ 提取成功')

  // 4) 真实调用 3：browser-screenshot（验证 base64 图片返回）
  console.log('\n=== call browser-screenshot {} ===')
  const r3 = await client.callTool({ name: 'browser-screenshot', arguments: {} })
  console.log('返回:\n' + textOf(r3).slice(0, 300))
  if (r3.isError) throw new Error('browser-screenshot 返回 isError')
  const img = r3.content.find((c) => c.type === 'image')
  if (!img || !img.data) throw new Error('browser-screenshot 缺少 image 内容块')
  const buf = Buffer.from(img.data, 'base64')
  const magic = buf.subarray(0, 8).toString('hex')
  if (!magic.startsWith('89504e47')) throw new Error(`PNG 魔数校验失败: ${magic}`)
  console.log(`→ 图片块 OK: ${img.mimeType}, ${buf.length} 字节, PNG 魔数正确`)

  // 4.5) 真实调用：browser-fill（本地自起考场页：input 镜像 div——fill 必须派发
  // 真实 input 事件，React 受控输入才吃得住；镜像 div 即这条物理事实的见证人）
  console.log('\n=== call browser-fill（本地镜像页）===')
  const http = await import('node:http')
  const pageHtml = '<!doctype html><input id="inp"><div id="mirror"></div><script>document.getElementById("inp").addEventListener("input",e=>{document.getElementById("mirror").textContent=e.target.value})</script>'
  const srv = http.createServer((_q, res) => { res.setHeader('content-type', 'text/html'); res.end(pageHtml) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const localPort = srv.address().port
  const rOpen = await client.callTool({ name: 'browser-open', arguments: { url: `http://127.0.0.1:${localPort}/`, waitUntil: 'domcontentloaded' } })
  if (rOpen.isError) throw new Error('browser-open 本地页失败: ' + textOf(rOpen))
  const rf = await client.callTool({ name: 'browser-fill', arguments: { selector: '#inp', value: 'FILL-7788-试卷' } })
  const tf = textOf(rf)
  console.log('返回:', tf.slice(0, 200))
  if (rf.isError) throw new Error('browser-fill 返回 isError: ' + tf)
  if (!tf.includes('FILL-7788')) throw new Error('fill 回执未含填入值: ' + tf)
  const rm = await client.callTool({ name: 'browser-extract', arguments: { selector: '#mirror' } })
  const tm = textOf(rm)
  if (!tm.includes('FILL-7788')) throw new Error(`镜像 div 未收到 input 事件（React 受控输入会同病）: ${tm}`)
  console.log('→ fill 派发真实 input 事件，镜像验证通过')
  srv.close()

  // 5) 缺参调用：browser-click {}（缺 selector，应被拦截）
  console.log('\n=== call browser-click {} (缺参，应报参数错误) ===')
  const r4 = await client.callTool({ name: 'browser-click', arguments: {} })
  const t4 = textOf(r4)
  console.log('返回:', t4.slice(0, 300))
  const isErr = r4.isError === true || /参数错误|selector|Invalid/i.test(t4)
  console.log('→ 缺参被正确拦截:', isErr)
  if (!isErr) throw new Error('缺参调用未被拦截: ' + t4)

  console.log('\n=== SMOKE RESULT: PASS ===')
  await client.close() // 干净断开，让 server 收到 stdin EOF 后自行退出
  process.exit(0)
}

main().catch((err) => {
  console.error('SMOKE RESULT: FAIL ->', err.message ?? String(err))
  process.exit(1)
})
