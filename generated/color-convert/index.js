#!/usr/bin/env node
/**
 * MCP stdio server: 颜色空间转换与 WCAG 对比度检查,基于 culori(culori@4)。
 * 能力点:任意 CSS 颜色写法解析 → 目标空间表示、两色对比度 + AA/AAA 达标判定——
 * agent 做配色换算、无障碍(可读性)检查,一轮内完成。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { parse, converter, formatHex, formatRgb, formatHsl, formatCss, wcagContrast } from 'culori';

const server = new McpServer({ name: 'color-convert', version: '0.0.1' });

const toOklch = converter('oklch');
const round4 = (v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v);
const round2 = (v) => Math.round(v * 100) / 100;

server.registerTool('convert-color', {
  description:
    '把一个颜色转换成指定颜色空间的表示。输入任意 CSS 写法的颜色字符串(hex 如 #ff0000、rgb()/hsl()/oklch() 函数式、'
    + 'CSS 命名色如 red)与目标空间(hex/rgb/hsl/oklch);返回该空间的 CSS 字符串表示。'
    + '边界:hex 输出忽略透明度(取不带 alpha 的 #rrggbb);无法解析的颜色返回错误而不是猜测。',
  inputSchema: {
    color: z.string().describe('颜色字符串,支持 hex/rgb()/hsl()/oklch()/命名色等 CSS 写法'),
    target: z.enum(['hex', 'rgb', 'hsl', 'oklch']).describe('目标颜色空间'),
  },
}, async ({ color, target }) => {
  const parsed = parse(color.trim());
  if (parsed === undefined) {
    return { isError: true, content: [{ type: 'text', text: `convert-color: 无法解析的颜色 "${color}"(支持 hex/rgb()/hsl()/oklch()/CSS 命名色等写法)` }] };
  }
  let out;
  if (target === 'hex') out = formatHex(parsed);
  else if (target === 'rgb') out = formatRgb(parsed);
  else if (target === 'hsl') out = formatHsl(parsed);
  else {
    const c = toOklch(parsed);
    out = formatCss({ ...c, l: round4(c.l), c: round4(c.c), h: round4(c.h) });
  }
  if (out === undefined) {
    return { isError: true, content: [{ type: 'text', text: `convert-color: 颜色 "${color}" 无法表示为 ${target}` }] };
  }
  return { content: [{ type: 'text', text: out }] };
});

server.registerTool('contrast-check', {
  description:
    '计算两个颜色之间的 WCAG 2.x 相对亮度对比度,并判定各级达标情况。输入两个颜色字符串(任意 CSS 写法);'
    + '返回 JSON:{ ratio, aaNormal(≥4.5), aaLarge(≥3), aaaNormal(≥7), aaaLarge(≥4.5) },ratio 保留两位小数。'
    + '顺序无关(前景/背景互换结果相同);任一颜色无法解析时返回错误。',
  inputSchema: {
    colorA: z.string().describe('颜色 A(如前景色/文字色)'),
    colorB: z.string().describe('颜色 B(如背景色)'),
  },
}, async ({ colorA, colorB }) => {
  const a = parse(colorA.trim());
  if (a === undefined) {
    return { isError: true, content: [{ type: 'text', text: `contrast-check: 无法解析颜色 colorA "${colorA}"` }] };
  }
  const b = parse(colorB.trim());
  if (b === undefined) {
    return { isError: true, content: [{ type: 'text', text: `contrast-check: 无法解析颜色 colorB "${colorB}"` }] };
  }
  const ratio = wcagContrast(a, b);
  const result = {
    ratio: round2(ratio),
    aaNormal: ratio >= 4.5,
    aaLarge: ratio >= 3,
    aaaNormal: ratio >= 7,
    aaaLarge: ratio >= 4.5,
  };
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
