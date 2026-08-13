/**
 * @dsh-index/pdf-generate — MCP stdio server 包装 pdf-lib@1.17.1（MIT，Hopding/pdf-lib）。
 *
 * 工具（最终工具名 mcp__pdf-generate__<tool>）：
 *   - create-pdf     : 从零创建 PDF，按页写入文本行（支持标准纸张、自定义尺寸、字体/字号/颜色、自动或绝对排版）
 *   - merge-pdfs     : 合并多个 PDF（可对每个源文档挑选 0 基页索引子集）为一个新 PDF
 *   - extract-pages  : 从单个 PDF 中抽取指定页（0 基索引）组成新 PDF
 *   - pdf-info       : 检查现有 PDF 的元信息（页数、每页尺寸、是否加密）
 *
 * 只读使用上游库（pdf-lib），不修改上游代码。实现为 ESM，stdio 通信。
 * 每个工具内部按调用参数独立处理（PDFDocument.create/load），无跨调用状态；
 * 全部本地内存执行，无网络依赖。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PDFDocument, StandardFonts, PageSizes, rgb } from 'pdf-lib';

const server = new McpServer({
  name: 'pdf-generate',
  version: '0.0.1'
});

/** 把用户可读的异常转成 MCP 文本错误内容（isError=true 便于调用方识别失败） */
function errContent(label, err) {
  const msg = err && err.message ? err.message : String(err);
  return { content: [{ type: 'text', text: `${label}: ${msg}` }], isError: true };
}

/** 校验必填字符串参数：缺失、非字符串、空白串都视为非法，返回错误文本（合法返回 null） */
function requireString(args, key, label) {
  const v = args[key];
  if (v === undefined || v === null) return `缺少必填参数 ${key}（${label}）`;
  if (typeof v !== 'string') return `参数 ${key}（${label}）类型错误：期望 string，实际为 ${typeof v}`;
  if (!v.trim()) return `参数 ${key}（${label}）为空字符串`;
  return null;
}

/** 严格校验 base64 字符串（去空白后检查字符集与填充），返回 Uint8Array 或抛错 */
function base64ToBytes(b64) {
  const clean = String(b64).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) {
    throw new Error('base64 内容非法：应使用标准 Base64 编码（可用 PDFDocument.saveAsBase64() 或 Buffer.toString("base64") 生成）');
  }
  const buf = Buffer.from(clean, 'base64');
  if (buf.length === 0) throw new Error('base64 内容为空或无法解码');
  return new Uint8Array(buf);
}

/** 基本命名颜色表（r,g,b 0-255） */
const NAMED_COLORS = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  orange: [255, 165, 0],
  yellow: [255, 255, 0],
  purple: [128, 0, 128],
  gray: [128, 128, 128],
  grey: [128, 128, 128]
};

/** 解析颜色为 pdf-lib 的 [r,g,b]（0-1）：支持 #rrggbb / #rgb / rgb(r,g,b)(0-255) / 基本英文颜色名 */
function parseColor(str) {
  const s = String(str ?? '').trim();
  if (!s) return null;
  if (NAMED_COLORS[s.toLowerCase()]) return NAMED_COLORS[s.toLowerCase()].map((v) => v / 255);
  const hex = s.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (hex) {
    const h = hex[1];
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return [r / 255, g / 255, b / 255];
  }
  const fn = s.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/);
  if (fn) {
    const [r, g, b] = [parseInt(fn[1], 10), parseInt(fn[2], 10), parseInt(fn[3], 10)];
    if (r > 255 || g > 255 || b > 255) throw new Error(`颜色 ${s} 分量超出 0-255 范围`);
    return [r / 255, g / 255, b / 255];
  }
  throw new Error(`无法解析颜色 "${s}"：支持 #rrggbb、#rgb、rgb(r,g,b)(0-255) 或基本颜色名（如 red/blue/black）`);
}

/** 归一化标准字体名（去空格/连字符后匹配 StandardFonts 枚举），返回枚举值或抛错 */
function resolveFont(name) {
  const norm = String(name ?? 'Helvetica').replace(/[\s-]/g, '');
  const key = Object.keys(StandardFonts).find((k) => k.toLowerCase() === norm.toLowerCase());
  if (!key) {
    throw new Error(
      `未知字体 "${name}"。可选：${Object.keys(StandardFonts).join('、')}（也可用 Times Roman / Helvetica Bold 等易读写法）`
    );
  }
  return StandardFonts[key];
}

