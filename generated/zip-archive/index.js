/**
 * @dsh-index/zip-archive — MCP stdio server exposing adm-zip (v0.5.12) as tools.
 *
 * 能力 id: zip-archive  (上游: cthackers/adm-zip @ v0.5.12, MIT)
 *
 * Tools (mcp 客户端调用名为 mcp__zip-archive__<tool>):
 *   zip-list-entries   — 列出 zip 归档内的全部条目（文件/目录）及元信息
 *   zip-read-file      — 读取 zip 内指定条目的内容（文本或 base64 二进制）
 *   zip-create-archive — 由一组内存文件（名称+内容）创建 zip，返回 base64
 *   zip-update-archive — 在已有 zip 上增/改/删条目并重新打包，返回新 base64
 *
 * 所有 zip 数据以 base64 字符串在工具间传递（内存形态，不落盘）。
 * 受 MCP stdio 消息大小限制（默认约 4MB，base64 膨胀 1.33 倍），
 * 单次传入的 zip / 文件内容建议 < 2MB；超大归档请改用磁盘方案。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import AdmZip from 'adm-zip'

const server = new McpServer({ name: 'zip-archive', version: '0.0.1' })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 将 base64 字符串解析为 Buffer。空串返回 null（表示"新建空归档"）。
 * @param {string} b64
 * @param {string} label 出错时用于提示的参数名
 * @returns {Buffer|null}
 */
function parseB64(b64, label) {
  if (b64 === undefined || b64 === null) return null
  if (typeof b64 !== 'string') {
    throw new Error(`${label}: 必须为 base64 字符串，实际类型 ${typeof b64}`)
  }
  const clean = b64.replace(/\s+/g, '')
  if (clean === '') return null
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) {
    throw new Error(`${label}: base64 格式无效（需标准 base64，可含换行，不接受 data: URL 前缀）`)
  }
  return Buffer.from(clean, 'base64')
}

/**
 * 归一化 zip 内的条目路径：反斜杠转正斜杠、去掉前导 "/"。
 * 保留结尾 "/"（adm-zip 以结尾斜杠标识目录条目）。
 * @param {string} name
 * @returns {string}
 */
function normalizeEntryName(name) {
  const n = String(name).replace(/\\/g, '/').replace(/^\/+/, '')
  if (!n) throw new Error('条目名称不能为空')
  return n
}

/**
 * 将条目内容（字符串）按编码转成 Buffer。
 * @param {string} content
 * @param {'utf8'|'base64'} encoding
 * @returns {Buffer}
 */
function contentToBuffer(content, encoding) {
  if (typeof content !== 'string') {
    throw new Error(`files[].content 必须为字符串，实际类型 ${typeof content}`)
  }
  return encoding === 'base64'
    ? (() => {
        const buf = parseB64(content, 'files[].content')
        if (!buf) throw new Error('files[].content: base64 内容为空')
        return buf
      })()
    : Buffer.from(content, 'utf8')
}

/**
 * 将 AdmZip 条目列表转成可序列化的元信息数组。
 * @param {AdmZip} zip
 * @returns {Array<object>}
 */
function describeEntries(zip) {
  return zip.getEntries().map((e) => ({
    entryName: e.entryName,
    name: e.name,
    isDirectory: e.isDirectory,
    size: e.header ? e.header.size : 0,
    compressedSize: e.header ? e.header.compressedSize : 0,
    method: e.header ? e.header.method : null, // 0=STORED, 8=DEFLATED
    crc32: e.header ? `0x${(e.header.crc >>> 0).toString(16)}` : null,
    comment: e.comment || '',
  }))
}

/** 构造标准 MCP 文本结果。 */
function textResult(text) {
  return { content: [{ type: 'text', text }] }
}

/** 构造标准 MCP 错误结果（isError=true，消息清晰可读）。 */
function errorResult(message) {
  return { isError: true, content: [{ type: 'text', text: `错误: ${message}` }] }
}

