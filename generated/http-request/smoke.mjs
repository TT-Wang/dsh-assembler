// 冒烟验证：连接本 MCP stdio server，listTools 并真实调用工具
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const cwd = new URL('.', import.meta.url).pathname
const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js'],
  cwd
})
const client = new Client({ name: 'http-request-smoke', version: '0.0.1' })

let failed = 0
const check = (label, cond, detail) => {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? '\n       ' + String(detail).slice(0, 400) : ''}`)
  if (!cond) failed++
}

try {
  await client.connect(transport)

  // 1. listTools
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name)
  check('listTools 返回 4 个工具', names.length === 4 && tools.every((t) => t.name && t.description), JSON.stringify(names))

  // 2. 真实调用：GET https://example.com（http-get）
  let res = await client.callTool({
    name: 'http-get',
    arguments: { url: 'https://example.com', timeout: 15000 }
  })
  const getText = res.content && res.content[0] ? res.content[0].text : ''
  check('http-get GET https://example.com 往返成功', !res.isError && /状态: 200/.test(getText), getText.slice(0, 200))
  check('http-get 返回 HTML 响应体', /Example Domain|<title>/i.test(getText), getText.slice(0, 300))

  // 3. 真实调用：build-url（纯本地，无网络）
  res = await client.callTool({
    name: 'build-url',
    arguments: { baseURL: 'https://example.com', url: '/api/items', params: { q: 'hello world', page: 2 } }
  })
  const buildText = res.content && res.content[0] ? res.content[0].text : ''
  // axios 默认对空格编码为 +（application/x-www-form-urlencoded 风格）
  check('build-url 拼接带编码参数的 URL', /URL: https:\/\/example\.com\/api\/items\?q=hello\+world&page=2/.test(buildText), buildText)

  // 4. 真实调用：http-post 到 example.com（返回 405，验证 HTTP 错误分支返回 isError 文本）
  res = await client.callTool({
    name: 'http-post',
    arguments: { url: 'https://example.com', data: { foo: 'bar' }, timeout: 15000 }
  })
  const postText = res.content && res.content[0] ? res.content[0].text : ''
  check('http-post 收到 405/4xx 时以 isError 文本返回', res.isError === true && /HTTP 405|HTTP 4\d\d|错误/.test(postText), postText.slice(0, 200))

  // 5. 参数校验：http-get 缺 url（SDK 层校验，以 isError 结果返回而非抛错）
  res = await client.callTool({ name: 'http-get', arguments: {} })
  const missingText = res.content && res.content[0] ? res.content[0].text : ''
  check('http-get 缺参触发 SDK 参数校验', res.isError === true && /Invalid arguments|Input validation error/i.test(missingText), missingText.slice(0, 200))

  // 6. 参数校验：http-request 非法 timeout（handler 层校验）
  res = await client.callTool({ name: 'http-request', arguments: { url: 'https://example.com', method: 'get', timeout: -5 } })
  check('http-request 非法 timeout 返回清晰错误', res.isError === true && /timeout/.test(res.content[0].text), res.content[0].text)
} catch (err) {
  failed++
  console.log('[FAIL] 冒烟整体异常:', err && err.stack ? err.stack : String(err))
} finally {
  try { await client.close() } catch (e) { /* ignore */ }
}

console.log(failed === 0 ? '\n冒烟结果: 全部通过' : `\n冒烟结果: ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
