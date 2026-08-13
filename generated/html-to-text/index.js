/**
 * @dsh-index/html-to-text — MCP stdio server wrapping html-to-text@9.0.5 (MIT).
 *
 * 上游库 html-to-text 提供两个核心 API：
 *   - convert(html, options?, metadata?)  ：把 HTML 字符串转为纯文本（htmlToText 是它的别名）
 *   - compile(options?)                   ：预编译选项，返回可复用的转换函数（批量处理性能更好）
 *
 * Tools（最终工具名 mcp__html-to-text__<tool>）：
 *   - html-to-text        : HTML → 纯文本（wordwrap / 标题大写 / 保留换行 / 实体解码 / 输入长度限制 / 高级 selectors 覆盖）
 *   - html-to-text-batch  : 用同一组选项批量转换多个 HTML 文档（内部 compile 复用，适合邮件正文批处理）
 *   - html-to-text-table  : 把 HTML <table> 渲染为对齐的纯文本表格（dataTable 格式器，支持 colSpacing/rowSpacing）
 *   - html-to-text-links  : 提取文档中的链接，输出为 "文本 [URL]" 形式（可选 baseUrl 解析相对链接）
 *
 * 实现为 ESM MCP stdio server，全部本地执行、无网络依赖。所有工具捕获异常并以
 * isError=true 的文本内容返回清晰错误，绝不向 LLM 抛未处理的内部堆栈。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { convert, compile } from 'html-to-text';

const server = new McpServer({
  name: 'html-to-text',
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

/**
 * 公共：把工具参数拼成 html-to-text 的 options 对象。
 * 返回 { ok: true, options } 或 { ok: false, error }。
 */
function buildCommonOptions(args) {
  const options = {};

  if (args.wordwrap !== undefined) {
    if (args.wordwrap === false) {
      options.wordwrap = false;
    } else if (typeof args.wordwrap === 'number' && args.wordwrap > 0) {
      options.wordwrap = Math.floor(args.wordwrap);
    } else {
      return { ok: false, error: `参数 wordwrap 必须为正整数或 false（禁用换行），实际为 ${JSON.stringify(args.wordwrap)}` };
    }
  }

  if (args.uppercaseHeadings !== undefined) {
    options.selectors = options.selectors || [];
    options.selectors.push(
      ...[1, 2, 3, 4, 5, 6].map((i) => ({
        selector: `h${i}`,
        format: 'heading',
        options: { uppercase: !!args.uppercaseHeadings }
      }))
    );
  }

  if (args.preserveNewlines !== undefined) {
    options.preserveNewlines = !!args.preserveNewlines;
  }

  if (args.decodeEntities !== undefined) {
    options.decodeEntities = !!args.decodeEntities;
  }

  if (args.maxInputLength !== undefined) {
    if (typeof args.maxInputLength !== 'number' || args.maxInputLength <= 0) {
      return { ok: false, error: `参数 maxInputLength 必须为正整数（限制输入长度），实际为 ${JSON.stringify(args.maxInputLength)}` };
    }
    options.limits = options.limits || {};
    options.limits.maxInputLength = Math.floor(args.maxInputLength);
  }

  if (args.selectorsJson !== undefined) {
    if (typeof args.selectorsJson !== 'string' || !args.selectorsJson.trim()) {
      return { ok: false, error: '参数 selectorsJson 必须是非空 JSON 字符串（selector 覆盖定义数组）' };
    }
    let parsed;
    try {
      parsed = JSON.parse(args.selectorsJson);
    } catch (e) {
      return { ok: false, error: `参数 selectorsJson 不是合法 JSON：${e.message}` };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, error: '参数 selectorsJson 必须是 JSON 数组，例如 [{"selector":"a","format":"inline"}]' };
    }
    options.selectors = options.selectors || [];
    options.selectors.push(...parsed);
  }

  return { ok: true, options };
}

