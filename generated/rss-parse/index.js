/**
 * @dsh-index/rss-parse — MCP stdio server 适配 rbren/rss-parser@3.13.0（MIT）。
 *
 * 工具（最终工具名 mcp__rss-parse__<tool>）：
 *   - parse-rss-string    : 解析 RSS(0.9/1.0/2.0)/Atom feed 的 XML 字符串 → 完整结构化 JSON（频道元数据 + items）
 *   - parse-rss-url       : 从 URL 抓取并解析 feed（http/https，自动跟随重定向，可设超时/请求头）→ 完整结构化 JSON
 *   - extract-feed-items  : 解析 feed 字符串 → 只返回紧凑条目列表（标题/链接/日期等），可限制条数
 *   - parse-feed-metadata : 解析 feed 字符串 → 只返回频道级元数据（title/description/link/itunes 等），不含条目
 *
 * 只读使用上游 rss-parser，不修改上游代码。实现为 ESM + stdio 通信。
 * 每个工具调用各自 new Parser(options)，无跨调用状态；三个字符串类工具纯本地解析（无需网络），
 * parse-rss-url 需要网络访问目标 feed。
 *
 * 参数 schema 用 zod 的 z.object({...})，经 server.registerTool(name, {inputSchema}, cb) 注册
 * （注：MCP SDK 1.30 的 server.tool() 运行时只接受"原始 shape"（{key: zod 字段}），不接受 z.object 实例；
 * registerTool 的 inputSchema 支持完整 zod schema，故用 registerTool 实现 z.object 规范）。
 *
 * 上游行为提示（与工具描述一致）：
 *   - parseString 自动识别 Atom（<feed>）、RSS 2.0（<rss version="2.x">）、RSS 1.0（<rdf:RDF>）、RSS 0.9；
 *     无法识别的 XML 报 "Feed not recognized as RSS 1 or 2."
 *   - item 常用字段：title/link/guid/pubDate/isoDate/creator/author/categories/summary/content/contentSnippet/enclosure；
 *     dc: 前缀字段会被去掉前缀；dc:date 与 pubDate 同时给出 isoDate（ISO 8601）
 *   - 输出为纯文本 JSON（本适配无二进制输出）
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Parser from 'rss-parser';

const server = new McpServer({
  name: 'rss-parse',
  version: '0.0.1'
});

/** 把用户可读的异常转成 MCP 文本错误内容（isError=true 便于调用方识别失败） */
function errContent(label, err) {
  const msg = err && err.message ? err.message : String(err);
  return { content: [{ type: 'text', text: `${label}: ${msg}` }], isError: true };
}

/** 校验必填字符串参数：缺失、非字符串、空白串都视为非法 */
function requireString(args, key, label) {
  const v = args[key];
  if (v === undefined || v === null) return `缺少必填参数 ${key}（${label}）`;
  if (typeof v !== 'string') return `参数 ${key}（${label}）类型错误：期望 string，实际为 ${typeof v}`;
  if (!v.trim()) return `参数 ${key}（${label}）为空字符串`;
  return null;
}

/**
 * 自定义字段参数归一化：rss-parser 的 customFields.item/feed 接受字符串字段名
 * 或 [源字段, 目标字段] 二元数组（重命名）。非法条目抛错（由调用方 try/catch 转错误文本）。
 */
function normalizeCustomFields(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      out.push(entry);
    } else if (Array.isArray(entry) && entry.length === 2 && entry.every((e) => typeof e === 'string')) {
      out.push([entry[0], entry[1]]);
    } else {
      throw new Error(
        `自定义字段条目必须是字符串字段名或 [源字段, 目标字段] 二元字符串数组，收到非法条目: ${JSON.stringify(entry)}`
      );
    }
  }
  return out;
}

/** 自定义字段参数（string 或 [from,to] 对），三个字符串工具共用 */
const CUSTOM_FIELD_LIST = z
  .array(
    z.union([
      z.string().min(1, '字段名不能为空'),
      z.tuple([z.string().min(1, '源字段不能为空'), z.string().min(1, '目标字段不能为空')])
    ])
  )
  .optional();

/** 工具 4 复用：从请求的自定义字段里取出目标键名（重命名对的第二个元素） */
function requestedCustomKeys(raw) {
  if (!Array.isArray(raw)) return [];
  const keys = [];
  for (const e of raw) {
    if (typeof e === 'string') keys.push(e);
    else if (Array.isArray(e) && e.length >= 2) keys.push(e[1]);
  }
  return keys;
}

