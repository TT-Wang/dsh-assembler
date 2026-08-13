#!/usr/bin/env node
/**
 * @dsh-index/fuzzy-search — MCP stdio server wrapping fuse.js v7.0.0
 * (upstream: krisk/Fuse @ v7.0.0, Apache-2.0).
 *
 * Tools:
 *   - fuzzy-search            one-shot fuzzy search over a document array
 *   - fuse-create-index       precompute a reusable JSON search index
 *   - fuse-search-with-index  search using a precomputed index
 *   - fuse-config             return Fuse.js default option values
 *
 * Note (MCP SDK >= 1.9): server.tool() param schemas MUST be zod shapes
 * (z.object / ZodRawShape); plain JSON Schema objects throw at startup.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import Fuse from 'fuse.js'
import { z } from 'zod'

const SERVER = {
  name: '@dsh-index/fuzzy-search',
  version: '0.0.1'
}

/* ------------------------------------------------------------------ */
/* zod shapes (LLM-facing descriptions live here)                      */
/* ------------------------------------------------------------------ */

const documentsSchema = z
  .array(z.any())
  .min(1)
  .describe('要搜索的文档数组：必须同质——全部为字符串，或全部为对象（对象需配合 keys 指定搜索字段）')

const keysSchema = z
  .array(
    z.union([
      z.string().describe('要搜索的字段路径，支持嵌套，如 "author.name"'),
      z
        .object({
          name: z
            .union([z.string(), z.array(z.string())])
            .describe('字段路径（可为字符串或路径数组）'),
          weight: z
            .number()
            .positive()
            .optional()
            .describe('该字段的相对权重，越大越重要（默认 1）')
        })
        .describe('带权重的字段键')
    ])
  )
  .optional()
  .default([])
  .describe('要搜索的字段键列表；documents 为字符串数组时留空即可')

const searchOptionsShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .default(20)
    .describe('最多返回多少条结果（默认 20）'),
  includeScore: z
    .boolean()
    .optional()
    .describe('结果是否包含相关度分数 score（0=完全匹配，1=完全不匹配；默认 true）'),
  includeMatches: z
    .boolean()
    .optional()
    .describe('结果是否包含匹配字符的起止区间 indices（可用于高亮；默认 false）'),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('匹配严格度：0.0 要求完全匹配（字母与位置），1.0 匹配任何内容；默认 0.6'),
  isCaseSensitive: z
    .boolean()
    .optional()
    .describe('是否大小写敏感（默认 false，即忽略大小写）'),
  ignoreLocation: z
    .boolean()
    .optional()
    .describe('为 true 时忽略 location 与 distance，模式可出现在文本任意位置（默认 false）'),
  ignoreFieldNorm: z
    .boolean()
    .optional()
    .describe('为 true 时打分忽略字段长度归一化（默认 false）'),
  fieldNormWeight: z
    .number()
    .min(0)
    .optional()
    .describe('字段长度归一化对打分的影响权重：0 等价于忽略，2.0 大幅增强（默认 1）'),
  shouldSort: z
    .boolean()
    .optional()
    .describe('是否按相关度分数升序排序结果（默认 true）'),
  distance: z
    .number()
    .min(0)
    .optional()
    .describe('模糊位置容差：匹配允许离 location 多远（默认 100）'),
  location: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('模式预计在文本中出现的大致位置（默认 0）'),
  minMatchCharLength: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('匹配长度低于该值的匹配将被忽略（默认 1）'),
  findAllMatches: z
    .boolean()
    .optional()
    .describe('找到完美匹配后是否继续匹配模式的其余部分（默认 false）'),
  useExtendedSearch: z
    .boolean()
    .optional()
    .describe('启用扩展搜索语法：^ 前缀匹配、! 精确匹配、= 短语匹配、| 或运算、$ 后缀匹配（默认 false）')
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const SEARCH_OPTION_KEYS = [
  'includeScore',
  'includeMatches',
  'threshold',
  'isCaseSensitive',
  'ignoreLocation',
  'ignoreFieldNorm',
  'fieldNormWeight',
  'shouldSort',
  'distance',
  'location',
  'minMatchCharLength',
  'findAllMatches',
  'useExtendedSearch'
]

/** Pull only recognized Fuse options (limit is handled separately). */
function pickSearchOptions(input, defaults = {}) {
  const opts = { ...defaults }
  for (const key of SEARCH_OPTION_KEYS) {
    if (input[key] !== undefined) opts[key] = input[key]
  }
  if (input.keys !== undefined) opts.keys = input.keys
  return opts
}

function validateDocuments(documents) {
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error('documents 必须是非空数组')
  }
  const allStrings = documents.every((d) => typeof d === 'string')
  const allObjects = documents.every(
    (d) => d !== null && typeof d === 'object' && !Array.isArray(d)
  )
  if (!allStrings && !allObjects) {
    throw new Error(
      'documents 必须是同质列表：全部为字符串，或全部为普通对象（当前混用了类型或包含非法元素）'
    )
  }
}

function formatResults(tool, query, results, includeMatches) {
  const out = results.map((r) => {
    const o = { refIndex: r.refIndex, score: r.score, item: r.item }
    if (includeMatches && r.matches) o.matches = r.matches
    return o
  })
  return JSON.stringify({ tool, query, count: out.length, results: out }, null, 2)
}

