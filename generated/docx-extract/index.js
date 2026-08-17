#!/usr/bin/env node
/**
 * MCP stdio server: .docx 提取工具,基于 mammoth@1.12。
 * 能力点:把 Word 文档(docx)一步提取成纯文本或语义化 HTML——
 * agent 拿到用户上传的 docx 后,一轮内读出内容做摘要、检索或改写。
 *
 * 输入二选一:base64 的 docx 字节,或工作区内文件路径。
 * 路径安全:resolve 后必须落在进程 cwd(会话工作区)内,越出即拒。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import mammoth from 'mammoth';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const server = new McpServer({ name: 'docx-extract', version: '0.0.1' });

const inputShape = {
  path: z.string().optional().describe('工作区内 .docx 文件路径(与 base64 二选一,禁止越出工作区)'),
  base64: z.string().optional().describe('.docx 文件字节的 base64 编码(与 path 二选一)'),
};

/** 归一化输入:返回 { input } 可直接喂 mammoth,或 { error } 文本。 */
function resolveInput({ path, base64 }) {
  if ((path == null) === (base64 == null)) {
    return { error: 'path 与 base64 必须且只能提供一个' };
  }
  if (path != null) {
    const root = process.cwd();
    const target = resolve(root, path);
    if (target !== root && !target.startsWith(root + sep)) {
      return { error: `path escapes the workspace: ${path}` };
    }
    if (!existsSync(target)) {
      return { error: `文件不存在: ${path}` };
    }
    return { input: { path: target } };
  }
  const clean = base64.replace(/\s+/g, '');
  if (clean === '' || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    return { error: 'base64 无法解码(非法字符或长度)' };
  }
  return { input: { buffer: Buffer.from(clean, 'base64') } };
}

const fail = (tool, msg) => ({ isError: true, content: [{ type: 'text', text: `${tool}: ${msg}` }] });

server.registerTool('docx-to-text', {
  description:
    '提取 .docx 文档的纯文本(忽略全部格式,每个段落后跟两个换行)。'
    + '输入 base64 的 docx 字节或工作区内路径二选一;路径禁止越出工作区。'
    + '字节不是合法 docx(不是 zip 包或缺文档主体)时报错而不是产出空结果。',
  inputSchema: inputShape,
}, async (args) => {
  const { input, error } = resolveInput(args);
  if (error) return fail('docx-to-text', error);
  try {
    const result = await mammoth.extractRawText(input);
    return { content: [{ type: 'text', text: result.value }] };
  } catch (err) {
    return fail('docx-to-text', `不是合法的 docx:${err?.message ?? String(err)}`);
  }
});

server.registerTool('docx-to-html', {
  description:
    '把 .docx 文档转换成语义化 HTML 片段(Heading 1→h1、列表→ul/ol、表格→table,图片内联为 data URI)。'
    + '输入 base64 的 docx 字节或工作区内路径二选一;路径禁止越出工作区。'
    + '转换过程中 mammoth 产生的警告(如无法映射的样式)附在 HTML 之后的 [messages] 段;'
    + '字节不是合法 docx 时报错。',
  inputSchema: inputShape,
}, async (args) => {
  const { input, error } = resolveInput(args);
  if (error) return fail('docx-to-html', error);
  try {
    const result = await mammoth.convertToHtml(input);
    let text = result.value;
    if (result.messages.length > 0) {
      text += '\n\n[messages]\n' + result.messages.map((m) => `${m.type}: ${m.message}`).join('\n');
    }
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return fail('docx-to-html', `不是合法的 docx:${err?.message ?? String(err)}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
