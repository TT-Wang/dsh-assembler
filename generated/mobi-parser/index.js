/**
 * @dsh-index/mobi-parser — MCP stdio server wrapping @lingo-reader/mobi-parser 0.4.6.
 *
 * Tools (exposed to the dsh mcp-client as mcp__mobi-parser__<toolname>):
 *   - parse-mobi       : MOBI/AZW3 文件路径 -> 元数据(标题/作者/语言/出版信息) + 章节骨架(spine)
 *   - read-chapter     : 按章节 id 读某一章的正文(HTML 剥离成纯文本)
 *   - get-toc          : 读取书籍目录树(label/href/children)
 *
 * 纯本地解析,不访问网络;错误一律返回 { isError: true, ... },不抛裸异常。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { initMobiFile } from '@lingo-reader/mobi-parser'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const server = new McpServer({
  name: 'mobi-parser',
  version: '0.0.1',
  instructions:
    'MOBI / AZW3 (KF8) 电子书解析,基于 @lingo-reader/mobi-parser 0.4.6 (MIT, fork of foliate-js mobi.js)。' +
    '纯本地解析,不访问网络。输入均为宿主机上的文件路径;输出元数据、章节骨架、章节纯文本与目录树。',
})

/** Standard MCP text result. */
function ok(text) {
  return { content: [{ type: 'text', text }] }
}

/** Standard MCP error result (returned, not thrown). */
function fail(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}

function errText(err) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 把章节 HTML 剥离成可读纯文本:去 script/style、去标签、解码常见实体、归一空白。
 * 不依赖浏览器 DOM,只做文本层处理,足够 agent 阅读/摘抄。
 */
function htmlToText(html) {
  if (typeof html !== 'string') return ''
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

/** 每次解析用独立临时目录装资源,结束即清,不污染工作区。 */
function tempResourceDir() {
  return mkdtempSync(join(tmpdir(), 'mobi-parser-'))
}

async function openBook(filePath) {
  if (!existsSync(filePath)) throw new Error(`文件不存在:${filePath}`)
  const resourceDir = tempResourceDir()
  try {
    const mobi = await initMobiFile(filePath, resourceDir)
    return { mobi, resourceDir }
  } catch (err) {
    rmSync(resourceDir, { recursive: true, force: true })
    throw err
  }
}

function closeBook(ctx) {
  try {
    ctx.mobi.destroy()
  } catch { /* best-effort */ }
  rmSync(ctx.resourceDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Tool 1: parse-mobi
// ---------------------------------------------------------------------------
server.tool(
  'parse-mobi',
  '解析 MOBI/AZW3 电子书文件,返回书籍元数据(标题/作者/语言/出版日期/出版社/简介/标识符)与章节骨架(spine:每章 id、字节位置、大小)。' +
    '适合读书助手在上传后先调它拿书名、作者与章节清单;要读正文请再用 read-chapter。',
  {
    filePath: z.string().min(1).describe('宿主机上 MOBI 或 AZW3 文件的绝对路径(必填)。'),
  },
  async ({ filePath }) => {
    let ctx
    try {
      ctx = await openBook(filePath)
      const mobi = ctx.mobi
      const meta = mobi.getMetadata()
      const spine = mobi.getSpine()
      const result = {
        fileName: mobi.getFileInfo().fileName,
        metadata: {
          identifier: meta.identifier ?? '',
          title: meta.title ?? '',
          author: Array.isArray(meta.author) ? meta.author : [meta.author].filter(Boolean),
          publisher: meta.publisher ?? '',
          language: meta.language ?? '',
          published: meta.published ?? '',
          description: meta.description ?? '',
          subject: Array.isArray(meta.subject) ? meta.subject : [],
          rights: meta.rights ?? '',
        },
        spine: (Array.isArray(spine) ? spine : []).map((c) => ({
          id: String(c.id),
          start: c.start,
          end: c.end,
          size: c.size,
        })),
        chapterCount: Array.isArray(spine) ? spine.length : 0,
      }
      return ok(JSON.stringify(result, null, 2))
    } catch (err) {
      return fail(`parse-mobi 失败(请确认文件是有效的 MOBI/AZW3):${errText(err)}`)
    } finally {
      if (ctx) closeBook(ctx)
    }
  }
)

// ---------------------------------------------------------------------------
// Tool 2: read-chapter
// ---------------------------------------------------------------------------
server.tool(
  'read-chapter',
  '按章节 id 读取 MOBI/AZW3 书籍某一章的正文,HTML 已剥离为纯文本(保留段落换行)。' +
    '章节 id 来自 parse-mobi 返回的 spine[].id;传不存在的 id 会得到明确错误。适合双语阅读器按章取原文。',
  {
    filePath: z.string().min(1).describe('宿主机上 MOBI 或 AZW3 文件的绝对路径(必填)。'),
    chapterId: z.string().min(1).describe('要读取的章节 id(来自 parse-mobi 的 spine[].id,必填)。'),
    maxLength: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('返回正文的最大字符数,超出从尾部截断并标记 truncated。默认不限。'),
  },
  async ({ filePath, chapterId, maxLength }) => {
    let ctx
    try {
      ctx = await openBook(filePath)
      const mobi = ctx.mobi
      const chapter = mobi.loadChapter(chapterId)
      if (chapter === undefined) {
        return fail(`章节不存在:${chapterId}——请先用 parse-mobi 获取 spine 章节清单`)
      }
      const text = htmlToText(chapter.html)
      const limit = maxLength && maxLength > 0 ? maxLength : Number.MAX_SAFE_INTEGER
      const truncated = text.length > limit
      const body = truncated ? text.slice(0, limit) : text
      return ok(JSON.stringify({
        chapterId,
        charCount: text.length,
        truncated,
        text: body,
      }, null, 2))
    } catch (err) {
      return fail(`read-chapter 失败:${errText(err)}`)
    } finally {
      if (ctx) closeBook(ctx)
    }
  }
)

// ---------------------------------------------------------------------------
// Tool 3: get-toc
// ---------------------------------------------------------------------------
server.tool(
  'get-toc',
  '读取 MOBI/AZW3 书籍的目录树(TOC),返回层级结构:每项含 label(标题文字)与 href(内部链接);' +
    'href 可用 parse-mobi 的 spine 索引或 resolveHref 定位到具体章节。适合生成阅读器侧边目录导航。',
  {
    filePath: z.string().min(1).describe('宿主机上 MOBI 或 AZW3 文件的绝对路径(必填)。'),
  },
  async ({ filePath }) => {
    let ctx
    try {
      ctx = await openBook(filePath)
      const toc = ctx.mobi.getToc()
      return ok(JSON.stringify({ toc: Array.isArray(toc) ? toc : [] }, null, 2))
    } catch (err) {
      return fail(`get-toc 失败:${errText(err)}`)
    } finally {
      if (ctx) closeBook(ctx)
    }
  }
)

// ---------------------------------------------------------------------------
// Connect over stdio
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport()
await server.connect(transport)