function text(content) {
  return { content: [{ type: 'text', text: content }] }
}

function fail(message) {
  return { content: [{ type: 'text', text: `错误：${message}` }], isError: true }
}

function runSearch(tool, documents, query, opts) {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new Error('query 必须是非空字符串')
  }
  validateDocuments(documents)
  const fuse = new Fuse(documents, opts)
  const results = fuse.search(query, { limit: opts.limit })
  return formatResults(tool, query, results, opts.includeMatches === true)
}

/* ------------------------------------------------------------------ */
/* server + tools                                                      */
/* ------------------------------------------------------------------ */

const server = new McpServer(SERVER)

server.tool(
  'fuzzy-search',
  '对文档数组执行一次性的模糊搜索（Fuse.js v7）。输入 documents（字符串数组或对象数组）与 query 模式串；可选 keys 指定在对象的哪些字段上搜索（支持嵌套路径与权重），threshold/ignoreLocation 等选项控制匹配严格度。返回按相关度升序排列的结果列表，每条结果含 refIndex（文档在原数组中的下标）、score（0=完全匹配，1=完全不匹配）与 item（命中的原文或对象）；includeMatches 开启时另含匹配字符区间 indices（可用于高亮）。适合“从列表中找出与某模式最接近的若干项”。',
  {
    documents: documentsSchema,
    query: z.string().min(1).describe('要匹配的搜索模式串'),
    keys: keysSchema,
    ...searchOptionsShape
  },
  async (params) => {
    try {
      const opts = pickSearchOptions(params, {
        includeScore: params.includeScore ?? true
      })
      return text(runSearch('fuzzy-search', params.documents, params.query, opts))
    } catch (e) {
      return fail(e.message)
    }
  }
)

server.tool(
  'fuse-create-index',
  '为文档集预计算 Fuse.js 可复用的搜索索引，返回可序列化的 JSON（{ keys, records }）。对同一批文档执行多次搜索时，先用本工具建立索引，再把返回的 index 与完全相同的 documents 传给 fuse-search-with-index，从而复用索引、避免每次重复构建。注意：索引与 documents 必须一一对应（同一顺序、同一内容）。',
  {
    documents: documentsSchema,
    keys: keysSchema,
    fieldNormWeight: z
      .number()
      .min(0)
      .optional()
      .describe('索引归一化权重，应与后续搜索保持一致（默认 1）')
  },
  async (params) => {
    try {
      validateDocuments(params.documents)
      const index = Fuse.createIndex(params.keys ?? [], params.documents, {
        fieldNormWeight: params.fieldNormWeight
      })
      const json = index.toJSON()
      return text(
        JSON.stringify(
          {
            tool: 'fuse-create-index',
            docCount: params.documents.length,
            index: json
          },
          null,
          2
        )
      )
    } catch (e) {
      return fail(e.message)
    }
  }
)

server.tool(
  'fuse-search-with-index',
  '使用 fuse-create-index 生成的 JSON 索引对同一文档集执行模糊搜索。输入 index（{keys, records}，取自 fuse-create-index 的输出）、与建索引时完全一致的 documents 数组、query 及可选搜索选项，返回与 fuzzy-search 相同格式（含 refIndex/score/item）的排序结果。适合对固定数据集反复查询的场景。',
  {
    index: z
      .object({
        keys: z.array(z.any()),
        records: z.array(z.any())
      })
      .describe('fuse-create-index 返回的 index 对象（{keys, records}）'),
    documents: documentsSchema,
    query: z.string().min(1).describe('要匹配的搜索模式串'),
    ...searchOptionsShape
  },
  async (params) => {
    try {
      validateDocuments(params.documents)
      const opts = pickSearchOptions(params, {
        includeScore: params.includeScore ?? true
      })
      const parsedIndex = Fuse.parseIndex(params.index)
      const fuse = new Fuse(params.documents, opts, parsedIndex)
      const results = fuse.search(params.query, { limit: opts.limit })
      return text(
        formatResults('fuse-search-with-index', params.query, results, opts.includeMatches === true)
      )
    } catch (e) {
      return fail(e.message)
    }
  }
)

server.tool(
  'fuse-config',
  '返回 Fuse.js 的默认配置（Fuse.config），包含 includeMatches、includeScore、threshold、distance、location、keys、useExtendedSearch、isCaseSensitive、ignoreFieldNorm、fieldNormWeight、shouldSort、minMatchCharLength 等全部选项的默认值，供调用方在发起搜索前了解各选项的默认行为。注意：函数类型的字段（sortFn、getFn）无法序列化，会被省略。',
  {},
  async () => {
    try {
      const cfg = Fuse.config
      const out = {}
      for (const [key, value] of Object.entries(cfg)) {
        if (typeof value === 'function') continue
        out[key] = value
      }
      return text(JSON.stringify({ tool: 'fuse-config', config: out }, null, 2))
    } catch (e) {
      return fail(e.message)
    }
  }
)

/* ------------------------------------------------------------------ */
/* bootstrap                                                           */
/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport()
await server.connect(transport)

// Clean shutdown: once the client closes stdin, finish pending writes and exit.
process.stdin.on('end', () => {
  server
    .close()
    .catch(() => {})
    .finally(() => process.exit(0))
})