/**
 * 预检文本是否可被标准字体（WinAnsi 字符集）编码。
 * pdf-lib 的 14 种标准字体仅支持 Latin-1/WinAnsi 字符集，中文、日文、韩文等
 * 非拉丁字符无法编码（会抛 "WinAnsi cannot encode"）。这里提前给出清晰错误，
 * 避免把晦涩的底层异常抛给调用方。
 */
function assertWinAnsiEncodable(text) {
  const bad = [...new Set([...String(text)].filter((ch) => ch.charCodeAt(0) > 0xff))];
  if (bad.length > 0) {
    throw new Error(
      `文本包含标准字体无法编码的字符：${bad.slice(0, 8).join(' ')}。pdf-lib 的 14 种标准字体仅支持 Latin-1/WinAnsi（英文及西文），` +
        '不支持中文/日文/韩文等非拉丁字符。请改用英文文本；如需中文排版，需自行集成 @pdf-lib/fontkit 并嵌入自定义 TTF 字体（本适配器未捆绑字体文件）。'
    );
  }
}

/**
 * 解析页面尺寸：优先 width/height（点数 pt，1pt=1/72 英寸），否则按 size 名查 PageSizes。
 * 返回 [width, height] 或抛错。
 */
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
    throw new Error(
      `未知页面尺寸 "${name}"。可选：${Object.keys(PageSizes).join('、')}（或改用 width/height 自定义）`
    );
  }
  return dims;
}

/** 生成并返回 {pdfBase64, byteLength, pageCount} */
async function finishDoc(doc) {
  const bytes = await doc.save();
  const b64 = Buffer.from(bytes).toString('base64');
  return { pdfBase64: b64, byteLength: bytes.length, pageCount: doc.getPageCount() };
}

