#!/usr/bin/env node
/**
 * MCP stdio server: PowerPoint 生成,基于 pptxgenjs@4。
 * 能力点:agent 把要点大纲直接变成一份可下载的 .pptx——
 * 每页给标题、要点列表与可选备注,一轮内产出整个文件的 base64
 * (可交给 binary-write 零件落盘)。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import PptxGenJS from 'pptxgenjs';

// 路径锚点:相对路径一律解析进部署方钉的工作区(PART_WORKDIR,发射端注入),
// 而不是零件进程的 cwd(= host 检出目录)——市场战役 s23 实锤:docx 写进了 host 检出。
const PART_WORKDIR = process.env.PART_WORKDIR || process.cwd();

const server = new McpServer({ name: 'pptx-generate', version: '0.0.1' });

server.registerTool('create-pptx', {
  description:
    '根据 slides 数组生成 PowerPoint(.pptx,16:9)。每页 { title 标题, bullets 要点列表(可空), notes 演讲者备注(可选) },'
    + '页序即数组顺序;可选 themeColor(6 位十六进制,如 0B5394,默认 1F3864)用于标题着色。'
    + '推荐给 savePath(工作区内相对路径):文件直接落盘,只返回 "字节数 bytes, 页数 slides → 绝对路径"。'
    + '不给 savePath 才内联返回 base64(体积大,仅确需内联时用)。'
    + 'slides 为空数组时报错。',
  inputSchema: {
    slides: z.array(z.object({
      title: z.string().describe('该页标题'),
      bullets: z.array(z.string()).optional().describe('要点列表,每项一行带项目符号(可省略)'),
      notes: z.string().optional().describe('演讲者备注(可省略)'),
    })).describe('页面数组,顺序即页序;不能为空'),
    savePath: z.string().optional().describe('落盘路径(相对工作区,如 out/deck.pptx);给了就写文件不回传 base64——推荐'),
    themeColor: z.string().regex(/^#?[0-9A-Fa-f]{6}$/).optional().describe('主题色,6 位十六进制(可带 #,默认 1F3864)'),
  },
}, async ({ slides, themeColor, savePath }) => {
  if (slides.length === 0) {
    return { isError: true, content: [{ type: 'text', text: 'create-pptx: slides 为空数组,至少需要一页' }] };
  }
  try {
    const color = (themeColor ?? '1F3864').replace(/^#/, '').toUpperCase();
    const pres = new PptxGenJS();
    for (const s of slides) {
      const slide = pres.addSlide();
      slide.addText(s.title, { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 28, bold: true, color });
      if (s.bullets && s.bullets.length > 0) {
        slide.addText(
          s.bullets.map((b) => ({ text: b, options: { bullet: true, fontSize: 16, color: '333333', breakLine: true } })),
          { x: 0.7, y: 1.4, w: 8.6, h: 3.6, valign: 'top' },
        );
      }
      if (s.notes) slide.addNotes(s.notes);
    }
    const base64 = await pres.write({ outputType: 'base64' });
    const buf = Buffer.from(base64, 'base64');
    if (savePath !== undefined) {
      const root = PART_WORKDIR;
      const target = resolve(root, savePath);
      if (target !== root && !target.startsWith(root + sep)) {
        return { isError: true, content: [{ type: 'text', text: `create-pptx: savePath 越出工作区: ${savePath}` }] };
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buf);
      return { content: [{ type: 'text', text: `${buf.length} bytes, ${slides.length} slides → ${target}` }] };
    }
    return { content: [{ type: 'text', text: `${buf.length} bytes, ${slides.length} slides\n${base64}` }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `create-pptx: ${err?.message ?? String(err)}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