/** 包一层 try/catch：任何异常都转为清晰的错误结果文本。 */
function guard(fn) {
  return (args) => {
    try {
      return fn(args)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * zip-list-entries — 列出 zip 归档的全部条目及元信息。
 */
server.tool(
  'zip-list-entries',
  '列出 zip 归档中的全部条目（文件与目录）及其元信息：条目路径 entryName、文件名 name、' +
    '是否目录 isDirectory、原始大小 size、压缩后大小 compressedSize、压缩方式 method（0=STORED/8=DEFLATED）、' +
    'CRC32 校验值、条目注释 comment。' +
    '参数 zip 为 zip 文件的 base64 编码（可直接使用 zip-create-archive / zip-update-archive 的输出，' +
    '或对任意 .zip 文件执行 base64 编码获得）。password 可选，用于读取加密归档的元信息。' +
    '返回 JSON：{count, entries:[{entryName,name,isDirectory,size,compressedSize,method,crc32,comment}]}。' +
    '归档损坏或 base64 非法时返回清晰错误文本。',
  {
    zip: z
      .string()
      .optional()
      .describe('zip 文件的 base64 编码字符串（留空表示新建空归档）'),
    password: z.string().optional().describe('可选：加密归档的解密密码'),
  },
  guard(({ zip, password }) => {
    const buf = parseB64(zip, 'zip')
    const adm = buf ? new AdmZip(buf) : new AdmZip()
    const entries = describeEntries(adm)
    return textResult(
      JSON.stringify(
        { count: entries.length, entries },
        null,
        2
      )
    )
  })
)

/**
 * zip-read-file — 读取 zip 内指定条目的内容。
 */
server.tool(
  'zip-read-file',
  '读取 zip 归档内指定条目的内容并返回。' +
    '参数 zip 为 zip 文件的 base64 编码；entry 为条目路径（与 zip-list-entries 输出的 entryName 一致，' +
    '如 "docs/readme.txt"，不含前导斜杠）。' +
    'encoding 决定返回格式：utf8（默认）将内容按 UTF-8 解码为文本；base64 返回原始二进制内容的 base64 编码（适合非文本文件）。' +
    'password 可选，用于解密加密条目。' +
    '返回 JSON：{entry, isDirectory, encoding, content, size}。' +
    '条目不存在、条目是目录、或解密失败时返回清晰错误文本。',
  {
    zip: z
      .string()
      .optional()
      .describe('zip 文件的 base64 编码字符串'),
    entry: z.string().describe('要读取的条目路径（zip 内相对路径，如 "docs/readme.txt"）'),
    encoding: z
      .enum(['utf8', 'base64'])
      .optional()
      .describe('内容返回编码：utf8（默认，解码为文本）或 base64（返回二进制）'),
    password: z.string().optional().describe('可选：加密条目的解密密码'),
  },
  guard(({ zip, entry, encoding = 'utf8', password }) => {
    const name = normalizeEntryName(entry)
    const buf = parseB64(zip, 'zip')
    const adm = buf ? new AdmZip(buf) : new AdmZip()
    const item = adm.getEntry(name)
    if (!item) {
      throw new Error(`归档中不存在条目 "${name}"，可用 zip-list-entries 查看实际条目`)
    }
    if (item.isDirectory) {
      throw new Error(`"${name}" 是目录，不是文件；请用 zip-list-entries 查看目录结构`)
    }
    const data = item.getData(password)
    if (!data) {
      throw new Error(`无法读取条目 "${name}" 的数据（可能已损坏或密码错误）`)
    }
    const out =
      encoding === 'base64' ? data.toString('base64') : data.toString('utf8')
    return textResult(
      JSON.stringify(
        {
          entry: name,
          isDirectory: false,
          encoding,
          content: out,
          size: data.length,
        },
        null,
        2
      )
    )
  })
)

/**
 * zip-create-archive — 由内存中的一组文件创建 zip 归档。
 */
server.tool(
  'zip-create-archive',
  '由内存中的一组文件创建 zip 归档，返回新归档的 base64 编码。' +
    '参数 files 为文件数组，每项 {name, content, comment?, encoding?}：' +
    'name 为归档内条目路径（用 "/" 分隔目录，如 "src/main.js"；注意 adm-zip 不会为文件路径隐式创建目录条目，' +
    '如需目录请显式加入 name 以 "/" 结尾、content 为空的条目，如 "docs/"）；' +
    'content 为文件内容字符串；encoding 可选，指定该条目 content 的解释方式：utf8（默认，直接按文本写入）或 base64（content 为二进制内容的 base64）；' +
    'comment 可选，为该条目添加注释。压缩方式默认 DEFLATE（zip 标准）。' +
    '返回 JSON：{zip（base64 字符串）, count, entries:[{entryName,name,isDirectory,size,compressedSize,method}]}。' +
    '返回的 zip 可直接传给 zip-list-entries / zip-read-file / zip-update-archive，或由调用方 base64 解码落盘。' +
    '参数非法（空文件名、非字符串内容、非法 base64）时返回清晰错误文本。',
  {
    files: z
      .array(
        z.object({
          name: z.string().describe('归档内条目路径，如 "src/main.js"；以 "/" 结尾表示目录（目录需显式声明）'),
          content: z.string().describe('文件内容（按本条目 encoding 字段解释）'),
          comment: z.string().optional().describe('可选：条目注释'),
          encoding: z
            .enum(['utf8', 'base64'])
            .optional()
            .describe('可选：本条目 content 的解释编码，utf8（默认）或 base64（二进制内容）'),
        })
      )
      .min(1)
      .describe('要写入归档的文件列表（至少 1 个）'),
  },
  guard(({ files }) => {
    const adm = new AdmZip()
    for (const f of files) {
      const name = normalizeEntryName(f.name)
      const buf = contentToBuffer(f.content, f.encoding || 'utf8')
      adm.addFile(name, buf, f.comment || '')
    }
    const zipData = adm.toBuffer()
    const entries = describeEntries(adm)
    return textResult(
      JSON.stringify(
        {
          zip: zipData.toString('base64'),
          count: entries.length,
          entries,
        },
        null,
        2
      )
    )
  })
)

/**
 * zip-update-archive — 在已有 zip 归档上增/改/删条目并重新打包。
 */
server.tool(
  'zip-update-archive',
  '对已有的 zip 归档做增、改、删操作并返回重新打包后的新归档 base64。' +
    '参数 zip 为原归档的 base64 编码（来自 zip-create-archive 输出或外部 .zip 文件编码）。' +
    'addOrUpdate 可选：文件数组，每项 {name, content, comment?, encoding?}，语义与 zip-create-archive 的 files 相同；' +
    '同名条目会被覆盖更新，新名字会新增；目录条目同样需显式以 "/" 结尾声明。' +
    'delete 可选：要从归档中移除的条目路径数组（仅文件；目录条目请逐个删除或使用文件列表）。' +
    'comment 可选：设置归档级注释（替换原有注释；传 null/省略不清除）。' +
    '返回 JSON：{zip（新归档 base64）, count, entries:[...]}。' +
    '原归档非法、条目不存在或参数非法时返回清晰错误文本。',
  {
    zip: z.string().optional().describe('原 zip 归档的 base64 编码字符串'),
    addOrUpdate: z
      .array(
        z.object({
          name: z.string().describe('归档内条目路径，如 "src/main.js"；以 "/" 结尾表示目录（目录需显式声明）'),
          content: z.string().describe('文件内容（按本条目 encoding 字段解释）'),
          comment: z.string().optional().describe('可选：条目注释'),
          encoding: z
            .enum(['utf8', 'base64'])
            .optional()
            .describe('可选：本条目 content 的解释编码，utf8（默认）或 base64（二进制内容）'),
        })
      )
      .optional()
      .describe('要新增或覆盖的条目列表'),
    delete: z
      .array(z.string())
      .optional()
      .describe('要删除的条目路径列表（zip 内相对路径）'),
    comment: z.string().nullable().optional().describe('可选：设置归档级注释（null 表示不清除）'),
  },
  guard(({ zip, addOrUpdate, delete: del, comment }) => {
    const buf = parseB64(zip, 'zip')
    if (!buf) {
      throw new Error('缺少原归档：zip 参数不能为空（请先提供已有 zip 的 base64）')
    }
    const adm = new AdmZip(buf)

    if (comment !== undefined && comment !== null) {
      adm.addZipComment(String(comment))
    }

    for (const f of addOrUpdate || []) {
      const name = normalizeEntryName(f.name)
      const bufContent = contentToBuffer(f.content, f.encoding || 'utf8')
      adm.addFile(name, bufContent, f.comment || '')
    }

    for (const d of del || []) {
      const name = normalizeEntryName(d)
      const existed = adm.getEntry(name)
      if (!existed) {
        throw new Error(`无法删除：归档中不存在条目 "${name}"`)
      }
      adm.deleteFile(name)
    }

    const zipData = adm.toBuffer()
    const entries = describeEntries(adm)
    return textResult(
      JSON.stringify(
        {
          zip: zipData.toString('base64'),
          count: entries.length,
          entries,
          zipComment: adm.getZipComment() || '',
        },
        null,
        2
      )
    )
  })
)

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport()
await server.connect(transport)
