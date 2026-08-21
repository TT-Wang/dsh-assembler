#!/usr/bin/env node
/**
 * MCP stdio server: 条码/二维码生成,基于 bwip-js@4(纯 JS,无原生依赖)。
 * 能力点:agent 现场生成 code128/EAN-13/QR 等 PNG 图片的 base64——
 * 做标签、单据、分享链接码,一轮内拿到可落盘或内嵌的图片字节。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import bwipjs from 'bwip-js';

// 路径锚点:相对路径一律解析进部署方钉的工作区(PART_WORKDIR,发射端注入),
// 而不是零件进程的 cwd(= host 检出目录)——市场战役 s23 实锤:docx 写进了 host 检出。
const PART_WORKDIR = process.env.PART_WORKDIR || process.cwd();

const server = new McpServer({ name: 'barcode-generate', version: '0.0.1' });

const LINEAR = new Set(['code128', 'ean13', 'upca']);

const BCIDS = [
  ['code128', '通用一维码:编码任意 ASCII 文本,物流、单据、内部编号最常用'],
  ['ean13', '商品条码(国际零售):12 或 13 位数字;给 13 位时末位校验位必须正确,否则报错'],
  ['upca', '商品条码(北美零售):11 或 12 位数字,规则同 ean13'],
  ['qrcode', '二维码:URL、文本、vCard 等,容量大、自带纠错,手机扫码首选'],
  ['pdf417', '堆叠式二维码:证件、登机牌、运单常用,适合较长结构化数据'],
  ['datamatrix', '高密度二维码:极小尺寸下仍可读,电子元件、医疗器械打标常用'],
];

server.registerTool('barcode-png', {
  description:
    '生成条码/二维码 PNG 图片。输入 bcid 码制 + 待编码文本,可选 scale(整体放大倍数,默认 3)'
    + '与 height(一维码条高毫米,默认 10,二维码忽略);一维码自动在条下附人读文本。'
    + '推荐给 savePath(工作区内相对路径):PNG 直接落盘,只返回 "PNG 宽x高, 字节数 → 绝对路径"——'
    + '二进制不过对话上下文。不给 savePath 才内联返回 base64(体积大,仅在确需内联时用)。'
    + '文本不符合码制规则(如 ean13 位数或校验位不对)时报错。',
  inputSchema: {
    bcid: z.enum(['code128', 'ean13', 'upca', 'qrcode', 'pdf417', 'datamatrix']).describe('码制类型(用 barcode-types 查看适用场景)'),
    text: z.string().min(1).describe('要编码的文本'),
    scale: z.number().int().min(1).max(10).optional().describe('放大倍数(默认 3)'),
    height: z.number().min(1).max(60).optional().describe('一维码条高,毫米(默认 10;二维码忽略)'),
    savePath: z.string().optional().describe('落盘路径(相对工作区,如 out/code.png);给了就写文件不回传 base64——推荐'),
  },
}, async ({ bcid, text, scale, height, savePath }) => {
  const opts = { bcid, text, scale: scale ?? 3 };
  if (LINEAR.has(bcid)) {
    opts.height = height ?? 10;
    opts.includetext = true;
    opts.textxalign = 'center';
  }
  try {
    const png = await bwipjs.toBuffer(opts);
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    if (savePath !== undefined) {
      const root = PART_WORKDIR;
      const target = resolve(root, savePath);
      if (target !== root && !target.startsWith(root + sep)) {
        return { isError: true, content: [{ type: 'text', text: `barcode-png: savePath 越出工作区: ${savePath}` }] };
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, png);
      return { content: [{ type: 'text', text: `PNG ${w}x${h}, ${png.length} bytes → ${target}` }] };
    }
    return { content: [{ type: 'text', text: `PNG ${w}x${h}, ${png.length} bytes\n${png.toString('base64')}` }] };
  } catch (err) {
    // bwip-js 的错误可能是字符串也可能是 Error 对象
    return { isError: true, content: [{ type: 'text', text: `barcode-png: ${err?.message ?? String(err)}` }] };
  }
});

server.registerTool('barcode-types', {
  description: '列出 barcode-png 支持的码制(bcid)及各自适用场景,静态说明,无输入。',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: BCIDS.map(([id, desc]) => `${id} — ${desc}`).join('\n') }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
