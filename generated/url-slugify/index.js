#!/usr/bin/env node
/**
 * MCP stdio server: url-slugify on top of @sindresorhus/slugify (3.0.0).
 * 能力点:单条文本转 slug、批量标题转唯一 slug(锚点/文件名去重)、自定义替换
 * 与保留字符——覆盖 agent 生成 URL、文件名、markdown 锚点 id 的典型需求,一轮内完成。
 * 上游为 ESM-only(Node >=20):默认导出 slugify,命名导出 slugifyWithCounter。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import slugify, { slugifyWithCounter } from '@sindresorhus/slugify';

const server = new McpServer({ name: 'url-slugify', version: '0.0.1' });

/** 把 zod 里已声明的共享选项拼成库的 options 对象(undefined 不传,保持库默认) */
const pickOptions = ({ separator, lowercase, decamelize, locale, transliterate }) => {
  const options = {};
  if (separator !== undefined) options.separator = separator;
  if (lowercase !== undefined) options.lowercase = lowercase;
  if (decamelize !== undefined) options.decamelize = decamelize;
  if (locale !== undefined) options.locale = locale;
  if (transliterate !== undefined) options.transliterate = transliterate;
  return options;
};

const fail = (tool, message) => ({
  isError: true,
  content: [{ type: 'text', text: `${tool}: ${message}` }],
});

/** slugify / slugify-unique 共用的可选选项 schema */
const COMMON_OPTIONS = {
  separator: z.string().optional().describe('词与词之间的连接符,默认 "-";传 "" 表示不分割'),
  lowercase: z.boolean().optional().describe('是否转小写,默认 true'),
  decamelize: z.boolean().optional().describe('是否把驼峰拆成词(fooBar → foo-bar),默认 true'),
  locale: z.string().optional().describe('语言相关音译与小写,如 "sv" 使 Räksmörgås → raksmorgas;默认不指定'),
  transliterate: z.boolean().optional().describe('是否把非 ASCII 字符音译成 ASCII,默认 true;false 时保留原字符'),
};

server.registerTool('slugify', {
  description:
    '把单条文本转成 URL/文件名/ID 安全的 slug:小写、空格与标点换成连接符、驼峰分词、'
    + 'Unicode 音译成 ASCII(♥→love、Déjà→deja,支持西里尔/阿拉伯/德越土等主要语言)。'
    + '输入 text(必填);可选 separator/lowercase/decamelize/locale/transliterate。'
    + '返回 slug 字符串;locale 非法或参数组合冲突时返回错误。',
  inputSchema: {
    text: z.string().min(1, 'text 不能为空').describe('要转 slug 的原始文本'),
    ...COMMON_OPTIONS,
  },
}, async ({ text, ...rest }) => {
  try {
    return { content: [{ type: 'text', text: slugify(text, pickOptions(rest)) }] };
  } catch (error) {
    return fail('slugify', error.message);
  }
});

server.registerTool('slugify-unique', {
  description:
    '把一组标题/条目批量转成互不重复的 slug 列表(典型场景:markdown 标题生成唯一锚点 id、'
    + '同名文件去重)。重复项自动追加 -2、-3……(第一次出现不加后缀),顺序与输入一致。'
    + '输入 texts(必填,至少 1 条);可选 separator/lowercase/decamelize/locale/transliterate。'
    + '每次调用使用全新计数器,结果只取决于本次输入、可重复复现;空字符串条目返回 ""。'
    + '返回 JSON 字符串数组。',
  inputSchema: {
    texts: z.array(z.string()).min(1, 'texts 至少需要 1 条').describe('要转 slug 的文本列表'),
    ...COMMON_OPTIONS,
  },
}, async ({ texts, ...rest }) => {
  try {
    const options = pickOptions(rest);
    const countable = slugifyWithCounter();
    return { content: [{ type: 'text', text: JSON.stringify(texts.map((t) => countable(t, options))) }] };
  } catch (error) {
    return fail('slugify-unique', error.message);
  }
});

server.registerTool('slugify-custom', {
  description:
    '定制化转写:自定义替换表(先于内置 ♥/&/🦄 替换执行,同名键覆盖内置;目标串带空格会自动分词)、'
    + '保留指定字符(如 URL 锚点 "#"、点号)、保留前导下划线/尾随连字符(隐藏文件名、slug 输入校验场景)。'
    + '输入 text(必填);可选 customReplacements([[源串, 目标串], …])、preserveCharacters(字符数组,'
    + '不能包含 separator)、preserveLeadingUnderscore、preserveTrailingDash、separator。'
    + '返回 slug 字符串;preserveCharacters 与 separator 冲突时返回错误。',
  inputSchema: {
    text: z.string().min(1, 'text 不能为空').describe('要转 slug 的原始文本'),
    customReplacements: z.array(z.tuple([
      z.string().min(1, '替换源不能为空'),
      z.string(),
    ])).optional().describe('自定义替换对列表,如 [["@", " at "]]'),
    preserveCharacters: z.array(z.string().min(1)).optional().describe('要保留的字符列表,如 ["#"];不能包含 separator'),
    preserveLeadingUnderscore: z.boolean().optional().describe('保留前导下划线(默认 false)'),
    preserveTrailingDash: z.boolean().optional().describe('保留尾随连字符(默认 false)'),
    separator: z.string().optional().describe('词与词之间的连接符,默认 "-"'),
  },
}, async ({ text, customReplacements, preserveCharacters, preserveLeadingUnderscore, preserveTrailingDash, separator }) => {
  try {
    const options = {};
    if (customReplacements !== undefined) options.customReplacements = customReplacements;
    if (preserveCharacters !== undefined) options.preserveCharacters = preserveCharacters;
    if (preserveLeadingUnderscore !== undefined) options.preserveLeadingUnderscore = preserveLeadingUnderscore;
    if (preserveTrailingDash !== undefined) options.preserveTrailingDash = preserveTrailingDash;
    if (separator !== undefined) options.separator = separator;
    return { content: [{ type: 'text', text: slugify(text, options) }] };
  } catch (error) {
    return fail('slugify-custom', error.message);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
