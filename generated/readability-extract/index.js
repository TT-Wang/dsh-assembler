/**
 * @dsh-index/readability-extract — MCP stdio server 包装 @mozilla/readability@0.5 + jsdom@24（MIT）。
 *
 * 上游库 Readability（Mozilla Firefox Reader View 同源算法）：
 *   - 从任意网页 HTML 中自动识别正文块，剥离导航、广告、页脚、脚本等噪音；
 *   - 输出标题、作者、站点名、摘要、正文纯文本，支持中文与英文页面。
 *
 * 工具（最终工具名 mcp__readability-extract__<tool>）：
 *   - extract-article : HTML → 正文结构化结果（title/byline/siteName/excerpt/textContent/length/lang）
 *   - extract-batch   : 用同一组选项批量提取多个 HTML 文档
 *
 * 实现为 ESM MCP stdio server，全部本地执行、无网络依赖。所有工具捕获异常并以
 * isError=true 的文本内容返回清晰错误，绝不向 LLM 抛未处理的内部堆栈。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const server = new McpServer({
  name: 'readability-extract',
  version: '0.0.1'
});

/** 把异常转成 MCP 文本错误内容（isError=true 便于调用方识别失败） */
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

/** 默认提取选项（与 Readability 官方默认一致，显式声明便于说明） */
const DEFAULT_OPTIONS = {
  charThreshold: 500, // 正文少于该字符数则判定提取失败（短页面/非文章页）
  nbTopCandidates: 5,
  maxElemsToParse: 0 // 0 = 不限制，全文解析
};

/**
 * 核心：HTML → 正文结构化结果。
 * @returns {{ok:true, article:object} | {ok:false, error:string}}
 */
function extractOne(html, options = {}, url) {
  let dom;
  try {
    dom = new JSDOM(html, { url: url || 'https://example.invalid/' });
  } catch (e) {
    return { ok: false, error: `HTML 解析失败：${e && e.message ? e.message : String(e)}` };
  }
  const merged = { ...DEFAULT_OPTIONS, ...options };
  let article;
  try {
    const reader = new Readability(dom.window.document, merged);
    article = reader.parse();
  } catch (e) {
    return { ok: false, error: `Readability 提取失败：${e && e.message ? e.message : String(e)}` };
  }
  if (!article) {
    return { ok: false, error: '未能识别正文：页面可能没有可提取的文章内容（导航页/空页/纯脚本页面）' };
  }
  const textContent = (article.textContent || '').trim();
  if (textContent.length < merged.charThreshold) {
    return {
      ok: false,
      error: `提取到的正文仅 ${textContent.length} 字符（阈值 ${merged.charThreshold}），页面可能不是文章页。原文摘录：${textContent.slice(0, 200)}`
    };
  }
  return {
    ok: true,
    article: {
      title: article.title || '',
      byline: article.byline || null,
      siteName: article.siteName || null,
      excerpt: article.excerpt || null,
      textContent,
      length: article.length ?? textContent.length,
      lang: article.lang || null,
      dir: article.dir || null
    }
  };
}

/* ------------------------------------------------------------------ */
/* 工具 1：extract-article — 从 HTML 提取正文                            */
/* ------------------------------------------------------------------ */
server.tool(
  'extract-article',
  '从网页 HTML 中自动提取正文（Readability 算法：自动识别正文块，剥离导航、广告、页脚、脚本等噪音），' +
    '输出标题、作者、站点名、摘要与正文纯文本，支持中文与英文页面。纯本地执行，无网络依赖。' +
    '参数：html（必填，网页 HTML 字符串，通常由 http-get 抓取得到）；url（可选，页面原始 URL，用于解析相对链接/元数据，不影响抓取）；' +
    'charThreshold（可选，正文最小字符数阈值，默认 500，低于阈值视为非文章页并返回错误）。' +
    '返回：JSON {title, byline, siteName, excerpt, textContent, length, lang, dir}；' +
    'textContent 为剥离噪音后的正文纯文本，可直接用于摘要、报告或入库。' +
    '典型用途：网页研究助手抓取网页后提取正文，去除导航/广告后再生成报告或存入数据库。',
  {
    html: z.string().min(1, 'html 不能为空'),
    url: z.string().optional(),
    charThreshold: z.number().int().positive().optional()
  },
  async (args) => {
    const missing = requireString(args, 'html', '网页 HTML');
    if (missing) return errContent('extract-article 参数错误', new Error(missing));
    try {
      const options = args.charThreshold !== undefined ? { charThreshold: args.charThreshold } : {};
      const result = extractOne(args.html, options, args.url);
      if (!result.ok) return errContent('extract-article 提取失败', new Error(result.error));
      return { content: [{ type: 'text', text: JSON.stringify(result.article) }] };
    } catch (err) {
      return errContent('extract-article 执行失败', err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* 工具 2：extract-batch — 批量提取                                     */
/* ------------------------------------------------------------------ */
server.tool(
  'extract-batch',
  '用同一组选项批量提取多个 HTML 文档的正文。纯本地执行，无网络依赖。' +
    '参数：items（必填，数组，每项 {html（必填）, url（可选）}）；charThreshold（可选，同 extract-article）。' +
    '返回：{results:[{index, ok, article|error}]}——单个失败不影响其他项，调用方按 index 对齐输入顺序。' +
    '典型用途：一次研究多个网页时批量剥离正文噪音。',
  {
    items: z
      .array(
        z.object({
          html: z.string().min(1, 'html 不能为空'),
          url: z.string().optional()
        })
      )
      .min(1, 'items 至少需要 1 项'),
    charThreshold: z.number().int().positive().optional()
  },
  async (args) => {
    try {
      const options = args.charThreshold !== undefined ? { charThreshold: args.charThreshold } : {};
      const results = args.items.map((item, index) => {
        const result = extractOne(item.html, options, item.url);
        return result.ok ? { index, ok: true, article: result.article } : { index, ok: false, error: result.error };
      });
      return { content: [{ type: 'text', text: JSON.stringify({ results }) }] };
    } catch (err) {
      return errContent('extract-batch 执行失败', err);
    }
  }
);

await server.connect(new StdioServerTransport());
