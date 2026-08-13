// MCP stdio server adapter for microsoft/playwright v1.45.0 (Apache-2.0)
// Capability id: browser-automate
// Tools: browser-open, browser-extract, browser-click, browser-screenshot
//
// 依赖 playwright（官方浏览器自动化库）。进程内维护单例 Browser/Page：
//   - 首次需要页面时惰性启动（优先使用 playwright 自带的 chromium；
//     若未安装自带浏览器则自动回退到系统 Google Chrome，即 channel: 'chrome'）。
//   - browser-open 打开/切换页面；其余工具操作"当前页面"。
//
// 说明：
//   - browser-screenshot 的截图以 base64 返回（MCP image 内容块 + 文本块中的 data URL）。
//   - 所有工具出错时返回清晰错误文本（isError 结果），绝不抛未捕获异常。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { chromium } from 'playwright'

const server = new McpServer({
  name: 'browser-automate',
  version: '0.0.1'
})

const MAX_TEXT = 60000 // 文本响应截断上限

function truncate(text) {
  const s = String(text)
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '\n…[响应过长，已截断]' : s
}

function ok(text) {
  return { content: [{ type: 'text', text: truncate(text) }] }
}

function fail(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

// ---- 单例浏览器/页面状态 ------------------------------------------------
let browser = null
let page = null
let launching = null

async function getBrowser(headless = true) {
  if (browser) return browser
  if (!launching) {
    launching = (async () => {
      // 优先用 playwright 自带 chromium；失败（未下载二进制）时回退到系统 Google Chrome
      try {
        return await chromium.launch({ headless })
      } catch (firstErr) {
        try {
          const b = await chromium.launch({ headless, channel: 'chrome' })
          return b
        } catch (secondErr) {
          launching = null
          throw new Error(
            `无法启动浏览器: 自带 chromium 启动失败(${firstErr.message})，回退系统 Chrome 也失败(${secondErr.message})。` +
            `请运行 npx playwright install chromium 或安装 Google Chrome。`
          )
        }
      }
    })()
  }
  browser = await launching
  return browser
}

async function getPage() {
  if (page && !page.isClosed()) return page
  const b = await getBrowser()
  page = await b.newPage()
  return page
}

async function closeBrowser() {
  try { if (browser) await browser.close() } catch { /* ignore */ }
  browser = null
  page = null
  launching = null
}

// 客户端断开（stdin 关闭）后：释放浏览器并退出进程，保证干净退出。
// StdioServerTransport 只监听 stdin 的 data/error，不监听 end/close，
// 若不显式退出，运行中的 chromium 子进程会让事件循环永不结束。
let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  await closeBrowser()
  process.exit(0)
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)

// 进程退出时释放浏览器，保证 stdin 关闭后能干净退出
process.on('exit', () => { void closeBrowser() })
process.on('SIGINT', () => { void closeBrowser(); process.exit(0) })
process.on('SIGTERM', () => { void closeBrowser(); process.exit(0) })

// ---- 工具 1：browser-open ------------------------------------------------
server.tool(
  'browser-open',
  '打开一个 URL 并等待页面加载完成。启动（或复用）浏览器，关闭旧页面并新建页面导航到目标地址。' +
    '参数 url 为目标网址（http/https 开头）；waitUntil 控制等待条件（load=全部资源加载完，' +
    'domcontentloaded=仅 DOM 就绪，networkidle=网络空闲，commit=刚收到响应头）；timeout 为超时毫秒数。' +
    '返回 JSON：{title, url, status, finalUrl}（status 为 HTTP 状态码，可能为 null）。' +
    '浏览器自动化流程的第一步，后续可用 browser-extract / browser-click / browser-screenshot 操作该页面。',
  {
    url: z.string().min(1, 'url 不能为空').describe('要打开的完整网址，例如 https://example.com（需含协议前缀）'),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
      .optional().default('load')
      .describe('等待页面加载完成的时机，默认 load'),
    timeout: z.number().int().positive().max(120000).optional().default(30000)
      .describe('导航超时毫秒数，默认 30000'),
    headless: z.boolean().optional().default(true)
      .describe('是否以无头模式启动浏览器，默认 true')
  },
  async (args) => {
    const url = String(args.url ?? '').trim()
    if (!url) return fail('参数错误: url 为必填字符串')
    if (!/^https?:\/\//i.test(url)) {
      return fail(`参数错误: url 必须以 http:// 或 https:// 开头，收到 "${url}"`)
    }
    try {
      const p = await getPage(args.headless)
      const resp = await p.goto(url, { waitUntil: args.waitUntil, timeout: args.timeout })
      const out = {
        title: await p.title().catch(() => null),
        url: p.url(),
        status: resp ? resp.status() : null,
        finalUrl: resp ? resp.url() : p.url()
      }
      return ok(JSON.stringify(out, null, 2))
    } catch (err) {
      return fail(`browser-open 失败: ${err.message ?? String(err)}`)
    }
  }
)

