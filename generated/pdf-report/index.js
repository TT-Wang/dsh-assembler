/**
 * @dsh-index/pdf-report — MCP stdio server 包装 pdf-lib@1.17.1 + @pdf-lib/fontkit（MIT），
 * 支持中文/英文混排的 PDF 报告生成。
 *
 * 与 pdf-generate 的区别：pdf-lib 的 14 种标准字体仅支持 Latin-1/WinAnsi（英文及西文），
 * 无法编码中文；本适配器通过 fontkit 嵌入 CJK 字体（优先捆绑的 Noto Sans CJK SC
 * [SIL OFL]，缺省时回落到 macOS 系统字体 Arial Unicode MS），自动换行、自动分页，
 * 生成结构化研究报告（标题、元信息行、分节标题与段落正文）。
 *
 * 工具（最终工具名 mcp__pdf-report__<tool>）：
 *   - create-report-pdf : 结构化报告（title/metaLines/sections）→ 多页 PDF（base64 + 可选落盘）
 *
 * 实现为 ESM MCP stdio server，全部本地执行、无网络依赖。所有工具捕获异常并以
 * isError=true 的文本内容返回清晰错误，绝不向 LLM 抛未处理的内部堆栈。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PDFDocument, PageSizes, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 字体解析链（按顺序尝试，返回 {bytes, label} 或抛错）：
 *   1. fonts/NotoSansCJKsc-Regular.otf —— 捆绑的 SIL OFL 开源字体（首选，可移植）；
 *   2. /Library/Fonts/Arial Unicode.ttf —— macOS 系统字体（Arial Unicode MS，
 *      含完整 CJK 字形，运行时读取、不重新分发，本机立即可用）。
 * 每个候选都做解析验证：字体文件损坏/截断时自动落到下一个候选。
 */
const FONT_CANDIDATES = [
  {
    path: resolve(SERVER_DIR, 'fonts', 'NotoSansCJKsc-Regular.otf'),
    label: 'NotoSansCJKsc-Regular.otf (bundled, OFL)'
  },
  {
    path: '/Library/Fonts/Arial Unicode.ttf',
    label: 'Arial Unicode MS (macOS system font)'
  }
];

/** 加载并验证第一个可用的中文字体，返回 {bytes, label}；全部失败则抛错 */
function loadCjkFont() {
  const errors = [];
  for (const candidate of FONT_CANDIDATES) {
    try {
      const bytes = readFileSync(candidate.path);
      const font = fontkit.create(bytes); // 解析验证（截断/损坏文件会在此抛错）
      if (!font.hasGlyphForCodePoint || !font.hasGlyphForCodePoint(0x4e2d)) {
        throw new Error('字体不含中文字形');
      }
      return { bytes, label: candidate.label };
    } catch (e) {
      errors.push(`${candidate.path}: ${e && e.message ? e.message : String(e)}`);
    }
  }
  throw new Error(
    `未找到可用的中文字体，已尝试：\n${errors.map((e) => `  - ${e}`).join('\n')}\n` +
      '解决方式：把 Noto Sans CJK SC（SIL OFL 许可）的 OTF 文件放到本服务器的 fonts/NotoSansCJKsc-Regular.otf，' +
      '或安装 Arial Unicode MS 字体。'
  );
}

const server = new McpServer({
  name: 'pdf-report',
  version: '0.0.1'
});

/** 把异常转成 MCP 文本错误内容（isError=true 便于调用方识别失败） */
function errContent(label, err) {
  const msg = err && err.message ? err.message : String(err);
  return { content: [{ type: 'text', text: `${label}: ${msg}` }], isError: true };
}

/** 解析页面尺寸，返回 [width, height]（点数）或抛错 */
function resolvePageSize(size, width, height) {
  if (width !== undefined || height !== undefined) {
    const w = Number(width);
    const h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      throw new Error(`自定义尺寸非法：width=${width}, height=${height}，需为正数（点数）`);
    }
    return [w, h];
  }
  const name = String(size ?? 'A4');
  const dims = PageSizes[name];
  if (!dims) {
    throw new Error(`未知页面尺寸 "${name}"。可选：${Object.keys(PageSizes).join('、')}（或改用 width/height 自定义）`);
  }
  return dims;
}

/**
 * 按像素宽度把一行文本折成多行（贪心 + 词边界优先）。
 * 中英混排：连续 CJK 字符按字符换行，拉丁词按空格切分不打断单词。
 */
function wrapLine(text, font, size, maxWidth) {
  const lines = [];
  let current = '';
  let currentWidth = 0;
  // 按"词/字符"切分：拉丁字母数字串 + 连续空白 作为整体，其余（CJK 等）逐字符
  const tokens = text.match(/[\u0020-\u007E]+|[^\u0020-\u007E]/g) ?? [];
  for (const token of tokens) {
    const tokenWidth = font.widthOfTextAtSize(token, size);
    if (currentWidth + tokenWidth <= maxWidth) {
      current += token;
      currentWidth += tokenWidth;
    } else if (tokenWidth > maxWidth) {
      // 单个 token 超宽（如超长单词/URL）：硬切
      if (current) {
        lines.push(current.trimEnd());
        current = '';
        currentWidth = 0;
      }
      let piece = '';
      let pieceWidth = 0;
      for (const ch of token) {
        const chw = font.widthOfTextAtSize(ch, size);
        if (pieceWidth + chw > maxWidth && piece) {
          lines.push(piece);
          piece = '';
          pieceWidth = 0;
        }
        piece += ch;
        pieceWidth += chw;
      }
      if (piece) {
        current = piece;
        currentWidth = pieceWidth;
      }
    } else {
      lines.push(current.trimEnd());
      current = token.trimStart();
      currentWidth = font.widthOfTextAtSize(current, size);
    }
  }
  if (current.trimEnd()) lines.push(current.trimEnd());
  return lines.length > 0 ? lines : [''];
}

