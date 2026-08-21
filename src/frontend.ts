/**
 * 前端车道:装配出带可视化前端的 agent。
 *
 * 两半:
 *  - 发射(emitFrontend):把 frontends/<模板>/ 的参数化文件填参后写进
 *    preset 的 frontend/,与 preset 同目录交付——前端是装备(装配时预思考的
 *    交互面),不是运行时注入。字节确定性(同输入同字节),复用轮重发即 no-op。
 *  - 路由(frontendRouteHandler):在 host webServer 上挂 /assembler/ui/<id>,
 *    同源伺服 preset/frontend/ 的静态文件——页面里的 /api/session.* 调用
 *    因同源天然可达,零 CORS。装配器只发静态字节,不参与会话执行
 *    (运行时判据:一个 GET 文件服务与 roster 伺服 preset 同性质)。
 *
 * 页面与 agent 的接线走 host 公开 wire(session.create / session.prompt /
 * events.mux)——与验收探针同一条,已被每次装配验证。先例:dsh-web-ui 的
 * /m/ 独立移动客户端证明独立页面讲 wire 完全成立;dsh-ios 证明插件可注册
 * 自有 web 路由。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** host webServer 上归本插件所有的路由前缀。 */
export const FRONTEND_ROUTE = '/assembler/ui'

/** 模板库根:每个子目录一个模板,index.html 必备。 */
export const FRONTEND_TEMPLATES_DIR = join(REPO, 'frontends')

/** 兜底模板:任何 preset 没选前端零件时也发这张(装完即有可操作页)。 */
export const DEFAULT_FRONTEND_TEMPLATE = 'chat-console'

/** preset id 面(与 index.ts 的 PRESET_ID_RE 同一契约,路由侧独立复验)。 */
const ID_RE = /^[a-z0-9][a-z0-9-]*$/

/** 资产名:单段、无路径分隔、无点开头——遍历面直接不存在(page-preview 的课)。 */
const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
}

/** 模板填参:{{key}} → 值;HTML 文本槽位由调用方保证已转义(值都来自装配器自身)。 */
export function fillTemplate(text: string, slots: Record<string, string>): string {
  return text.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_m, key: string) => slots[key] ?? '')
}

