#!/usr/bin/env node
/**
 * First-party MCP stdio server: write base64 content to disk as binary.
 * Closes the "parts return base64 but nothing can save it" gap — a PDF or
 * image part's output becomes a real file in one call.
 *
 * Safety: the resolved path must stay inside the process cwd (the session
 * workspace); traversal outside is rejected.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';

const server = new McpServer({ name: 'binary-write', version: '0.0.1' });

server.registerTool('write-binary-file', {
  description:
    '把 base64 内容解码后写成二进制文件(PDF/图片/压缩包等)。path 相对当前工作区,禁止越出工作区;'
    + '返回写入字节数与绝对路径。',
  inputSchema: {
    path: z.string().describe('目标文件路径(相对工作区,如 out/report.pdf)'),
    base64: z.string().describe('文件内容的 base64 编码'),
  },
}, async ({ path, base64 }) => {
  const root = process.cwd();
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(root + sep)) {
    return { isError: true, content: [{ type: 'text', text: `write-binary-file: path escapes the workspace: ${path}` }] };
  }
  const clean = base64.replace(/\s+/g, '');
  if (clean === '' || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    return { isError: true, content: [{ type: 'text', text: 'write-binary-file: base64 无法解码(非法字符或长度)' }] };
  }
  const bytes = Buffer.from(clean, 'base64');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return { content: [{ type: 'text', text: `written ${bytes.length} bytes → ${target}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