/* ------------------------------------------------------------------ */
/* 工具 1：parse-rss-string — 解析 feed XML 字符串为完整 JSON           */
/* ------------------------------------------------------------------ */
server.registerTool(
  'parse-rss-string',
  {
    description:
      '解析一段 RSS（0.9/1.0/2.0）或 Atom feed 的 XML 字符串为完整结构化 JSON（频道元数据 + items 条目列表），纯本地解析、无需网络。' +
      '参数：xml（必填，feed 的 XML 内容字符串）、customFeedFields（可选，额外提取的频道级自定义字段名数组，如 ["itunes:author"]；也支持 [源字段, 目标字段] 重命名对）、' +
      'customItemFields（可选，额外提取的条目级自定义字段名数组，如 ["media:content"]；支持 [源字段, 目标字段] 重命名对）、' +
      'defaultRss（可选，仅当 XML 缺少 rss version 属性时生效：0.9 / 1 / 2）。' +
      '返回：{feed:{title, description, link, feedUrl, lastBuildDate, image?, paginationLinks?, itunes?, items:[{title, link, guid, pubDate, isoDate, creator, summary, content, contentSnippet, categories, enclosure?}]}}。' +
      '典型用途：把读到的 feed 字符串转成结构化数据以便检索条目、展示标题/链接/日期、提取频道信息；无法识别的 XML 返回清晰错误。',
    inputSchema: z.object({
      xml: z.string().min(1, 'xml 不能为空'),
      customFeedFields: CUSTOM_FIELD_LIST,
      customItemFields: CUSTOM_FIELD_LIST,
      defaultRss: z.union([z.literal(0.9), z.literal(1), z.literal(2)]).optional()
    })
  },
  async (args) => {
    const missing = requireString(args, 'xml', 'feed 的 XML 字符串');
    if (missing) return errContent('parse-rss-string 参数错误', new Error(missing));
    try {
      const options = {};
      if (args.defaultRss !== undefined) options.defaultRSS = args.defaultRss;
      if (args.customFeedFields !== undefined || args.customItemFields !== undefined) {
        options.customFields = {
          feed: args.customFeedFields !== undefined ? normalizeCustomFields(args.customFeedFields) : [],
          item: args.customItemFields !== undefined ? normalizeCustomFields(args.customItemFields) : []
        };
      }
      const parser = new Parser(options);
      const feed = await parser.parseString(args.xml);
      return { content: [{ type: 'text', text: JSON.stringify({ feed }) }] };
    } catch (err) {
      return errContent('parse-rss-string 执行失败', err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* 工具 2：parse-rss-url — 从 URL 抓取并解析 feed                       */
/* ------------------------------------------------------------------ */
server.registerTool(
  'parse-rss-url',
  {
    description:
      '从 URL 抓取 RSS/Atom feed 并解析为完整结构化 JSON（频道元数据 + items 条目列表），需要网络访问目标地址（http/https）。' +
      '参数：url（必填，feed 的 http/https 地址）、timeoutMs（可选，请求超时毫秒数，默认 60000）、maxRedirects（可选，最大重定向次数，默认 5，范围 0-20）、' +
      'headers（可选，附加 HTTP 请求头对象，如 {"User-Agent":"..."}，默认 User-Agent=rss-parser / Accept=application/rss+xml）。' +
      '返回：{feed:{title, description, link, feedUrl, lastBuildDate, image?, paginationLinks?, itunes?, items:[...]}}（结构与 parse-rss-string 相同）。' +
      '典型用途：给定订阅源地址获取最新条目与频道信息；3xx 重定向自动跟随（超过 maxRedirects 报 "Too many redirects"），非 2xx/3xx 状态码、超时与网络错误返回清晰错误。',
    inputSchema: z.object({
      url: z.string().min(1, 'url 不能为空'),
      timeoutMs: z.number().int().positive().max(300000).optional(),
      maxRedirects: z.number().int().min(0).max(20).optional(),
      headers: z.record(z.string(), z.string()).optional()
    })
  },
  async (args) => {
    const missing = requireString(args, 'url', 'feed 的 http/https 地址');
    if (missing) return errContent('parse-rss-url 参数错误', new Error(missing));
    if (!/^https?:\/\//i.test(args.url)) {
      return errContent('parse-rss-url 参数错误', new Error(`仅支持 http/https 协议地址，收到: ${args.url.slice(0, 80)}`));
    }
    try {
      const options = {};
      if (args.timeoutMs !== undefined) options.timeout = args.timeoutMs;
      if (args.maxRedirects !== undefined) options.maxRedirects = args.maxRedirects;
      if (args.headers !== undefined) options.headers = args.headers;
      const parser = new Parser(options);
      const feed = await parser.parseURL(args.url);
      return { content: [{ type: 'text', text: JSON.stringify({ feed }) }] };
    } catch (err) {
      return errContent('parse-rss-url 执行失败', err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* 工具 3：extract-feed-items — 只返回紧凑条目列表                      */
/* ------------------------------------------------------------------ */
server.registerTool(
  'extract-feed-items',
  {
    description:
      '解析 RSS/Atom feed 的 XML 字符串并只返回紧凑条目列表（每条含 title/link/guid/pubDate/isoDate/creator/author/categories/summary/contentSnippet 等，不含大段 HTML content），纯本地解析、无需网络。' +
      '参数：xml（必填，feed 的 XML 内容字符串）、limit（可选，最多返回的条目数，正整数，默认返回全部）、customItemFields（可选，额外提取的条目级自定义字段名数组或 [源字段, 目标字段] 重命名对）。' +
      '返回：{count, items:[{title, link, guid, pubDate, isoDate, creator, author, categories, summary, contentSnippet, ...}]}。' +
      '典型用途：只需要订阅源的条目标题/链接/日期清单（如展示"最新 10 条"）时比完整解析更省输出；isoDate 为 ISO 8601 字符串可直接比较排序。',
    inputSchema: z.object({
      xml: z.string().min(1, 'xml 不能为空'),
      limit: z.number().int().positive().optional(),
      customItemFields: CUSTOM_FIELD_LIST
    })
  },
  async (args) => {
    const missing = requireString(args, 'xml', 'feed 的 XML 字符串');
    if (missing) return errContent('extract-feed-items 参数错误', new Error(missing));
    try {
      const options = {};
      if (args.customItemFields !== undefined) {
        options.customFields = { feed: [], item: normalizeCustomFields(args.customItemFields) };
      }
      const parser = new Parser(options);
      const feed = await parser.parseString(args.xml);
      const extraKeys = requestedCustomKeys(args.customItemFields);
      const COMPACT_KEYS = [
        'title', 'link', 'guid', 'pubDate', 'isoDate', 'creator', 'author',
        'categories', 'summary', 'contentSnippet', 'id', 'enclosure'
      ];
      let items = (feed.items || []).map((it) => {
        const out = {};
        for (const k of [...COMPACT_KEYS, ...extraKeys]) {
          if (it[k] !== undefined) out[k] = it[k];
        }
        return out;
      });
      if (args.limit !== undefined) items = items.slice(0, args.limit);
      return { content: [{ type: 'text', text: JSON.stringify({ count: items.length, items }) }] };
    } catch (err) {
      return errContent('extract-feed-items 执行失败', err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* 工具 4：parse-feed-metadata — 只返回频道级元数据                     */
/* ------------------------------------------------------------------ */
server.registerTool(
  'parse-feed-metadata',
  {
    description:
      '解析 RSS/Atom feed 的 XML 字符串并只返回频道级元数据（title/description/link/feedUrl/lastBuildDate/language/copyright/image/paginationLinks/itunes 等），不含条目列表，纯本地解析、无需网络。' +
      '参数：xml（必填，feed 的 XML 内容字符串）、customFeedFields（可选，额外提取的频道级自定义字段名数组或 [源字段, 目标字段] 重命名对，如 ["itunes:author"]）。' +
      '返回：{metadata:{title, description, link, feedUrl, lastBuildDate, language, copyright, generator, image?, paginationLinks?, itunes?, ...}}。' +
      '典型用途：判断一个 feed 是什么（站点名/描述/主页/图标）、读取播客 itunes 元数据、获取分页链接（self/first/next/prev/last）；输出体积小、不含条目。',
    inputSchema: z.object({
      xml: z.string().min(1, 'xml 不能为空'),
      customFeedFields: CUSTOM_FIELD_LIST
    })
  },
  async (args) => {
    const missing = requireString(args, 'xml', 'feed 的 XML 字符串');
    if (missing) return errContent('parse-feed-metadata 参数错误', new Error(missing));
    try {
      const options = {};
      if (args.customFeedFields !== undefined) {
        options.customFields = { feed: normalizeCustomFields(args.customFeedFields), item: [] };
      }
      const parser = new Parser(options);
      const feed = await parser.parseString(args.xml);
      const { items, ...metadata } = feed;
      return { content: [{ type: 'text', text: JSON.stringify({ metadata }) }] };
    } catch (err) {
      return errContent('parse-feed-metadata 执行失败', err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* 启动 stdio 服务器                                                    */
/* ------------------------------------------------------------------ */
const transport = new StdioServerTransport();
await server.connect(transport);