// ---------------------------------------------------------------------------
// 工具 1：html-to-text — HTML 转纯文本
// ---------------------------------------------------------------------------
server.tool(
  'html-to-text',
  '把一段 HTML 字符串转换为可读的纯文本（常用于邮件正文、摘要、阅读文本）。' +
    '参数：html 为必填 HTML 源串；wordwrap 为每行最大宽度（默认 130，传 false 禁用自动换行）；' +
    'uppercaseHeadings 控制 h1-h6 标题是否大写（默认 true）；preserveNewlines 是否保留输入中的换行（默认 false）；' +
    'decodeEntities 是否解码 HTML 实体（默认 true）；maxInputLength 限制输入长度（超出截断，默认 16777216）；' +
    'selectorsJson 为高级用法：JSON 数组形式的 selector 覆盖定义（例如 [{"selector":"a","format":"inline"}]），可覆盖默认格式与锚点选项。',
  {
    html: z.string().min(1).describe('要转换的 HTML 字符串（必填）'),
    wordwrap: z.union([z.number().int().positive(), z.literal(false)]).optional().describe('每行最大宽度；false 禁用换行（默认 130）'),
    uppercaseHeadings: z.boolean().optional().describe('标题是否转大写（默认 true）'),
    preserveNewlines: z.boolean().optional().describe('是否保留输入中的换行（默认 false）'),
    decodeEntities: z.boolean().optional().describe('是否解码 HTML 实体（默认 true）'),
    maxInputLength: z.number().int().positive().optional().describe('输入长度上限，超出则截断（默认 16777216）'),
    selectorsJson: z.string().optional().describe('JSON 数组形式的 selector 覆盖定义，高级用法')
  },
  async (args) => {
    const missing = requireString(args, 'html', 'HTML 源串');
    if (missing) return { content: [{ type: 'text', text: missing }], isError: true };

    const built = buildCommonOptions(args);
    if (!built.ok) return { content: [{ type: 'text', text: built.error }], isError: true };

    try {
      const text = convert(args.html, built.options);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return errContent('html-to-text 转换失败', err);
    }
  }
);

// ---------------------------------------------------------------------------
// 工具 2：html-to-text-batch — 批量转换多个 HTML 文档
// ---------------------------------------------------------------------------
server.tool(
  'html-to-text-batch',
  '用同一组选项批量把多个 HTML 文档转为纯文本，返回与输入一一对应的文本数组。' +
    '内部使用 compile() 预编译选项复用，适合邮件/文章的批处理（性能优于逐条 convert）。' +
    '参数：htmls 为必填的 HTML 字符串数组（至少 1 个）；其余选项（wordwrap / uppercaseHeadings / ' +
    'preserveNewlines / decodeEntities / maxInputLength / selectorsJson）含义与 html-to-text 工具一致。',
  {
    htmls: z.array(z.string().min(1)).min(1).describe('要转换的 HTML 字符串数组（必填，至少 1 个）'),
    wordwrap: z.union([z.number().int().positive(), z.literal(false)]).optional().describe('每行最大宽度；false 禁用换行（默认 130）'),
    uppercaseHeadings: z.boolean().optional().describe('标题是否转大写（默认 true）'),
    preserveNewlines: z.boolean().optional().describe('是否保留输入中的换行（默认 false）'),
    decodeEntities: z.boolean().optional().describe('是否解码 HTML 实体（默认 true）'),
    maxInputLength: z.number().int().positive().optional().describe('输入长度上限（默认 16777216）'),
    selectorsJson: z.string().optional().describe('JSON 数组形式的 selector 覆盖定义，高级用法')
  },
  async (args) => {
    if (!Array.isArray(args.htmls) || args.htmls.length === 0) {
      return { content: [{ type: 'text', text: '缺少必填参数 htmls（HTML 字符串数组）' }], isError: true };
    }
    for (let i = 0; i < args.htmls.length; i++) {
      if (typeof args.htmls[i] !== 'string' || !args.htmls[i].trim()) {
        return { content: [{ type: 'text', text: `htmls[${i}] 为空或不是字符串` }], isError: true };
      }
    }

    const built = buildCommonOptions(args);
    if (!built.ok) return { content: [{ type: 'text', text: built.error }], isError: true };

    try {
      const compiledConvert = compile(built.options);
      const texts = args.htmls.map((h) => compiledConvert(h));
      return {
        content: [{
          type: 'text',
          text: texts.map((t, i) => `[${i}] ${t}`).join('\n---\n')
        }]
      };
    } catch (err) {
      return errContent('html-to-text 批量转换失败', err);
    }
  }
);

// ---------------------------------------------------------------------------
// 工具 3：html-to-text-table — HTML 表格渲染为对齐纯文本
// ---------------------------------------------------------------------------
server.tool(
  'html-to-text-table',
  '把 HTML 文档中的 <table> 表格渲染为对齐的纯文本表格（支持 colspan/rowspan、表头大写），' +
    '非常适合把网页表格转成邮件正文或可读文本。文档中表格之外的内容不会出现在输出中；' +
    '若文档包含多个表格，它们按出现顺序依次输出。' +
    '参数：html 为必填 HTML 源串（可包含多个 <table>）；colSpacing 为列间距空格数（默认 3）；' +
    'rowSpacing 为行间空行数（默认 0）；uppercaseHeaderCells 是否把表头 <th> 大写（默认 true）；' +
    'maxInputLength 限制输入长度（默认 16777216）。',
  {
    html: z.string().min(1).describe('含 <table> 的 HTML 字符串（必填）'),
    colSpacing: z.number().int().min(0).optional().describe('列间距空格数（默认 3）'),
    rowSpacing: z.number().int().min(0).optional().describe('行间空行数（默认 0）'),
    uppercaseHeaderCells: z.boolean().optional().describe('表头 <th> 是否大写（默认 true）'),
    maxInputLength: z.number().int().positive().optional().describe('输入长度上限（默认 16777216）')
  },
  async (args) => {
    const missing = requireString(args, 'html', '含表格的 HTML 源串');
    if (missing) return { content: [{ type: 'text', text: missing }], isError: true };

    const tableOptions = {};
    if (args.colSpacing !== undefined) tableOptions.colSpacing = args.colSpacing;
    if (args.rowSpacing !== undefined) tableOptions.rowSpacing = args.rowSpacing;
    if (args.uppercaseHeaderCells !== undefined) tableOptions.uppercaseHeaderCells = !!args.uppercaseHeaderCells;

    const options = {
      baseElements: {
        selectors: ['table'],
        returnDomByDefault: false
      },
      selectors: [
        { selector: 'table', format: 'dataTable', options: tableOptions }
      ]
    };
    if (args.maxInputLength !== undefined) {
      if (typeof args.maxInputLength !== 'number' || args.maxInputLength <= 0) {
        return { content: [{ type: 'text', text: `参数 maxInputLength 必须为正整数，实际为 ${JSON.stringify(args.maxInputLength)}` }], isError: true };
      }
      options.limits = { maxInputLength: Math.floor(args.maxInputLength) };
    }

    try {
      const text = convert(args.html, options);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return errContent('html-to-text 表格渲染失败', err);
    }
  }
);

