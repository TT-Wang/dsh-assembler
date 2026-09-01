// MCP stdio server adapter for microsoft/playwright v1.45.0 (Apache-2.0)
// Capability id: browser-automate
// Tools: browser-open, browser-extract, browser-click, browser-fill, browser-screenshot,
//        browser-select, browser-press, browser-hover, browser-upload, browser-inspect
// (后五指 2026-09-01 加装:DOM 考官词表 2→8 与 preview 机械眼的手;见装配器
//  BACKLOG 1.0 前端能力工单。选择器全程走 playwright locator,天然支持 text=、
//  :nth-match(sel, n)、[role=] 等引擎——"循环格点第 N 项"不需要新工具,教词表即可。)
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
  version: '0.1.0'
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

// console/pageerror 必须从建页起就监听——事后问不到历史(机械眼的证据链要求)。
// browser-open 新建页面时数组随之重置,天然按"当前页面"分段。
let consoleEntries = []
let pageErrors = []

async function getPage() {
  if (page && !page.isClosed()) return page
  const b = await getBrowser()
  page = await b.newPage()
  consoleEntries = []
  pageErrors = []
  page.on('console', (msg) => {
    const t = msg.type()
    if (t === 'error' || t === 'warning') consoleEntries.push({ type: t, text: String(msg.text()).slice(0, 300) })
  })
  page.on('pageerror', (err) => { pageErrors.push(String(err && err.message || err).slice(0, 300)) })
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
      // 每次导航清空 console/pageerror 台账:机械眼按"本页本次加载"计账
      consoleEntries = []
      pageErrors = []
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

// ---- 工具 3.5：browser-fill ------------------------------------------------
// DOM 层考（装配器 verify_app 第六门）的手：click-only 驱不动最典型的建单流
// （先填输入框再点按钮），且区分口令必须打进输入框才能织进证据链。
// playwright fill 派发真实 input 事件，React 受控输入吃得住；locator 严格模式
// 下多匹配即报错并列出候选（报错即界面白拿）。
server.tool(
  'browser-fill',
  '向页面上指定 CSS 选择器对应的输入元素填入文本（input/textarea/contenteditable）。' +
    '自动等待元素可见后填入；fill 会先清空原值再输入，派发真实 input 事件（React 受控组件可用）。' +
    '返回填入后的元素值，便于确认。',
  {
    selector: z.string().min(1, 'selector 不能为空').describe('要填入元素的 CSS 选择器，例如 "#draft"、"input[name=title]"'),
    value: z.string().describe('要填入的文本（会先清空原值）'),
    timeout: z.number().int().positive().max(120000).optional().default(30000)
      .describe('等待元素可见的超时毫秒数，默认 30000')
  },
  async (args) => {
    const selector = String(args.selector ?? '').trim()
    if (!selector) return fail('参数错误: selector 为必填字符串')
    try {
      const p = await getPage()
      const loc = p.locator(selector)
      await loc.waitFor({ state: 'visible', timeout: args.timeout })
      await loc.fill(String(args.value ?? ''), { timeout: args.timeout })
      const now = await loc.inputValue().catch(async () => (await loc.innerText().catch(() => '')).trim())
      return ok(`已填入 (selector="${selector}")，当前值: ${JSON.stringify(String(now).slice(0, 200))}`)
    } catch (err) {
      return fail(`browser-fill 失败: ${err.message ?? String(err)}`)
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

// ---- 工具 5:browser-select ------------------------------------------------
server.tool(
  'browser-select',
  '在原生 <select> 元素上选择选项(派发真实 change 事件,React 受控组件可用)。' +
    '按 value 或可见文本 label 选;二者给其一。注意:Radix/shadcn 的 Select 不是原生 ' +
    '<select>,那种用两步 browser-click(先点触发器,再点 [role=option] 或 text=选项文本)。',
  {
    selector: z.string().min(1).describe('原生 select 元素的 CSS 选择器'),
    value: z.string().optional().describe('按 option 的 value 选'),
    label: z.string().optional().describe('按 option 的可见文本选'),
    timeout: z.number().int().positive().max(120000).optional().default(30000)
  },
  async (args) => {
    const selector = String(args.selector ?? '').trim()
    if (!selector) return fail('参数错误: selector 为必填字符串')
    if (args.value === undefined && args.label === undefined) return fail('参数错误: value 与 label 至少给其一')
    try {
      const p = await getPage()
      const loc = p.locator(selector)
      await loc.waitFor({ state: 'visible', timeout: args.timeout })
      const picked = await loc.selectOption(args.value !== undefined ? { value: args.value } : { label: args.label }, { timeout: args.timeout })
      return ok(`已选择 (selector="${selector}") → ${JSON.stringify(picked)}`)
    } catch (err) {
      return fail(`browser-select 失败: ${err.message ?? String(err)}(收到 value=${JSON.stringify(args.value)} label=${JSON.stringify(args.label)};若目标是 Radix/shadcn Select,请改用两步 browser-click)`)
    }
  }
)

// ---- 工具 6:browser-press -------------------------------------------------
server.tool(
  'browser-press',
  '在指定元素上按一个键(如 Enter、Escape、ArrowDown、Control+a)。派发真实键盘事件,' +
    'React onKeyDown/回车提交(bindEnter 类)可用。selector 缺省时对页面焦点元素按键。',
  {
    selector: z.string().optional().describe('目标元素 CSS 选择器;缺省 = 当前焦点'),
    key: z.string().min(1).describe('键名,playwright 语法:Enter/Escape/Tab/ArrowDown/Control+a 等'),
    timeout: z.number().int().positive().max(120000).optional().default(30000)
  },
  async (args) => {
    const key = String(args.key ?? '').trim()
    if (!key) return fail('参数错误: key 为必填字符串')
    try {
      const p = await getPage()
      if (args.selector) {
        const loc = p.locator(String(args.selector))
        await loc.waitFor({ state: 'visible', timeout: args.timeout })
        await loc.press(key, { timeout: args.timeout })
      } else {
        await p.keyboard.press(key)
      }
      return ok(`已按键 ${key}${args.selector ? ` (selector="${args.selector}")` : '(焦点元素)'}`)
    } catch (err) {
      return fail(`browser-press 失败: ${err.message ?? String(err)}`)
    }
  }
)

// ---- 工具 7:browser-hover -------------------------------------------------
server.tool(
  'browser-hover',
  '将鼠标悬停到指定元素上(触发 tooltip/悬浮菜单等 hover 态)。悬停后一般紧跟 ' +
    'browser-extract 或 browser-click 验证/操作被揭示的内容。',
  {
    selector: z.string().min(1).describe('要悬停元素的 CSS 选择器'),
    timeout: z.number().int().positive().max(120000).optional().default(30000)
  },
  async (args) => {
    const selector = String(args.selector ?? '').trim()
    if (!selector) return fail('参数错误: selector 为必填字符串')
    try {
      const p = await getPage()
      const loc = p.locator(selector)
      await loc.waitFor({ state: 'visible', timeout: args.timeout })
      await loc.hover({ timeout: args.timeout })
      return ok(`已悬停 (selector="${selector}")`)
    } catch (err) {
      return fail(`browser-hover 失败: ${err.message ?? String(err)}`)
    }
  }
)

// ---- 工具 8:browser-upload ------------------------------------------------
server.tool(
  'browser-upload',
  '向 <input type=file> 设置要上传的本地文件(派发真实 change 事件,React 可用)。' +
    'filePath 必须是本机已存在的文件绝对路径(调用方先落盘再传路径)。',
  {
    selector: z.string().min(1).describe('文件输入框的 CSS 选择器,如 input[type=file]'),
    filePath: z.string().min(1).describe('要上传文件的绝对路径(须已存在)'),
    timeout: z.number().int().positive().max(120000).optional().default(30000)
  },
  async (args) => {
    const selector = String(args.selector ?? '').trim()
    const filePath = String(args.filePath ?? '').trim()
    if (!selector || !filePath) return fail('参数错误: selector 与 filePath 均为必填')
    try {
      const p = await getPage()
      const loc = p.locator(selector)
      await loc.waitFor({ state: 'attached', timeout: args.timeout })
      await loc.setInputFiles(filePath, { timeout: args.timeout })
      return ok(`已设置上传文件 (selector="${selector}") ← ${filePath}`)
    } catch (err) {
      return fail(`browser-upload 失败: ${err.message ?? String(err)}`)
    }
  }
)

// ---- 工具 9:browser-inspect -----------------------------------------------
// 机械眼:一次调用返回本页的确定性体检 JSON——console/pageerror 台账、横向溢出、
// 零尺寸/出屏元素、死图、低对比度文本样本、布局降维速写。colorScheme 可切换
// 亮/暗模拟(设置后保持,便于紧跟 browser-screenshot 拍同一主题)。
server.tool(
  'browser-inspect',
  '对当前页面做确定性体检,返回 JSON:consoleErrors(本次加载的 console error/warning)、' +
    'pageErrors(未捕获异常)、overflowX(横向溢出元素)、zeroSized(渲染为零尺寸的可见候选)、' +
    'deadImages(naturalWidth=0)、lowContrast(对比度 < 4.5 的文本样本,WCAG 近似)、' +
    'layout(布局降维速写:主要元素的盒子与文本)。colorScheme 给 light/dark 时先切换模拟再体检。',
  {
    colorScheme: z.enum(['light', 'dark']).optional().describe('体检前切换 prefers-color-scheme 模拟(设置后保持)'),
    maxItems: z.number().int().positive().max(50).optional().default(12).describe('每类问题最多列几条')
  },
  async (args) => {
    try {
      const p = await getPage()
      if (args.colorScheme) await p.emulateMedia({ colorScheme: args.colorScheme })
      if (args.colorScheme) await p.waitForTimeout(150) // 给主题样式一拍生效时间
      const max = args.maxItems ?? 12
      const audit = await p.evaluate((MAX) => {
        const short = (el) => {
          const id = el.id ? `#${el.id}` : ''
          const cls = el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : ''
          return `${el.tagName.toLowerCase()}${id}${cls}`
        }
        const lum = (r, g, b) => {
          const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
        }
        const parseRgb = (s) => {
          const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(s)
          return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null
        }
        const doc = document.documentElement
        const overflowX = []
        const zeroSized = []
        const deadImages = []
        const lowContrast = []
        const vw = window.innerWidth
        if (doc.scrollWidth > vw + 1) overflowX.push(`<页面整体> scrollWidth ${doc.scrollWidth} > 视口 ${vw}`)
        const els = [...document.querySelectorAll('body *')]
        for (const el of els) {
          const cs = getComputedStyle(el)
          if (cs.display === 'none' || cs.visibility === 'hidden') continue
          const r = el.getBoundingClientRect()
          if (overflowX.length < MAX && r.right > vw + 1 && r.width > 8) overflowX.push(`${short(el)} 右缘 ${Math.round(r.right)}px 超出视口 ${vw}px`)
          // OPTION/OPTGROUP 在闭合的 select 里天然 0×0(预览眼首航实测误报),不算病
          if (zeroSized.length < MAX && (r.width === 0 || r.height === 0) && el.childElementCount === 0 && (el.textContent || '').trim() !== '' && el.tagName !== 'OPTION' && el.tagName !== 'OPTGROUP') zeroSized.push(`${short(el)} 有文本但渲染 ${Math.round(r.width)}×${Math.round(r.height)}`)
          if (el.tagName === 'IMG' && deadImages.length < MAX && el.complete && el.naturalWidth === 0) deadImages.push(`${short(el)} src=${(el.getAttribute('src') || '').slice(0, 80)}`)
          if (lowContrast.length < MAX && el.childElementCount === 0) {
            const txt = (el.textContent || '').trim()
            if (txt.length >= 3 && r.width > 0 && r.height > 0) {
              const fg = parseRgb(cs.color)
              let bgEl = el
              let bg = null
              while (bgEl && bgEl !== document.body.parentElement) {
                const c = parseRgb(getComputedStyle(bgEl).backgroundColor)
                if (c && c.a > 0.9) { bg = c; break }
                bgEl = bgEl.parentElement
              }
              if (fg && bg) {
                const L1 = lum(fg.r, fg.g, fg.b)
                const L2 = lum(bg.r, bg.g, bg.b)
                const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
                if (ratio < 4.5) lowContrast.push(`${short(el)} 对比度 ${ratio.toFixed(1)}:「${txt.slice(0, 24)}」`)
              }
            }
          }
        }
        // 布局降维速写:两层以内的主要容器 + 尺寸 + 首行文本
        const layout = []
        const walk = (el, depth) => {
          if (depth > 2 || layout.length >= 40) return
          const r = el.getBoundingClientRect()
          if (r.width < 24 || r.height < 16) return
          const txt = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').slice(0, 40)
          layout.push(`${'  '.repeat(depth)}${short(el)} [${Math.round(r.width)}×${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)}]${txt ? ` "${txt}"` : ''}`)
          for (const c of el.children) walk(c, depth + 1)
        }
        const root = document.querySelector('#root') || document.body
        walk(root, 0)
        return { overflowX, zeroSized, deadImages, lowContrast, layout, title: document.title }
      }, max)
      audit.consoleErrors = consoleEntries.slice(0, max)
      audit.pageErrors = pageErrors.slice(0, max)
      audit.colorScheme = args.colorScheme ?? 'default'
      return ok(JSON.stringify(audit, null, 1))
    } catch (err) {
      return fail(`browser-inspect 失败: ${err.message ?? String(err)}`)
    }
  }
)

// ---- 启动 stdio 服务器 ----------------------------------------------------
const transport = new StdioServerTransport()
await server.connect(transport)