/* ------------------------------------------------------------------ */
/* 工具 1：create-report-pdf — 结构化报告生成 PDF                        */
/* ------------------------------------------------------------------ */
server.tool(
  'create-report-pdf',
  '把结构化研究报告渲染为多页 PDF，支持中文/英文混排（嵌入 CJK 字体：优先捆绑的 Noto Sans CJK SC，缺省回落 macOS 系统字体 Arial Unicode MS；自动换行、自动分页、字体子集化）。纯本地执行，无网络依赖。' +
    '参数：title（必填，报告标题）；sections（必填，章节数组，每项 {heading（可选）, paragraphs（必填，段落文本数组）}）；' +
    'metaLines（可选，标题下方的小字元信息行，如来源 URL、抓取时间、作者）；' +
    'size（可选，纸张名，默认 "A4"，可选 Letter/Legal/A3 等，或 width/height 自定义点数）；' +
    'fontSize（可选，正文字号，默认 11）、titleSize（默认 22）、headingSize（默认 14）、metaSize（默认 9）；' +
    'margin（可选，页边距点数，默认 50）、lineGap（可选，行距倍数，默认 1.5）；' +
    'outputPath（可选，若提供则把 PDF 写入该绝对路径并返回该路径）。' +
    '返回：{pdfBase64, byteLength, pageCount, outputPath?}。pdfBase64 为标准 Base64，可直接保存为 .pdf 文件。' +
    '典型用途：网页研究助手把正文提取结果与摘要整理为中文 PDF 报告。',
  {
    title: z.string().min(1, 'title 不能为空'),
    sections: z
      .array(
        z.object({
          heading: z.string().optional(),
          paragraphs: z.array(z.string()).min(1, 'paragraphs 至少需要 1 段')
        })
      )
      .min(1, 'sections 至少需要 1 节'),
    metaLines: z.array(z.string()).optional(),
    size: z.string().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    fontSize: z.number().positive().optional(),
    titleSize: z.number().positive().optional(),
    headingSize: z.number().positive().optional(),
    metaSize: z.number().positive().optional(),
    margin: z.number().nonnegative().optional(),
    lineGap: z.number().positive().optional(),
    outputPath: z.string().optional()
  },
  async (args) => {
    try {
      const { bytes: fontBytes } = loadCjkFont();
      const [width, height] = resolvePageSize(args.size, args.width, args.height);
      const margin = args.margin ?? 50;
      const lineGap = args.lineGap ?? 1.5;
      const bodySize = args.fontSize ?? 11;
      const titleSize = args.titleSize ?? 22;
      const headingSize = args.headingSize ?? 14;
      const metaSize = args.metaSize ?? 9;
      const maxWidth = width - margin * 2;

      const doc = await PDFDocument.create();
      doc.registerFontkit(fontkit);
      // subset: true —— 只嵌入实际用到的字形（CJK 字体全量可达 15MB+，子集化后通常几十 KB）
      const font = await doc.embedFont(fontBytes, { subset: true });

      const pages = [];
      let page = doc.addPage([width, height]);
      let cursorY = height - margin;
      const ensureSpace = (needed) => {
        if (cursorY - needed < margin) {
          page = doc.addPage([width, height]);
          cursorY = height - margin;
        }
      };
      const drawLine = (text, size, opts = {}) => {
        const lines = wrapLine(String(text), font, size, maxWidth);
        const step = size * lineGap;
        for (const line of lines) {
          ensureSpace(step);
          page.drawText(line, {
            x: margin,
            y: cursorY - size,
            size,
            font,
            color: opts.color ?? rgb(0, 0, 0)
          });
          cursorY -= step;
        }
      };
      const gap = (times = 1) => {
        cursorY -= bodySize * lineGap * times;
        if (cursorY < margin) {
          page = doc.addPage([width, height]);
          cursorY = height - margin;
        }
      };

      // 标题
      drawLine(args.title, titleSize, { color: rgb(0.12, 0.2, 0.36) });
      gap(0.4);

      // 元信息行
      for (const meta of args.metaLines ?? []) {
        drawLine(String(meta), metaSize, { color: rgb(0.45, 0.45, 0.45) });
      }
      if ((args.metaLines ?? []).length > 0) gap(0.6);

      // 章节
      for (const section of args.sections) {
        if (section.heading) {
          gap(0.8);
          drawLine(section.heading, headingSize, { color: rgb(0.12, 0.2, 0.36) });
          gap(0.3);
        }
        for (const paragraph of section.paragraphs) {
          for (const block of String(paragraph).split(/\n+/)) {
            drawLine(block, bodySize);
          }
          gap(0.4);
        }
      }
      pages.push(page);

      const bytes = await doc.save();
      const out = {
        pdfBase64: Buffer.from(bytes).toString('base64'),
        byteLength: bytes.length,
        pageCount: doc.getPageCount()
      };
      if (args.outputPath) {
        writeFileSync(args.outputPath, bytes);
        out.outputPath = args.outputPath;
      }
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    } catch (err) {
      return errContent('create-report-pdf 执行失败', err);
    }
  }
);

await server.connect(new StdioServerTransport());