// ---------------------------------------------------------------------------
// 工具 4：html-to-text-links — 提取链接（文本 + URL）
// ---------------------------------------------------------------------------
server.tool(
  'html-to-text-links',
  '提取 HTML 文档中所有 <a> 链接，输出为 "链接文本 [URL]" 的逐行列表（只输出链接，不输出其余正文）。' +
    '参数：html 为必填 HTML 源串；baseUrl 用于把以 / 开头的相对链接解析为绝对 URL（例如 "https://example.com"）；' +
    'linkBrackets 为链接括号（默认 ["[","]"]，传 false 则不带括号只输出文本和 URL）；' +
    'ignoreHref 为 true 时忽略 href 只输出链接文本；hideLinkHrefIfSameAsText 为 true 时若链接文本与 URL 相同则省略 [URL]；' +
    'noAnchorUrl 控制是否忽略 href 以 # 开头的页内锚点（默认 true）；maxInputLength 限制输入长度（默认 16777216）。',
  {
    html: z.string().min(1).describe('要提取链接的 HTML 字符串（必填）'),
    baseUrl: z.string().optional().describe('相对链接的基准 URL，例如 "https://example.com"'),
    linkBrackets: z.union([z.tuple([z.string(), z.string()]), z.literal(false)]).optional().describe('链接括号，默认 ["[","]"]；false 表示不加括号'),
    ignoreHref: z.boolean().optional().describe('是否忽略 href 只输出链接文本（默认 false）'),
    hideLinkHrefIfSameAsText: z.boolean().optional().describe('链接文本与 URL 相同时是否省略 [URL]（默认 false）'),
    noAnchorUrl: z.boolean().optional().describe('是否忽略 # 开头的页内锚点链接（默认 true）'),
    maxInputLength: z.number().int().positive().optional().describe('输入长度上限（默认 16777216）')
  },
  async (args) => {
    const missing = requireString(args, 'html', '要提取链接的 HTML 源串');
    if (missing) return { content: [{ type: 'text', text: missing }], isError: true };

    const anchorOptions = {};
    if (args.baseUrl !== undefined) anchorOptions.baseUrl = args.baseUrl;
    if (args.linkBrackets !== undefined) anchorOptions.linkBrackets = args.linkBrackets;
    if (args.ignoreHref !== undefined) anchorOptions.ignoreHref = !!args.ignoreHref;
    if (args.hideLinkHrefIfSameAsText !== undefined) anchorOptions.hideLinkHrefIfSameAsText = !!args.hideLinkHrefIfSameAsText;
    if (args.noAnchorUrl !== undefined) anchorOptions.noAnchorUrl = !!args.noAnchorUrl;

    const options = {
      baseElements: {
        selectors: ['a'],
        returnDomByDefault: false
      },
      selectors: [
        { selector: 'a', format: 'anchor', options: anchorOptions }
      ]
    };
    if (args.maxInputLength !== undefined) {
      if (typeof args.maxInputLength !== 'number' || args.maxInputLength <= 0) {
        return { content: [{ type: 'text', text: `参数 maxInputLength 必须为正整数，实际为 ${JSON.stringify(args.maxInputLength)}` }], isError: true };
      }
      options.limits = { maxInputLength: Math.floor(args.maxInputLength) };
    }

    try {
      const text = convert(args.html, options);
      if (!text.trim()) {
        return { content: [{ type: 'text', text: '文档中没有找到任何 <a> 链接' }] };
      }
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return errContent('html-to-text 链接提取失败', err);
    }
  }
);

// ---------------------------------------------------------------------------
// 启动 stdio 传输
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
