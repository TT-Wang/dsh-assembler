// MCP stdio server adapter for axios/axios v1.7.2 (MIT)
// Capability id: http-request
// Tools: http-request, http-get, http-post, build-url
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import axios from 'axios'
import { AxiosError } from 'axios'

const server = new McpServer({
  name: 'http-request',
  version: '0.0.1'
})

const MAX_TEXT = 20000 // 响应体文本截断上限，防止超大响应撑爆 MCP 消息

// 把任意响应值安全地转成可读文本
function stringify(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2)
    } catch (e) {
      return String(value)
    }
  }
  return String(value)
}

function truncate(text) {
  const s = String(text)
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '\n…[响应过长，已截断]' : s
}

function ok(text) {
  return { content: [{ type: 'text', text: truncate(text) }] }
}

// 统一错误出口：参数非法、网络失败、HTTP 4xx/5xx 都以文本形式返回
function fail(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

function describeAxiosError(err) {
  if (err instanceof AxiosError) {
    const parts = [
      `错误: ${err.message}`,
      `code: ${err.code || '无'}`,
      err.config ? `method: ${(err.config.method || '').toUpperCase()}` : null,
      err.config ? `url: ${err.config.url || ''}` : null,
      err.response
        ? `HTTP ${err.response.status} ${err.response.statusText || ''}\n响应体:\n${truncate(stringify(err.response.data))}`
        : '无响应（网络层失败，如 DNS/连接拒绝/超时）'
    ].filter(Boolean)
    return parts.join('\n')
  }
  return `错误: ${err && err.message ? err.message : String(err)}`
}

// 组装 axios 请求配置；返回 { config } 或 { error }
function buildRequestConfig(args) {
  const config = {
    url: args.url,
    method: args.method || 'get'
  }
  if (args.baseURL !== undefined) config.baseURL = args.baseURL
  if (args.params !== undefined) {
    if (typeof args.params !== 'object' || args.params === null || Array.isArray(args.params)) {
      return { error: '参数 params 必须是普通对象（如 {"page":1}）' }
    }
    config.params = args.params
  }
  if (args.headers !== undefined) {
    if (typeof args.headers !== 'object' || args.headers === null || Array.isArray(args.headers)) {
      return { error: '参数 headers 必须是普通对象（如 {"Authorization":"Bearer x"}）' }
    }
    config.headers = args.headers
  }
  if (args.data !== undefined) {
    if (typeof args.data === 'object' && args.data !== null && !Array.isArray(args.data)) {
      config.data = JSON.stringify(args.data) // 对象按 JSON 序列化发送
    } else {
      return { error: '参数 data 必须是 JSON 对象' }
    }
  }
  if (args.timeout !== undefined) {
    if (typeof args.timeout !== 'number' || !Number.isFinite(args.timeout) || args.timeout < 0) {
      return { error: '参数 timeout 必须是非负数字（毫秒）' }
    }
    config.timeout = args.timeout
  }
  if (args.maxRedirects !== undefined) {
    if (typeof args.maxRedirects !== 'number' || args.maxRedirects < 0) {
      return { error: '参数 maxRedirects 必须是非负数字' }
    }
    config.maxRedirects = args.maxRedirects
  }
  if (args.responseType !== undefined) {
    if (!['json', 'text', 'arraybuffer', 'stream'].includes(args.responseType)) {
      return { error: '参数 responseType 必须是 json|text|arraybuffer|stream 之一' }
    }
    config.responseType = args.responseType
  }
  if (args.responseEncoding !== undefined) config.responseEncoding = args.responseEncoding
  if (args.authUser !== undefined || args.authPass !== undefined) {
    config.auth = {
      username: args.authUser || '',
      password: args.authPass || ''
    }
  }
  if (args.validateStatus === false) {
    // 用户显式要求：任何状态码都不视为错误
    config.validateStatus = () => true
  } else if (args.validateStatus !== undefined && typeof args.validateStatus !== 'boolean') {
    return { error: '参数 validateStatus 必须是布尔值' }
  }
  return { config }
}

// 执行请求并把 axios 响应整理成可读文本
async function runRequest(config) {
  const started = Date.now()
  let response
  try {
    response = await axios.request(config)
  } catch (err) {
    return fail(describeAxiosError(err))
  }
  const elapsed = Date.now() - started
  let headers = response.headers
  if (headers && typeof headers.toJSON === 'function') {
    headers = headers.toJSON()
  }
  const lines = [
    `成功请求 ${(config.method || 'GET').toUpperCase()} ${response.config && response.config.url ? response.config.url : config.url}`,
    `状态: ${response.status} ${response.statusText || ''} (${elapsed}ms)`,
    `响应头:\n${stringify(headers)}`,
    `响应体:\n${truncate(stringify(response.data))}`
  ]
  return ok(lines.join('\n'))
}

// 通用参数 schema（http-request 专用）
const requestShape = {
  method: z.string().describe('HTTP 方法：get/post/put/patch/delete/head/options（大小写不敏感），必填'),
  url: z.string().describe('请求 URL（必填），如 https://example.com/api'),
  baseURL: z.string().optional().describe('可选 baseURL，与 url 拼接为最终地址'),
  params: z.record(z.string(), z.unknown()).optional().describe('查询参数对象，序列化为 query string，如 {"page":1,"q":"hello"}'),
  headers: z.record(z.string(), z.unknown()).optional().describe('请求头对象，如 {"Authorization":"Bearer xxx"}'),
  data: z.record(z.string(), z.unknown()).optional().describe('请求体（可选）：JSON 对象，会以 application/json 序列化发送'),
  timeout: z.number().nonnegative().optional().describe('超时毫秒数（可选，默认 0 表示不超时）'),
  maxRedirects: z.number().nonnegative().optional().describe('最大跟随重定向次数（可选，默认 5）'),
  authUser: z.string().optional().describe('HTTP Basic 认证用户名（与 authPass 搭配）'),
  authPass: z.string().optional().describe('HTTP Basic 认证密码'),
  responseType: z.enum(['json', 'text', 'arraybuffer', 'stream']).optional().describe('响应数据类型（可选，默认 json）'),
  responseEncoding: z.string().optional().describe('响应字符编码（可选，默认 utf8）'),
  validateStatus: z.boolean().optional().describe('设为 false 时任何 HTTP 状态码都返回成功而非报错（可选）')
}

server.tool(
  'http-request',
  '通用 HTTP 请求（axios.request 封装）：可用任意方法向任意 URL 发起请求，支持查询参数、请求头、JSON 请求体、Basic 认证、超时、重定向与响应类型控制。适合调用 REST API、GraphQL、下载页面等场景。返回状态码、响应头与响应体；HTTP 4xx/5xx 或网络错误会以 isError 文本形式返回错误详情。参数：method（必填，get/post/put/patch/delete/head/options，大小写不敏感）、url（必填）、baseURL（可选，与 url 拼接）、params（可选，查询参数对象）、headers（可选，请求头对象）、data（可选，JSON 请求体对象，按 application/json 序列化）、timeout（可选，毫秒）、maxRedirects（可选，默认 5）、authUser/authPass（可选，HTTP Basic 认证）、responseType（可选，json|text|arraybuffer|stream）、responseEncoding（可选）、validateStatus（可选，false 表示任何状态码都不算错误）。',
  requestShape,
  async (args) => {
    const { config, error } = buildRequestConfig(args)
    if (error) return fail(error)
    return runRequest(config)
  }
)

server.tool(
  'http-get',
  'HTTP GET 请求（axios.get 封装）：拉取 URL 内容，支持查询参数、请求头、超时与响应类型。适合读取网页/API 数据、健康检查。返回状态码、响应头与响应体。参数：url（必填）、params（可选，查询参数对象）、headers（可选）、timeout（可选，毫秒）、responseType（可选，json|text|arraybuffer|stream）。',
  {
    url: z.string().describe('请求 URL（必填），如 https://example.com/api/items'),
    params: z.record(z.string(), z.unknown()).optional().describe('查询参数对象，如 {"page":1,"limit":10}'),
    headers: z.record(z.string(), z.unknown()).optional().describe('请求头对象，如 {"Accept":"application/json"}'),
    timeout: z.number().nonnegative().optional().describe('超时毫秒数（可选，默认不超时）'),
    responseType: z.enum(['json', 'text', 'arraybuffer', 'stream']).optional().describe('响应数据类型（可选，默认 json）')
  },
  async (args) => {
    const { config, error } = buildRequestConfig({ ...args, method: 'get' })
    if (error) return fail(error)
    return runRequest(config)
  }
)

server.tool(
  'http-post',
  'HTTP POST 请求（axios.post 封装）：向 URL 提交 JSON 请求体，支持请求头、超时。适合创建资源、提交 JSON 数据。返回状态码、响应头与响应体。参数：url（必填）、data（必填，JSON 对象，以 application/json 序列化发送）、headers（可选）、timeout（可选，毫秒）。',
  {
    url: z.string().describe('请求 URL（必填），如 https://example.com/api/items'),
    data: z.record(z.string(), z.unknown()).describe('JSON 请求体（必填），如 {"name":"foo","count":3}'),
    headers: z.record(z.string(), z.unknown()).optional().describe('请求头对象，如 {"Content-Type":"application/json"}'),
    timeout: z.number().nonnegative().optional().describe('超时毫秒数（可选，默认不超时）')
  },
  async (args) => {
    const { config, error } = buildRequestConfig({ ...args, method: 'post' })
    if (error) return fail(error)
    return runRequest(config)
  }
)

server.tool(
  'build-url',
  '拼接完整请求 URL（axios.getUri 封装）：由 baseURL + url + params 生成最终地址，纯本地计算、不发起任何网络请求，适合确认 URL 编码是否正确或提前构造链接。参数：url（必填）、baseURL（可选）、params（可选，查询参数对象）。返回最终 URL 字符串。',
  {
    url: z.string().describe('路径或相对地址（必填），如 /api/items 或 api/items'),
    baseURL: z.string().optional().describe('可选 baseURL，如 https://example.com'),
    params: z.record(z.string(), z.unknown()).optional().describe('查询参数对象，如 {"q":"hello world","page":2}')
  },
  async (args) => {
    if (args.params !== undefined) {
      if (typeof args.params !== 'object' || args.params === null || Array.isArray(args.params)) {
        return fail('参数 params 必须是普通对象（如 {"q":"hello","page":2}）')
      }
    }
    try {
      const built = axios.getUri({
        baseURL: args.baseURL,
        url: args.url,
        params: args.params
      })
      return ok(`URL: ${built}`)
    } catch (err) {
      return fail(`build-url 失败: ${err && err.message ? err.message : String(err)}`)
    }
  }
)

await server.connect(new StdioServerTransport())
