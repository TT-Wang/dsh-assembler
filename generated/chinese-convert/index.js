#!/usr/bin/env node
/**
 * MCP stdio server: 简繁中文互转工具,基于 opencc-js(opencc-js@1)。
 * 能力点:简→繁(支持台湾/香港等目标变体,含词汇级转换)、繁→简——
 * agent 面向不同地区读者改写文本、归一化语料,一轮内完成。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Converter } from 'opencc-js';

const server = new McpServer({ name: 'chinese-convert', version: '0.0.1' });

const S2T_TARGETS = ['tw', 'twp', 'hk', 'hkp', 't'];
const T2S_SOURCES = ['t', 'tw', 'twp', 'hk', 'hkp'];
const converters = new Map();
const getConverter = (from, to) => {
  const key = `${from}>${to}`;
  if (!converters.has(key)) converters.set(key, Converter({ from, to }));
  return converters.get(key);
};

server.registerTool('s2t', {
  description:
    '简体中文转繁体中文。variant 指定目标变体:tw(台湾正体,默认)/twp(台湾正体+词汇转换,如 软件→軟體)/'
    + 'hk(香港繁体)/hkp(香港繁体+词汇转换)/t(OpenCC 标准繁体)。逐短语转换、非中文字符原样保留;'
    + '非法变体返回错误而不是静默回退。',
  inputSchema: {
    text: z.string().describe('要转换的简体中文文本'),
    variant: z.string().optional().describe('目标繁体变体:tw/twp/hk/hkp/t,默认 tw'),
  },
}, async ({ text, variant }) => {
  const to = variant ?? 'tw';
  if (!S2T_TARGETS.includes(to)) {
    return { isError: true, content: [{ type: 'text', text: `s2t: 非法目标变体 ${JSON.stringify(to)},可选:${S2T_TARGETS.join('/')}` }] };
  }
  return { content: [{ type: 'text', text: getConverter('cn', to)(text) }] };
});

server.registerTool('t2s', {
  description:
    '繁体中文转简体中文(大陆简体)。variant 指定来源变体:t(通用繁体,默认)/tw(台湾正体)/'
    + 'twp(台湾正体+词汇还原,如 軟體→软件)/hk(香港繁体)/hkp(香港繁体+词汇还原)。'
    + '非法变体返回错误而不是静默回退。',
  inputSchema: {
    text: z.string().describe('要转换的繁体中文文本'),
    variant: z.string().optional().describe('来源繁体变体:t/tw/twp/hk/hkp,默认 t'),
  },
}, async ({ text, variant }) => {
  const from = variant ?? 't';
  if (!T2S_SOURCES.includes(from)) {
    return { isError: true, content: [{ type: 'text', text: `t2s: 非法来源变体 ${JSON.stringify(from)},可选:${T2S_SOURCES.join('/')}` }] };
  }
  return { content: [{ type: 'text', text: getConverter(from, 'cn')(text) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
