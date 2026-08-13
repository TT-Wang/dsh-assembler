/**
 * @dsh-index/html-parse — MCP stdio server wrapping cheerio@1.0.0-rc.12.
 *
 * Tools (最终工具名 mcp__html-parse__<tool>):
 *   - extract-text        : 解析 HTML，提取匹配元素（或整篇文档）的文本内容
 *   - extract-attributes  : 解析 HTML，提取匹配元素上的指定属性值
 *   - query-elements      : 解析 HTML，按 CSS 选择器列出匹配元素的结构信息
 *   - serialize-html      : 解析 HTML/XML 并重新序列化为规范化标记文本
 *
 * 只读使用上游库（cheerio），不修改上游代码。实现为 ESM，stdio 通信。
 * 每个工具内部按调用参数独立 load()，无跨调用状态；全部本地执行，无网络依赖。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as cheerio from 'cheerio';

const server = new McpServer({
  name: 'html-parse',
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
  if (v === undefined || v === null) {
    return `缺少必填参数 ${key}（${label}）`;
  }
  if (typeof v !== 'string') {
    return `参数 ${key}（${label}）类型错误：期望 string，实际为 ${typeof v}`;
  }
  if (!v.trim()) {
    return `参数 ${key}（${label}）为空字符串`;
  }
  return null;
}

/** 加载 HTML，默认使用 fragment 模式（不注入 html/head/body 包装），避免干扰选择器结果 */
function loadHtml(html, { xml = false, fragment = true } = {}) {
  const options = xml ? { xmlMode: true } : undefined;
  // cheerio.load 第三参 isDocument：true=文档模式（会注入 html/head/body），false=片段模式
  return cheerio.load(html, options, !fragment);
}

