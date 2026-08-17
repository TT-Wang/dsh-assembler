#!/usr/bin/env node
/**
 * MCP stdio server: 汉字转拼音工具,基于 pinyin-pro(pinyin-pro@3)。
 * 能力点:汉字转拼音(声调/无声调/首字母三种模式)、查单字的多音字读音——
 * agent 做注音、排序键生成、缩写提取,一轮内完成。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pinyin, polyphonic } from 'pinyin-pro';

const server = new McpServer({ name: 'pinyin-convert', version: '0.0.1' });

const MODES = {
  tone: {},
  none: { toneType: 'none' },
  first: { pattern: 'first', toneType: 'none' },
};

server.registerTool('to-pinyin', {
  description:
    '把汉字文本转成拼音,字与字之间用空格分隔。mode 三选一:tone(带声调符号,默认,如 zhōng guó)/'
    + 'none(不带声调,如 zhong guo)/first(仅首字母,如 z g)。自动识别多音字取最常用读音;'
    + '非汉字字符原样保留。空文本返回错误。',
  inputSchema: {
    text: z.string().describe('要转换的汉字文本'),
    mode: z.enum(['tone', 'none', 'first']).optional().describe('输出模式:tone 带声调(默认)/none 不带声调/first 仅首字母'),
  },
}, async ({ text, mode }) => {
  if (text.trim() === '') {
    return { isError: true, content: [{ type: 'text', text: 'to-pinyin: 文本为空,没有可转换的内容' }] };
  }
  return { content: [{ type: 'text', text: pinyin(text, MODES[mode ?? 'tone']) }] };
});

server.registerTool('multi-tone', {
  description:
    '查一个汉字的全部多音字读音,返回带声调的读音列表(如 好: hǎo / hào)。'
    + '输入必须是单个汉字;多个字符或非汉字输入返回错误。',
  inputSchema: {
    char: z.string().describe('要查询的单个汉字'),
  },
}, async ({ char }) => {
  if ([...char].length !== 1 || !/^\p{Script=Han}$/u.test(char)) {
    return { isError: true, content: [{ type: 'text', text: `multi-tone: 输入必须是单个汉字,收到 ${JSON.stringify(char)}` }] };
  }
  const readings = polyphonic(char, { type: 'array' })[0] ?? [];
  return { content: [{ type: 'text', text: `${char}: ${readings.join(' / ')}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
