#!/usr/bin/env node
/**
 * MCP stdio server: Unicode 拉丁转写 / URL slug 生成,基于 transliteration@2。
 * 能力点:任意文字转拉丁字母、生成 URL/文件名安全的 slug——agent 起文件名、
 * 造 URL 路径、给非拉丁文本做 ASCII 化,一轮内完成。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { transliterate, slugify } from 'transliteration';

const server = new McpServer({ name: 'transliterate', version: '0.0.1' });

const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });

server.registerTool('transliterate-text', {
  description:
    '把任意文字(中文/希腊文/韩文等各种书写系统)按 Unicode 码点转写成拉丁字母,'
    + '如 transliterate("你好") → "Ni Hao"。逐码点 1:1 映射:中文多音字可能不准,'
    + '日文汉字会按中文拼音转。无法识别的字符被移除。空文本原样返回空串。',
  inputSchema: {
    text: z.string().describe('要转写的文本,任意语言'),
  },
}, async ({ text }) => {
  return { content: [{ type: 'text', text: transliterate(text) }] };
});

server.registerTool('make-slug', {
  description:
    '把文本转成 URL/文件名安全的 slug:先拉丁转写,再小写、用分隔符连接、去掉特殊字符,'
    + '如 "北京 Hello World!" → "bei-jing-hello-world"。可选自定义分隔符(默认 -)。'
    + '文本为空或转写后不剩任何合法字符(如纯符号)时返回错误。',
  inputSchema: {
    text: z.string().describe('要生成 slug 的文本'),
    separator: z.string().optional().describe('分隔符,默认 -'),
  },
}, async ({ text, separator }) => {
  const slug = slugify(text, separator === undefined ? {} : { separator });
  if (slug === '') {
    return fail(`make-slug: 无法生成 slug:输入 ${JSON.stringify(text)} 转写后为空(空文本或纯不可转写符号)`);
  }
  return { content: [{ type: 'text', text: slug }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