// ---- 工具 2：browser-extract ---------------------------------------------
server.tool(
  'browser-extract',
  '从当前页面提取文本内容。默认提取整个页面可见文本（body 的 innerText）；' +
    '可通过 selector 提取某个元素（第一个匹配）的文本；attribute 改为提取该元素的指定属性值（如 href、src、value）；' +
    'all=true 时提取所有匹配元素的文本并以 JSON 数组返回。用于抓取网页正文、链接地址、图片地址等。',
  {
    selector: z.string().optional().default('body')
      .describe('CSS 选择器，默认 body 表示整页'),
    attribute: z.string().optional()
      .describe('若提供，则提取元素的该属性值（如 href/src/value）而非文本'),
    all: z.boolean().optional().default(false)
      .describe('true 时返回所有匹配元素的结果数组，false 只返回第一个匹配')
  },
  async (args) => {
    try {
      const p = await getPage()
      const selector = String(args.selector ?? 'body')
      const loc = p.locator(selector)
      const count = await loc.count()
      if (count === 0) return fail(`browser-extract 失败: 未找到匹配 "${selector}" 的元素`)

      if (args.all) {
        const results = []
        for (let i = 0; i < count; i++) {
          const el = loc.nth(i)
          results.push(args.attribute
            ? { index: i, value: await el.getAttribute(args.attribute).catch(() => null) }
            : { index: i, text: await el.innerText().catch(() => '') })
        }
        return ok(JSON.stringify(results, null, 2))
      }

      if (args.attribute) {
        const value = await loc.first().getAttribute(args.attribute)
        return ok(value ?? '')
      }
      const text = await loc.first().innerText()
      return ok(text)
    } catch (err) {
      return fail(`browser-extract 失败: ${err.message ?? String(err)}`)
    }
  }
)

// ---- 工具 3：browser-click ------------------------------------------------
server.tool(
  'browser-click',
  '在页面上点击指定 CSS 选择器对应的元素。自动等待元素出现并可交互后再点击；' +
    'timeout 为等待超时毫秒数。常用于点击按钮、链接、选项卡等触发页面交互。' +
    '点击后返回被点击元素的标签名与可见文本，便于确认操作对象。',
  {
    selector: z.string().min(1, 'selector 不能为空').describe('要点击元素的 CSS 选择器，例如 "#submit"、".nav a"'),
    timeout: z.number().int().positive().max(120000).optional().default(30000)
      .describe('等待元素可点击的超时毫秒数，默认 30000')
  },
  async (args) => {
    const selector = String(args.selector ?? '').trim()
    if (!selector) return fail('参数错误: selector 为必填字符串')
    try {
      const p = await getPage()
      const loc = p.locator(selector)
      await loc.waitFor({ state: 'visible', timeout: args.timeout })
      // 在点击前读取元素信息（点击可能触发导航使元素脱离 DOM）
      const tag = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => '?')
      const text = (await loc.first().innerText().catch(() => '')).trim().slice(0, 200)
      await loc.click({ timeout: args.timeout })
      return ok(`已点击 ${tag} 元素 (selector="${selector}")${text ? `，其文本: ${JSON.stringify(text)}` : ''}`)
    } catch (err) {
      return fail(`browser-click 失败: ${err.message ?? String(err)}`)
    }
  }
)

// ---- 工具 4：browser-screenshot -------------------------------------------
server.tool(
  'browser-screenshot',
  '对当前页面（或指定元素）截图，截图以 base64 编码返回：文本块中给出 data URL 前缀与字节数，' +
    '同时以 MCP image 内容块携带完整 base64（mimeType: image/png 或 image/jpeg）。' +
    'fullPage=true 截取整个可滚动页面；selector 指定时只截取该元素；' +
    'type=jpeg 时可用 quality(0-100) 控制压缩质量。用于页面视觉验证、元素外观检查。',
  {
    selector: z.string().optional()
      .describe('只截取该 CSS 选择器对应元素的区域'),
    fullPage: z.boolean().optional().default(false)
      .describe('true 时截取整页（含滚动区域），默认 false 只截视口'),
    type: z.enum(['png', 'jpeg']).optional().default('png').describe('图片格式，默认 png'),
    quality: z.number().int().min(0).max(100).optional()
      .describe('jpeg 格式的压缩质量 0-100，仅 type=jpeg 时生效')
  },
  async (args) => {
    try {
      const p = await getPage()
      const mimeType = args.type === 'jpeg' ? 'image/jpeg' : 'image/png'
      const opts = { type: args.type, fullPage: args.fullPage }
      if (args.type === 'jpeg' && args.quality !== undefined) opts.quality = args.quality

      let buffer
      if (args.selector) {
        const loc = p.locator(args.selector)
        const count = await loc.count()
        if (count === 0) return fail(`browser-screenshot 失败: 未找到匹配 "${args.selector}" 的元素`)
        buffer = await loc.first().screenshot(opts)
      } else {
        buffer = await p.screenshot(opts)
      }

      const base64 = buffer.toString('base64')
      const dataUrl = `data:${mimeType};base64,${base64}`
      return {
        content: [
          {
            type: 'text',
            text: `截图完成: ${mimeType}, ${buffer.length} 字节 (base64)。data URL: ${dataUrl.slice(0, 80)}…(共 ${base64.length} 字符)`
          },
          { type: 'image', data: base64, mimeType }
        ]
      }
    } catch (err) {
      return fail(`browser-screenshot 失败: ${err.message ?? String(err)}`)
    }
  }
)

// ---- 启动 stdio 服务器 ----------------------------------------------------
const transport = new StdioServerTransport()
await server.connect(transport)
