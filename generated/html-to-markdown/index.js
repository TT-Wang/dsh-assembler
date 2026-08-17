#!/usr/bin/env node
/**
 * MCP stdio server: HTML → Markdown 转换,基于 turndown@7。
 * 能力点:把抓取到的网页/富文本 HTML 片段一轮内转成干净可读的 Markdown,
 * 便于 agent 存档、引用或继续加工。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import TurndownService from 'turndown';

const server = new McpServer({ name: 'html-to-markdown', version: '0.0.1' });

server.registerTool('html-to-markdown', {
  description:
    '把 HTML 片段或整页转换为 Markdown 文本。输入 HTML 字符串与可选风格参数:'
    + 'headingStyle(atx=「# 标题」式 / setext=下划线式,默认 atx)、bulletListMarker(-、+ 或 *,默认 -)。'
    + '容忍不闭合标签等不规范 HTML;<script>/<style>/<noscript> 整块丢弃,不进正文。'
    + '空白输入返回错误而不是空结果。',
  inputSchema: {
    html: z.string().describe('要转换的 HTML 文本'),
    headingStyle: z.enum(['atx', 'setext']).optional().describe('标题风格,默认 atx(# 号式)'),
    bulletListMarker: z.enum(['-', '+', '*']).optional().describe('无序列表符号,默认 -'),
  },
}, async ({ html, headingStyle, bulletListMarker }) => {
  if (html.trim() === '') {
    return { isError: true, content: [{ type: 'text', text: 'html-to-markdown: 输入 HTML 为空,没有可转换的内容' }] };
  }
  try {
    const service = new TurndownService({
      headingStyle: headingStyle ?? 'atx',
      bulletListMarker: bulletListMarker ?? '-',
      codeBlockStyle: 'fenced',
    });
    service.remove(['script', 'style', 'noscript']);
    return { content: [{ type: 'text', text: service.turndown(html) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `html-to-markdown: 转换失败 — ${err?.message ?? err}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
