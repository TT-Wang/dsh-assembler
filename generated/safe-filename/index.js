#!/usr/bin/env node
/**
 * MCP stdio server: 把任意字符串/路径中的文件名转成跨平台安全文件名,
 * 基于 filenamify@7.0.2。
 * 能力点:字符串净化、路径 basename 净化——agent 把标题、摘要或任意字符串
 * 变成可直接落盘的文件名,或对完整路径里的文件名做无害化,一轮内完成。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import filenamify, { filenamifyPath } from 'filenamify';

const server = new McpServer({ name: 'safe-filename', version: '0.0.1' });

const sanitizeError = (tool, error) => ({
  isError: true,
  content: [{ type: 'text', text: `${tool}: ${error instanceof Error ? error.message : String(error)}` }],
});

server.registerTool('sanitize', {
  description:
    '把任意字符串转成安全的文件名。会替换 Windows/Unix 保留字符 <>:"/\\|?*、移除控制字符与'
    + '双向控制符、归一化 Unicode 空白、去掉末尾的点与空格,并把 Windows 保留设备名'
    + '(CON/PRN/AUX/NUL/COM1-9/LPT1-9)追加 replacement 后缀。输入待净化字符串,输出安全文件名。'
    + '边界:replacement 不能含保留字符或控制字符(否则返回错误),默认 "!";maxLength 为正整数,'
    + '默认 100,按字素截断且保留扩展名;纯保留字符输入会得到 replacement(默认 "!")。',
  inputSchema: {
    input: z.string().describe('待净化的字符串(可为空串或纯保留字符)'),
    replacement: z.string().optional().describe('替换保留字符用的字符串,默认 "!",不可含 <>:"/\\|?* 或控制字符'),
    maxLength: z.number().int().positive().optional().describe('文件名最大长度,默认 100(截断保留扩展名)'),
  },
}, async ({ input, replacement, maxLength }) => {
  try {
    const options = {};
    if (replacement !== undefined) options.replacement = replacement;
    if (maxLength !== undefined) options.maxLength = maxLength;
    return { content: [{ type: 'text', text: filenamify(input, options) }] };
  } catch (error) {
    return sanitizeError('sanitize', error);
  }
});

server.registerTool('sanitize-path', {
  description:
    '把完整路径里的文件名(最后一段)转成安全文件名,目录部分原样保留。输入路径经 path.resolve '
    + '解析(相对路径按进程工作目录解析),返回净化后的完整路径。适合对 agent 即将落盘的路径做无害化。'
    + '边界与 sanitize 相同:replacement 不能含保留字符或控制字符(否则返回错误),maxLength 为正整数,'
    + '默认 100,截断保留扩展名。',
  inputSchema: {
    path: z.string().describe('待处理的文件路径(如 /tmp/report:final.txt 或 downloads/foo<bar>.pdf)'),
    replacement: z.string().optional().describe('替换保留字符用的字符串,默认 "!",不可含 <>:"/\\|?* 或控制字符'),
    maxLength: z.number().int().positive().optional().describe('文件名最大长度,默认 100(截断保留扩展名)'),
  },
}, async ({ path, replacement, maxLength }) => {
  try {
    const options = {};
    if (replacement !== undefined) options.replacement = replacement;
    if (maxLength !== undefined) options.maxLength = maxLength;
    return { content: [{ type: 'text', text: filenamifyPath(path, options) }] };
  } catch (error) {
    return sanitizeError('sanitize-path', error);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