/** 列出可用模板名(frontends/ 的子目录,含 index.html 的才算)。 */
export function listFrontendTemplates(templatesDir = FRONTEND_TEMPLATES_DIR): string[] {
  try {
    return readdirSync(templatesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(templatesDir, d.name, 'index.html')))
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * 把模板发射进 preset:逐文件填参写入 frontend/。写入走"字节没变就跳过"
 * (与 writePresetFile 同款纪律)——模板确定性 ⇒ 复用轮重发 no-op,老 preset
 * 缺页时又能自动补齐。返回落盘文件清单与是否有变更。
 */
export function emitFrontend(opts: {
  template: string
  presetDir: string
  presetId: string
  requirement: string
  workdir: string
  templatesDir?: string
}): { template: string; files: string[]; changed: boolean } {
  const templatesDir = opts.templatesDir ?? FRONTEND_TEMPLATES_DIR
  const src = join(templatesDir, opts.template)
  if (!existsSync(join(src, 'index.html'))) {
    throw new Error(`前端模板不存在或缺 index.html:${src}`)
  }
  const outDir = join(opts.presetDir, 'frontend')
  mkdirSync(outDir, { recursive: true })
  // 标题取需求前段:页面自己的身份行,不另开 LLM 调用。
  const title = opts.requirement.replace(/\s+/g, ' ').trim().slice(0, 24)
  const slots: Record<string, string> = {
    presetId: opts.presetId,
    title,
    requirement: opts.requirement.replace(/\s+/g, ' ').trim().slice(0, 140),
    workdir: opts.workdir,
    route: `${FRONTEND_ROUTE}/${opts.presetId}`,
  }
  const files: string[] = []
  let changed = false
  for (const f of readdirSync(src)) {
    if (!ASSET_RE.test(f)) continue
    const raw = readFileSync(join(src, f))
    const isText = /\.(html|js|css|svg|json)$/.test(f)
    const out = isText ? Buffer.from(fillTemplate(raw.toString('utf8'), slots)) : raw
    const dest = join(outDir, f)
    if (!existsSync(dest) || !readFileSync(dest).equals(out)) {
      writeFileSync(dest, out)
      changed = true
    }
    files.push(`frontend/${f}`)
  }
  return { template: opts.template, files, changed }
}

/**
 * 路由解析(纯函数,单测覆盖):/assembler/ui/<id>[/<asset>] → 该 preset
 * frontend/ 里的文件。id 与 asset 双正则闸 + resolve 包含闸,任何越界一律 null。
 */
export function resolveFrontendFile(presetRoot: string, urlPath: string): { file: string; presetDir: string; mime: string } | null {
  if (!urlPath.startsWith(`${FRONTEND_ROUTE}/`)) return null
  const rest = urlPath.slice(FRONTEND_ROUTE.length + 1)
  const segs = rest.split('/').filter((s) => s !== '')
  if (segs.length < 1 || segs.length > 2) return null
  let id: string
  let asset: string
  try {
    id = decodeURIComponent(segs[0])
    asset = segs.length === 2 ? decodeURIComponent(segs[1]) : 'index.html'
  } catch {
    return null
  }
  if (!ASSET_RE.test(asset)) return null
  // 共享 vendor 段:/assembler/ui/_vendor/<asset> 伺服组件库(Franken UI,本地
  // vendor 一份供所有 preset 页面引用——离线/内网交付不依赖任何 CDN)。页面里
  // 写相对路径 "_vendor/x" 即可命中(页面 URL 无尾斜杠,相对解析回本前缀)。
  if (id === '_vendor') {
    const vendorDir = join(FRONTEND_TEMPLATES_DIR, '_vendor')
    const file = resolve(vendorDir, asset)
    if (!file.startsWith(resolve(vendorDir) + '/')) return null
    const dot = asset.slice(asset.lastIndexOf('.'))
    return { file, presetDir: vendorDir, mime: MIME[dot] ?? 'application/octet-stream' }
  }
  if (!ID_RE.test(id)) return null
  const presetDir = join(presetRoot, id)
  const file = resolve(presetDir, 'frontend', asset)
  if (!file.startsWith(resolve(presetDir, 'frontend') + '/')) return null
  const dot = asset.slice(asset.lastIndexOf('.'))
  return { file, presetDir, mime: MIME[dot] ?? 'application/octet-stream' }
}

/** 直播台数据:presetRoot 下各 progress.log 的尾部,按修改时间倒序。 */
export function listAssemblyProgress(presetRoot: string, limit = 20): Array<{ id: string; mtime: number; tail: string }> {
  let names: string[] = []
  try {
    names = readdirSync(presetRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
  const items: Array<{ id: string; mtime: number; tail: string }> = []
  for (const id of names) {
    const p = join(presetRoot, id, 'progress.log')
    try {
      const st = statSync(p)
      const text = readFileSync(p, 'utf8')
      const lines = text.split('\n')
      items.push({ id, mtime: Math.floor(st.mtimeMs / 1000), tail: lines.slice(-120).join('\n') })
    } catch { /* 该 preset 没有直播文件(老代或手工目录) */ }
  }
  return items.sort((a, b) => b.mtime - a.mtime).slice(0, limit)
}

/**
 * host webServer 路由处理器工厂。GET 页面时顺手确保该 preset 的 workspace/
 * 存在——页面的 session.create 用它当 cwd,同一 preset 的前端会话共享一个
 * 持久工作区(记账台的账本跨次打开仍在)。
 */
export function frontendRouteHandler(presetRoot: string): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const send = (code: number, text: string): void => {
      res.statusCode = code
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end(text)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method Not Allowed')
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://local').pathname
    } catch {
      return send(400, 'Bad Request')
    }
    if (pathname === `${FRONTEND_ROUTE}/_console/data`) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      return res.end(JSON.stringify({ items: listAssemblyProgress(presetRoot) }))
    }
    if (pathname === `${FRONTEND_ROUTE}/_console` || pathname === `${FRONTEND_ROUTE}/_console/`) {
      const page = join(FRONTEND_TEMPLATES_DIR, '_console', 'index.html')
      if (!existsSync(page)) return send(404, 'Not found')
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      return res.end(readFileSync(page))
    }
    const hit = resolveFrontendFile(presetRoot, pathname)
    if (hit === null || !existsSync(hit.file)) return send(404, 'Not found')
    if (hit.mime.startsWith('text/html') && hit.file.includes('/frontend/')) {
      try {
        mkdirSync(join(hit.presetDir, 'workspace'), { recursive: true })
      } catch { /* workspace 建不出来让 session.create 自己报 */ }
    }
    res.statusCode = 200
    res.setHeader('Content-Type', hit.mime)
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'HEAD') return res.end()
    res.end(readFileSync(hit.file))
  }
}
