// MCP stdio server wrapping tesseract.js v5.1.0 (Apache-2.0, https://github.com/naptha/tesseract.js)
// 能力点：ocr-parse（OCR 图片文字识别）
// Tools:
//   ocr-languages —— 列出 tesseract.js 支持的语言代码（eng/chi_sim/...）
//   ocr-psm-modes —— 列出页面分割模式（PSM）值与适用场景
//   ocr-recognize —— OCR 识别图片文字：base64/URL/本地路径输入，支持多语言、PSM、字符白名单、
//                    识别区域/自动旋转选项；输出 text/blocks/tsv/hocr/box/osd/unlv/pdf（pdf 为 base64 二进制）
//
// 实现要点：
//   - worker 按语言组合缓存（首次创建需从 CDN 下载 .traineddata，之后落盘缓存 node_modules/.cache/tesseract.js）
//   - 同一 worker 上的 recognize 串行化执行；失败即销毁并驱逐，下次调用重建（语言数据已缓存，重建较快）
//   - 必须传入 errorHandler，否则上游在 reject 分支会 throw 未捕获异常导致进程崩溃
//   - stdin 关闭 / SIGINT / SIGTERM 时终止所有 worker 线程后干净退出（worker_threads 会阻止进程自然退出）

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Tesseract from 'tesseract.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const server = new McpServer({
  name: 'ocr-parse',
  version: '0.0.1',
});

// ---------------------------------------------------------------- constants
// 语言数据缓存目录（首次下载后落盘，避免每次重复下载）
const CACHE_DIR = path.join(__dirname, 'node_modules', '.cache', 'tesseract.js');
try { mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* 缓存目录不可写仅影响加速，不影响功能 */ }

const LANGS = Tesseract.languages || {};
const LANG_CODES = new Set(Object.values(LANGS));
const PSM = Tesseract.PSM || {};
const PSM_VALUES = new Set(Object.values(PSM));
const OUTPUT_FORMATS = ['text', 'blocks', 'tsv', 'hocr', 'box', 'osd', 'unlv', 'pdf'];

// 输入 base64 长度上限（约 30MB 二进制），防止内存耗尽
const MAX_IMAGE_B64_LEN = 40_000_000;
// 首次创建 worker 需下载语言数据（CDN），给足超时
const WORKER_CREATE_TIMEOUT = 180_000;
const RECOGNIZE_TIMEOUT = 180_000;

// PSM（Page Segmentation Mode，页面分割模式）值 → 语义说明
const PSM_DESC = {
  '0': 'OSD_ONLY：仅做方向与脚本检测（不识别文字）',
  '1': 'AUTO_OSD：自动分页 + 方向与脚本检测',
  '2': 'AUTO_ONLY：自动分页，不做方向/脚本检测',
  '3': 'AUTO：全自动分页（不检测方向/脚本），适合布局未知的整页',
  '4': 'SINGLE_COLUMN：单列文本',
  '5': 'SINGLE_BLOCK_VERT_TEXT：单块垂直文本',
  '6': 'SINGLE_BLOCK：单块文本（默认），适合纯文本段落',
  '7': 'SINGLE_LINE：单行文本，适合横幅/标题/验证码',
  '8': 'SINGLE_WORD：单个单词',
  '9': 'CIRCLE_WORD：圆形区域内的单词',
  '10': 'SINGLE_CHAR：单个字符',
  '11': 'SPARSE_TEXT：稀疏文本（尽量找出所有文本，适合多列/散落文本）',
  '12': 'SPARSE_TEXT_OSD：稀疏文本 + OSD',
  '13': 'RAW_LINE：原始行（不做 Tesseract 内部文本处理）',
};

// ---------------------------------------------------------------- helpers
const text = (str) => ({ content: [{ type: 'text', text: str }], isError: false });
const error = (str) => ({ content: [{ type: 'text', text: str }], isError: true });

