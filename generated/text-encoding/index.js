#!/usr/bin/env node
/**
 * MCP stdio server: 字符编码转换,基于 iconv-lite@0.7。
 * 能力点:GBK/Big5/Shift_JIS/Win125x 等传统编码的字节与 UTF-8 文本互转
 * (字节以 base64 承载)——agent 处理老编码文件、邮件、接口返回时一轮内完成转码。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import iconv from 'iconv-lite';

const server = new McpServer({ name: 'text-encoding', version: '0.0.1' });

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

server.registerTool('decode-base64', {
  description:
    '把 base64 表示的字节按指定源编码解码为 UTF-8 文本。输入 base64 字符串(内部空白自动忽略)'
    + '与源编码名(如 gbk/big5/shift_jis/win1251/utf16-le,大小写与连字符不敏感)。'
    + '不认识的编码名或不合法的 base64 返回错误;无法映射的字节替换为 �,不抛异常。',
  inputSchema: {
    base64: z.string().describe('字节内容的 base64 表示'),
    encoding: z.string().describe('源编码名,如 gbk/big5/shift_jis'),
  },
}, async ({ base64, encoding }) => {
  if (!iconv.encodingExists(encoding)) {
    return { isError: true, content: [{ type: 'text', text: `decode-base64: 不支持的编码「${encoding}」` }] };
  }
  const cleaned = base64.replace(/\s+/g, '');
  if (!BASE64_RE.test(cleaned) || cleaned.length % 4 !== 0) {
    return { isError: true, content: [{ type: 'text', text: 'decode-base64: 输入不是合法的 base64 字符串' }] };
  }
  try {
    return { content: [{ type: 'text', text: iconv.decode(Buffer.from(cleaned, 'base64'), encoding) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `decode-base64: 解码失败 — ${err?.message ?? err}` }] };
  }
});

server.registerTool('encode-to-base64', {
  description:
    '把 UTF-8 文本按目标编码转成字节,返回字节的 base64 表示。输入文本与目标编码名'
    + '(如 gbk/big5/shift_jis,大小写与连字符不敏感)。不认识的编码名返回错误;'
    + '目标编码表示不了的字符替换为 ?,不抛异常。',
  inputSchema: {
    text: z.string().describe('要编码的 UTF-8 文本'),
    encoding: z.string().describe('目标编码名,如 gbk/big5/shift_jis'),
  },
}, async ({ text, encoding }) => {
  if (!iconv.encodingExists(encoding)) {
    return { isError: true, content: [{ type: 'text', text: `encode-to-base64: 不支持的编码「${encoding}」` }] };
  }
  try {
    return { content: [{ type: 'text', text: iconv.encode(text, encoding).toString('base64') }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `encode-to-base64: 编码失败 — ${err?.message ?? err}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