/** 统一的文本规范化：折叠空白 + 可选截断 */
function normalizeText(text, { collapse = false, maxLength = 100000 } = {}) {
  let out = text ?? '';
  if (collapse) {
    out = out.replace(/\s+/g, ' ').trim();
  }
  if (out.length > maxLength) {
    out = `${out.slice(0, maxLength)}\n…[已截断，原长度 ${text.length} 字符]`;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 工具 1：extract-text — 提取文本                                     */
/* ------------------------------------------------------------------ */
server.tool(
  'extract-text',
  '解析 HTML 文档并提取文本内容。若不提供 selector，返回整篇文档的全部文本；否则返回所有匹配元素文本的拼接（jQuery/cheerio 语义：父元素会包含子元素文本）。' +
    '参数：html（必填，待解析的 HTML 标记字符串）、selector（可选，CSS 选择器，如 "h1"、"ul li.price"、"a[href^=https]"，缺省取整篇文档）、' +
    'collapseWhitespace（可选，默认 false，true 时将连续空白折叠为单个空格并去除首尾空白）、maxLength（可选，默认 100000，输出截断上限）。' +
    '返回：纯文本字符串（json 包装为 {text}）。适用于从抓取的 HTML 中抽取可读文本、标题、正文等。',
  {
    html: z.string().min(1, 'html 不能为空'),
    selector: z.string().optional(),
    collapseWhitespace: z.boolean().optional(),
    maxLength: z.number().int().positive().optional()
  },
  async (args) => {
    const missing = requireString(args, 'html', '待解析的 HTML 标记');
    if (missing) return errContent('extract-text 参数错误', new Error(missing));

    try {
      const $ = loadHtml(args.html);
      let text;
      if (args.selector && args.selector.trim()) {
        const matches = $(args.selector);
        if (matches.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  text: '',
                  matched: 0,
                  note: `选择器 "${args.selector}" 未匹配到任何元素`
                })
              }
            ]
          };
        }
        text = matches.text();
      } else {
        text = $.root().text();
      }
      const out = normalizeText(text, {
        collapse: !!args.collapseWhitespace,
        maxLength: args.maxLength ?? 100000
      });
      return { content: [{ type: 'text', text: JSON.stringify({ text: out }) }] };
    } catch (err) {
      return errContent('extract-text 执行失败', err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* 工具 2：extract-attributes — 提取元素属性                            */
/* ------------------------------------------------------------------ */
server.tool(
  'extract-attributes',
  '解析 HTML 并按 CSS 选择器定位元素，提取每个匹配元素的指定属性值（如 href、src、class、data-*）。' +
    '参数：html（必填）、selector（必填，CSS 选择器）、attributes（可选，属性名数组，如 ["href","title"]；缺省返回元素全部属性）、' +
    'maxResults（可选，默认 100，最多返回的匹配元素个数）。' +
    '返回：{matched, results:[{index, tag, attrs:{属性名:值}}]}，仅包含目标元素上实际存在的属性；未匹配时 matched=0。' +
    '典型用途：批量抽取链接（a[href]）、图片地址（img[src]）、表单字段等。',
  {
    html: z.string().min(1, 'html 不能为空'),
    selector: z.string().min(1, 'selector 不能为空'),
    attributes: z.array(z.string().min(1)).optional(),
    maxResults: z.number().int().positive().optional()
  },
  async (args) => {
    const errHtml = requireString(args, 'html', '待解析的 HTML 标记');
    if (errHtml) return errContent('extract-attributes 参数错误', new Error(errHtml));
    const errSel = requireString(args, 'selector', 'CSS 选择器');
    if (errSel) return errContent('extract-attributes 参数错误', new Error(errSel));

    try {
      const $ = loadHtml(args.html);
      const matches = $(args.selector);
      const limit = args.maxResults ?? 100;
      const wantAttrs = args.attributes && args.attributes.length > 0
        ? args.attributes
        : null;

      const results = [];
      matches.each((i, el) => {
        if (i >= limit) return false; // 停止遍历
        const tag = el.tagName || el.name || '?';
        const attrs = {};
        if (wantAttrs) {
          for (const name of wantAttrs) {
            const val = $(el).attr(name);
            if (val !== undefined) attrs[name] = val;
          }
        } else {
          if (el.attribs) {
            for (const [name, val] of Object.entries(el.attribs)) {
              attrs[name] = val;
            }
          }
        }
        results.push({ index: i, tag, attrs });
      });

      const payload = { matched: matches.length, results };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    } catch (err) {
      return errContent('extract-attributes 执行失败', err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* 工具 3：query-elements — 查询元素结构信息                            */
/* ------------------------------------------------------------------ */
server.tool(
  'query-elements',
  '解析 HTML 并按 CSS 选择器查询元素，返回每个匹配元素的结构摘要（标签名、id、class 列表、全部属性、文本片段、序列化 HTML）。' +
    '参数：html（必填）、selector（必填，CSS 选择器）、limit（可选，默认 50，最多返回的元素个数）、' +
    'textMaxLength（可选，默认 300，每个元素文本片段截断长度）、htmlMaxLength（可选，默认 2000，每个元素序列化 HTML 截断长度）。' +
    '返回：{matched, results:[{index, tag, id, classes, attrs, text, html}]}。' +
    '典型用途：先探查页面结构（哪些元素命中选择器、长什么样），再配合 extract-text / extract-attributes 做精确抽取。',
  {
    html: z.string().min(1, 'html 不能为空'),
    selector: z.string().min(1, 'selector 不能为空'),
    limit: z.number().int().positive().optional(),
    textMaxLength: z.number().int().positive().optional(),
    htmlMaxLength: z.number().int().positive().optional()
  },
  async (args) => {
    const errHtml = requireString(args, 'html', '待解析的 HTML 标记');
    if (errHtml) return errContent('query-elements 参数错误', new Error(errHtml));
    const errSel = requireString(args, 'selector', 'CSS 选择器');
    if (errSel) return errContent('query-elements 参数错误', new Error(errSel));

    try {
      const $ = loadHtml(args.html);
      const matches = $(args.selector);
      const limit = args.limit ?? 50;
      const tMax = args.textMaxLength ?? 300;
      const hMax = args.htmlMaxLength ?? 2000;

      const results = [];
      matches.each((i, el) => {
        if (i >= limit) return false;
        const $el = $(el);
        const attrs = {};
        if (el.attribs) {
          for (const [name, val] of Object.entries(el.attribs)) {
            attrs[name] = val;
          }
        }
        const rawText = $el.text();
        const rawHtml = $.html($el);
        results.push({
          index: i,
          tag: el.tagName || el.name || '?',
          id: attrs.id ?? null,
          classes: attrs.class ? String(attrs.class).split(/\s+/).filter(Boolean) : [],
          attrs,
          text: rawText.length > tMax ? `${rawText.slice(0, tMax)}…` : rawText,
          html: rawHtml.length > hMax ? `${rawHtml.slice(0, hMax)}…` : rawHtml
        });
      });

      const payload = { matched: matches.length, results };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    } catch (err) {
      return errContent('query-elements 执行失败', err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* 工具 4：serialize-html — 重新序列化规范化标记                        */
/* ------------------------------------------------------------------ */
server.tool(
  'serialize-html',
  '解析 HTML（或 XML）标记并重新序列化，输出规范化后的标记文本。可用于清洗缩进/大小写、补全缺失闭合标签、验证标记可解析性。' +
    '参数：html（必填）、fragment（可选，默认 true，true 时按片段解析不注入 html/head/body 包装；false 时按完整文档解析）、' +
    'xml（可选，默认 false，true 时以 XML 模式解析并序列化，适合处理 XML/自闭合标签文档）。' +
    '返回：{serialized, note}，note 在片段/文档模式差异可能影响输出时给出提示。',
  {
    html: z.string().min(1, 'html 不能为空'),
    fragment: z.boolean().optional(),
    xml: z.boolean().optional()
  },
  async (args) => {
    const errHtml = requireString(args, 'html', '待解析的 HTML 标记');
    if (errHtml) return errContent('serialize-html 参数错误', new Error(errHtml));

    try {
      const isXml = !!args.xml;
      const isFragment = args.fragment !== false;
      const $ = loadHtml(args.html, { xml: isXml, fragment: isFragment });
      const serialized = isXml ? $.xml() : $.html();

      const notes = [];
      if (!isFragment && !isXml) {
        notes.push('文档模式解析可能注入 <html>/<head>/<body> 包装元素');
      }
      const payload = { serialized, note: notes.join('；') || null };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    } catch (err) {
      return errContent('serialize-html 执行失败', err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* 启动 stdio 服务器                                                    */
/* ------------------------------------------------------------------ */
const transport = new StdioServerTransport();
await server.connect(transport);