/** 统一异常处理：参数/上游/超时错误都转为清晰错误文本（isError=true） */
async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return error(`ERROR: ${msg}`);
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)}s）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 按魔数嗅探图片类型，返回 null 表示不支持 */
function sniffImageType(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 4 && ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00)
    || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a))) return 'tiff';
  return null;
}

/**
 * 图片输入归一化，返回 worker.recognize 可直接消费的值：
 *   - http(s):// / file:// URL、data:image/...;base64, data URI → 原样字符串
 *   - 纯 base64 字符串（不含 data: 前缀，推荐）→ 解码为 Buffer 并嗅探格式
 *   - 其它 → 视为本地文件路径，交给上游 readFile
 */
function normalizeImage(image) {
  const s = String(image).trim();
  if (!s) throw new Error('image 参数为空：请提供 base64、URL 或本地文件路径');
  if (/^(https?|file):\/\//.test(s) || /^data:image\//.test(s)) return s;
  // 纯 base64 判定：长串（>64）直接视为 base64；短串若以 = 结尾（base64 填充符）或含空白/换行也按 base64 处理，
  // 使"非图片 base64"能落到格式校验分支给出清晰错误，而不是被当成文件路径报 ENOENT
  const isBase64 = /^[A-Za-z0-9+/=\r\n]+$/.test(s) && (s.length > 64 || s.endsWith('=') || /\s/.test(s));
  if (isBase64) {
    if (s.length > MAX_IMAGE_B64_LEN) {
      throw new Error(`image 过大：base64 长度 ${s.length} 超过上限 ${MAX_IMAGE_B64_LEN}（约 30MB 二进制），请先压缩输入`);
    }
    const buf = Buffer.from(s, 'base64');
    if (buf.length === 0) throw new Error('image base64 解码结果为空：输入不是有效的 base64 图片数据');
    if (!sniffImageType(buf)) {
      throw new Error('image 不是受支持的图片格式（PNG/JPEG/GIF/BMP/WebP/TIFF）：请检查 base64 是否来自真实图片');
    }
    return buf;
  }
  return s; // 本地文件路径
}

// ---------------------------------------------------------------- worker 管理
// 按语言组合缓存 worker：langsKey -> Promise<worker>；链式 Map 保证同一 worker 上串行执行
const workerCache = new Map();
const workerChains = new Map();
const allWorkers = new Set();

function getWorker(langsKey) {
  let p = workerCache.get(langsKey);
  if (!p) {
    p = (async () => {
      const w = await withTimeout(
        Tesseract.createWorker(langsKey, Tesseract.OEM.LSTM_ONLY, {
          cachePath: CACHE_DIR,
          logger: () => {},
          errorHandler: () => {}, // 必须：否则上游 reject 分支会 throw 未捕获异常
        }),
        WORKER_CREATE_TIMEOUT,
        `创建 OCR worker / 下载语言数据（${langsKey}）`
      );
      allWorkers.add(w);
      return w;
    })();
    workerCache.set(langsKey, p);
    p.catch(() => { workerCache.delete(langsKey); });
  }
  return p;
}

/** 销毁并驱逐失效 worker（下次调用会用已缓存的语言数据重建，较快） */
async function evictWorker(langsKey, w) {
  workerCache.delete(langsKey);
  workerChains.delete(langsKey);
  allWorkers.delete(w);
  try { await w.terminate(); } catch { /* ignore */ }
}

/** 同一 worker 上串行执行任务，避免并发消息交错 */
function runOnWorker(langsKey, fn) {
  const prev = workerChains.get(langsKey) || Promise.resolve();
  const next = prev.then(fn);
  workerChains.set(langsKey, next.catch(() => {}));
  return next;
}

// ---------------------------------------------------------------- tools

// 1. ocr-languages：列出支持的语言（无输入）
server.tool(
  'ocr-languages',
  '列出 tesseract.js 支持的 OCR 语言代码（无输入参数）。返回 JSON：{count, languages:[{code, name}]}，code 是传给 ocr-recognize 的 langs 参数的取值（如 eng/chi_sim/chi_tra/jpn/kor/deu/fra/spa），' +
  'name 是对应语言名。多语言用 + 连接（如 chi_sim+eng）。适合在调用 ocr-recognize 前确认目标语言代码是否存在，或让调用方自行决定识别语言。',
  {},
  async () => {
    const languages = Object.entries(LANGS).map(([key, code]) => ({ code, name: key }));
    return text(JSON.stringify({ count: languages.length, languages }, null, 2));
  }
);

// 2. ocr-psm-modes：列出页面分割模式（无输入）
server.tool(
  'ocr-psm-modes',
  '列出 Tesseract 页面分割模式（PSM，Page Segmentation Mode）的值与适用场景（无输入参数）。返回 JSON：{modes:[{value, description}]}。' +
  'PSM 决定引擎如何把图片切分成文本块/行/词：如 3=全自动分页（布局未知的整页）、6=单块文本（默认，纯文本段落）、7=单行文本（标题/验证码）、11=稀疏文本（多列/散落文本）。' +
  '在调用 ocr-recognize 前可用本工具确认 psm 参数取值。',
  {},
  async () => {
    const modes = Object.entries(PSM_DESC).map(([value, description]) => ({ value, description }));
    return text(JSON.stringify({ modes }, null, 2));
  }
);

// 3. ocr-recognize：核心 OCR 识别
server.tool(
  'ocr-recognize',
  '对图片执行 OCR 文字识别，返回识别出的文字 text、平均置信度 confidence（0-100）、引擎 version 等。' +
  '参数：image（必填，输入图片：原始 base64 字符串（推荐，不含 data: 前缀）、data:image/...;base64, data URI、http(s):// 或 file:// URL、或本地文件路径；支持 PNG/JPEG/GIF/BMP/WebP/TIFF）；' +
  'langs（可选，默认 eng，用 + 连接多语言如 chi_sim+eng，可用 ocr-languages 查询代码）；' +
  'psm（可选，页面分割模式值，默认 6=单块文本，常用 3=全自动/7=单行/11=稀疏文本，可用 ocr-psm-modes 查询）；' +
  'whitelist（可选，字符白名单，结果只含这些字符，如 "0123456789" 只识别数字）；' +
  'rectangle（可选，{top,left,width,height} 指定图片内识别区域，单位为像素）；' +
  'rotateAuto（可选布尔，默认 false，自动检测并校正旋转角度）；' +
  'output（可选，逗号分隔的附加输出格式，默认仅 text；可选 text,blocks,tsv,hocr,box,osd,unlv,pdf，其中 pdf 为 base64 编码的二进制需解码后使用，blocks 为词/行/块级结构化 JSON）。' +
  '返回 JSON：{text, confidence, language, psm, version, ...请求的附加格式}。适合把截图/扫描件/表格图片转成可检索文本，或按区域/白名单做定向识别。',
  {
    image: z.string().describe('输入图片：原始 base64（推荐）、data URI、http(s)/file URL 或本地文件路径，支持 PNG/JPEG/GIF/BMP/WebP/TIFF'),
    langs: z.string().describe('识别语言代码，+ 连接多语言，默认 eng；可用 ocr-languages 查询').optional(),
    psm: z.string().describe('页面分割模式值，默认 6；可用 ocr-psm-modes 查询').optional(),
    whitelist: z.string().describe('字符白名单，识别结果只含这些字符').optional(),
    rectangle: z.object({
      top: z.number().int().min(0).describe('区域顶部 y 坐标（像素）'),
      left: z.number().int().min(0).describe('区域左侧 x 坐标（像素）'),
      width: z.number().int().min(1).describe('区域宽度（像素）'),
      height: z.number().int().min(1).describe('区域高度（像素）'),
    }).describe('识别区域 {top,left,width,height}').optional(),
    rotateAuto: z.boolean().describe('自动检测并校正图片旋转角度，默认 false').optional(),
    output: z.string().describe(`附加输出格式，逗号分隔，默认仅 text；可选：${OUTPUT_FORMATS.join(', ')}（pdf 为 base64）`).optional(),
  },
  async (params) => guard(async () => {
    // ---- 参数校验（业务层，返回清晰错误）----
    const langs = (params.langs ?? 'eng').trim();
    const langsArr = langs.split('+').map((s) => s.trim()).filter(Boolean);
    if (langsArr.length === 0) throw new Error('langs 为空：请提供至少一种语言代码，如 eng 或 chi_sim+eng');
    const unknown = langsArr.filter((l) => !LANG_CODES.has(l));
    if (unknown.length > 0) {
      throw new Error(`未知语言代码：${unknown.join(', ')}（可调用 ocr-languages 工具查询全部支持代码，多语言用 + 连接）`);
    }
    const langsKey = [...new Set(langsArr)].sort().join('+');

    const psm = (params.psm ?? '6').trim();
    if (!PSM_VALUES.has(psm)) {
      throw new Error(`未知 psm 值：${psm}（可调用 ocr-psm-modes 工具查询，如 3/6/7/11）`);
    }

    const output = (params.output ?? 'text').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const unknownOut = output.filter((o) => !OUTPUT_FORMATS.includes(o));
    if (unknownOut.length > 0) {
      throw new Error(`未知输出格式：${unknownOut.join(', ')}（可选：${OUTPUT_FORMATS.join(', ')}）`);
    }
    if (!output.includes('text')) output.unshift('text'); // text 始终返回，便于阅读

    const imageArg = normalizeImage(params.image);

    // ---- 组装识别参数：tessedit_* 为透传给引擎的变量，rectangle/rotateAuto 为 tesseract.js 选项 ----
    const options = { tessedit_pageseg_mode: psm };
    if (params.whitelist && params.whitelist.trim()) options.tessedit_char_whitelist = params.whitelist;
    if (params.rectangle) options.rectangle = params.rectangle;
    if (params.rotateAuto) options.rotateAuto = true;

    // 显式声明全部输出开关，避免继承上游 defaultOutput（hocr/tsv 默认 true）造成多余计算
    const outputObj = {
      text: true, blocks: false, hocr: false, tsv: false, box: false,
      osd: false, unlv: false, pdf: false, layoutBlocks: false,
      imageColor: false, imageGrey: false, imageBinary: false, debug: false,
    };
    for (const f of output) outputObj[f] = true;

    // ---- 执行 ----
    const worker = await getWorker(langsKey);
    try {
      return await runOnWorker(langsKey, async () => {
        const { data } = await withTimeout(
          worker.recognize(imageArg, options, outputObj),
          RECOGNIZE_TIMEOUT,
          'OCR 识别'
        );
        const out = {
          text: typeof data.text === 'string' ? data.text : '',
          confidence: typeof data.confidence === 'number' ? Number(data.confidence.toFixed(2)) : null,
          language: langsKey,
          psm,
          version: data.version ?? null,
        };
        for (const f of output) {
          if (f === 'text') continue;
          if (f === 'pdf') {
            const bytes = data.pdf ? Array.from(data.pdf) : [];
            out.pdf = {
              mimeType: 'application/pdf', // 二进制输出：base64 编码，需解码后使用
              base64: Buffer.from(bytes).toString('base64'),
              sizeBytes: bytes.length,
            };
          } else {
            out[f] = data[f] ?? null;
          }
        }
        return text(JSON.stringify(out, null, 2));
      });
    } catch (err) {
      await evictWorker(langsKey, worker);
      throw err;
    }
  })
);

// ---------------------------------------------------------------- 生命周期
// worker_threads 会阻止进程在 stdin 关闭后自然退出，这里统一终止所有 worker 再干净退出
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const tasks = [...allWorkers].map((w) => w.terminate().catch(() => {}));
  allWorkers.clear();
  await Promise.all(tasks);
  process.exit(0);
}
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------- start
const transport = new StdioServerTransport();
await server.connect(transport);