/* ------------------------------------------------------------------ */
/* 工具 1：create-pdf — 从零创建 PDF，写入文本行                        */
/* ------------------------------------------------------------------ */
server.tool(
  'create-pdf',
  '从零创建一个新的 PDF 文档，可包含多页，每页写入一组文本行。纯本地内存执行，无网络依赖。' +
    '参数：pages（必填，页面数组，至少 1 页）。每页对象字段：' +
    'size（可选，标准纸张名，如 "A4"、"Letter"、"Legal"、"A3"、"Tabloid"，默认 "A4"）、' +
    'width/height（可选，自定义页面尺寸，单位点数 pt，1pt=1/72 英寸，提供则覆盖 size）、' +
    'font（可选，标准字体名，默认 "Helvetica"；可选 Courier/CourierBold/HelveticaBold/TimesRoman/TimesRomanItalic/Symbol 等，接受 "Times Roman" 这类易读写法）、' +
    'fontSize（可选，默认 12）、margin（可选，页边距点数，默认 50）、lineGap（可选，行距倍数，默认 1.25）、' +
    'lines（可选，文本行数组）。每行对象：text（必填，行文本）、x/y（可选，绝对坐标点数，缺省按"从页顶向下自动换行"排版：起始 y=height-margin，每行下移 fontSize*lineGap）、' +
    'size/font/color（可选，覆盖页级设置）、color（可选，颜色，支持 "#FF0000"、"#f00"、"rgb(255,0,0)" 或基本颜色名如 red/blue/black，默认黑色）。' +
    '注意：pdf-lib 的 14 种标准字体仅支持 Latin-1/WinAnsi 字符集，文本请使用英文及西文（不支持中文等非拉丁字符，若传入会返回清晰错误）。' +
    '返回：{pdfBase64, byteLength, pageCount, note}。pdfBase64 为标准 Base64，可直接保存为 .pdf 文件或传给 merge-pdfs/pdf-info 等工具。' +
    '典型用途：生成含标题/正文/列表的 PDF、合同模板、批量生成票据等。',
  {
    pages: z
      .array(
        z.object({
          size: z.string().optional(),
          width: z.number().positive().optional(),
          height: z.number().positive().optional(),
          font: z.string().optional(),
          fontSize: z.number().positive().optional(),
          margin: z.number().nonnegative().optional(),
          lineGap: z.number().positive().optional(),
          lines: z
            .array(
              z.object({
                text: z.string().min(1, '行文本不能为空'),
                x: z.number().optional(),
                y: z.number().optional(),
                size: z.number().positive().optional(),
                font: z.string().optional(),
                color: z.string().optional()
              })
            )
            .optional()
        })
      )
      .min(1, 'pages 至少需要 1 页')
  },
  async (args) => {
    try {
      const doc = await PDFDocument.create();
      const notes = [];

      for (let pi = 0; pi < args.pages.length; pi++) {
        const pageSpec = args.pages[pi];
        const [width, height] = resolvePageSize(pageSpec.size, pageSpec.width, pageSpec.height);
        const page = doc.addPage([width, height]);
        const fontName = resolveFont(pageSpec.font || 'Helvetica');
        const font = await doc.embedFont(fontName);
        const fontSize = pageSpec.fontSize ?? 12;
        const margin = pageSpec.margin ?? 50;
        const lineGap = pageSpec.lineGap ?? 1.25;
        const lines = pageSpec.lines ?? [];

        let cursorY = height - margin;
        let skipped = 0;
        for (const line of lines) {
          assertWinAnsiEncodable(line.text);
          const size = line.size ?? fontSize;
          const step = size * lineGap;
          let y;
          if (line.y !== undefined) {
            y = line.y;
          } else {
            if (cursorY < margin) {
              skipped += 1;
              continue;
            }
            y = cursorY;
            cursorY -= step;
          }
          const color = parseColor(line.color !== undefined ? line.color : 'black');
          page.drawText(line.text, {
            x: line.x ?? margin,
            y,
            size,
            font,
            color: rgb(color[0], color[1], color[2])
          });
        }
        if (skipped > 0) notes.push(`第 ${pi + 1} 页有 ${skipped} 行因超出页面底部（y<${margin}）被跳过`);
      }

      const out = await finishDoc(doc);
      if (notes.length) out.note = notes.join('；');
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    } catch (err) {
      return errContent('create-pdf 执行失败', err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* 工具 2：merge-pdfs — 合并多个 PDF                                    */
/* ------------------------------------------------------------------ */
server.tool(
  'merge-pdfs',
  '把多个 PDF 文档（以 Base64 提供）按顺序合并为一个新 PDF。纯本地内存执行，无网络依赖。' +
    '参数：pdfs（必填，源文档数组，至少 1 个）。每项字段：' +
    'base64（必填，源 PDF 的标准 Base64 内容）、pages（可选，0 基页索引数组，如 [0,2] 只取第 1、3 页；缺省取全部页）。' +
    'ignoreEncryption（可选，默认 false，true 时跳过加密文档的读取保护；注意已加密文档本身通常无法正常渲染）。' +
    '返回：{pdfBase64, byteLength, pageCount, sourceDocs:[{doc, pagesTaken, totalPages}]}。' +
    '典型用途：把多份扫描件/发票/合同片段合并成一份文件。',
  {
    pdfs: z
      .array(
        z.object({
          base64: z.string().min(1, 'base64 不能为空'),
          pages: z.array(z.number().int().nonnegative()).optional()
        })
      )
      .min(1, 'pdfs 至少需要 1 个源文档'),
    ignoreEncryption: z.boolean().optional()
  },
  async (args) => {
    try {
      const outDoc = await PDFDocument.create();
      const sourceDocs = [];
      const ignoreEncryption = !!args.ignoreEncryption;

      for (const src of args.pdfs) {
        const bytes = base64ToBytes(src.base64);
        const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption });
        const total = srcDoc.getPageCount();
        let indices;
        if (src.pages && src.pages.length > 0) {
          const bad = src.pages.filter((i) => i >= total);
          if (bad.length > 0) {
            throw new Error(`页索引越界：${bad.join(', ')} 超出范围 0..${total - 1}`);
          }
          indices = [...new Set(src.pages)].sort((a, b) => a - b);
        } else {
          indices = Array.from({ length: total }, (_, i) => i);
        }
        const copied = await outDoc.copyPages(srcDoc, indices);
        copied.forEach((p) => outDoc.addPage(p));
        sourceDocs.push({ doc: sourceDocs.length + 1, pagesTaken: indices.length, totalPages: total });
      }

      const out = await finishDoc(outDoc);
      out.sourceDocs = sourceDocs;
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    } catch (err) {
      return errContent('merge-pdfs 执行失败', err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* 工具 3：extract-pages — 抽取指定页组成新 PDF                         */
/* ------------------------------------------------------------------ */
server.tool(
  'extract-pages',
  '从单个 PDF 文档中抽取指定页（0 基索引），组成一个新的 PDF。纯本地内存执行，无网络依赖。' +
    '参数：pdfBase64（必填，源 PDF 的标准 Base64 内容）、pages（必填，0 基页索引数组，如 [0, 2] 抽取第 1、3 页，顺序按数组给定）、' +
    'ignoreEncryption（可选，默认 false）。' +
    '返回：{pdfBase64, byteLength, pageCount, sourcePageCount, note?}。' +
    '典型用途：从长文档中挑出需要的页（如只保留签名页/目录页）、把多页 PDF 拆分成小份。',
  {
    pdfBase64: z.string().min(1, 'pdfBase64 不能为空'),
    pages: z.array(z.number().int().nonnegative()).min(1, 'pages 至少需要 1 个页索引'),
    ignoreEncryption: z.boolean().optional()
  },
  async (args) => {
    const missing = requireString(args, 'pdfBase64', '源 PDF 的 Base64 内容');
    if (missing) return errContent('extract-pages 参数错误', new Error(missing));

    try {
      const bytes = base64ToBytes(args.pdfBase64);
      const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: !!args.ignoreEncryption });
      const total = srcDoc.getPageCount();
      const indices = [...new Set(args.pages)];
      const bad = indices.filter((i) => i >= total);
      if (bad.length > 0) {
        throw new Error(`页索引越界：${bad.join(', ')} 超出范围 0..${total - 1}`);
      }

      const outDoc = await PDFDocument.create();
      const copied = await outDoc.copyPages(srcDoc, indices);
      copied.forEach((p) => outDoc.addPage(p));

      const out = await finishDoc(outDoc);
      out.sourcePageCount = total;
      if (indices.length !== args.pages.length) {
        out.note = `输入含 ${args.pages.length - indices.length} 个重复索引，已去重`;
      }
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    } catch (err) {
      return errContent('extract-pages 执行失败', err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* 工具 4：pdf-info — 检查 PDF 元信息                                   */
/* ------------------------------------------------------------------ */
server.tool(
  'pdf-info',
  '检查现有 PDF 文档的结构元信息，不做任何修改。纯本地内存执行，无网络依赖。' +
    '参数：pdfBase64（必填，PDF 的标准 Base64 内容）、ignoreEncryption（可选，默认 false）。' +
    '返回：{pageCount, pageSizes:[{width,height}], encrypted}，其中 pageSizes 每项为该页尺寸（点数），' +
    'encrypted=true 表示文档带加密（此时 load 默认会失败，可带 ignoreEncryption=true 读取元信息）。' +
    '典型用途：在合并/抽取前先确认页数与页面尺寸，或验证下载的 PDF 是否损坏/加密。',
  {
    pdfBase64: z.string().min(1, 'pdfBase64 不能为空'),
    ignoreEncryption: z.boolean().optional()
  },
  async (args) => {
    const missing = requireString(args, 'pdfBase64', 'PDF 的 Base64 内容');
    if (missing) return errContent('pdf-info 参数错误', new Error(missing));

    try {
      const bytes = base64ToBytes(args.pdfBase64);
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: !!args.ignoreEncryption });
      const pageCount = doc.getPageCount();
      const pageSizes = doc.getPages().map((p) => p.getSize());
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ pageCount, pageSizes, encrypted: doc.isEncrypted })
          }
        ]
      };
    } catch (err) {
      return errContent('pdf-info 执行失败', err);
    }
  }
);

await server.connect(new StdioServerTransport());
