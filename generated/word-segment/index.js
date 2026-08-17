#!/usr/bin/env node
/**
 * MCP stdio server: 中文分词工具,基于 segmentit(segmentit@2,node-segment 的 ESM 化魔改)。
 * 能力点:中文文本分词(可带词性标注)、去停用词后的词频关键词提取——
 * agent 做文本切分、索引构建、粗粒度主题提取,一轮内完成。
 *
 * 导入方式说明:segmentit 的 CJS 入口是 `module.exports = 条件 require(...)`,
 * Node 的 cjs-module-lexer 无法静态识别其具名导出,因此必须默认导入后解构。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import segmentitPkg from 'segmentit';

const { Segment, useDefault, cnPOSTag, enPOSTag } = segmentitPkg;

// 全量词典(盘古词典+停用词+同义词)只加载一次,进程内复用。
const segmenter = useDefault(new Segment());

const MAX_LEN = 10000; // 上游实现对长文本的 token 数组会急剧膨胀,设硬上限。

const server = new McpServer({ name: 'word-segment', version: '0.0.1' });

const rejectBadText = (tool, textInput) => {
  if (textInput.trim() === '') {
    return { isError: true, content: [{ type: 'text', text: `${tool}: 文本为空(或全是空白),无可分词内容` }] };
  }
  if (textInput.length > MAX_LEN) {
    return { isError: true, content: [{ type: 'text', text: `${tool}: 文本过长(${textInput.length} 字符,上限 ${MAX_LEN}),请分段调用` }] };
  }
  return null;
};

server.registerTool('segment-text', {
  description:
    '对中文文本分词。输入文本(≤10000 字符);默认返回 JSON 字符串数组(按原文顺序的词序列,含标点)。'
    + 'withPos=true 时返回 JSON 对象数组 [{ w: 词, pos: 中文词性, tag: 结巴风格词性缩写 }]。'
    + '空文本/超长文本返回错误。混有英文、数字的文本可正常处理。',
  inputSchema: {
    text: z.string().describe('待分词的中文文本'),
    withPos: z.boolean().optional().describe('是否附带词性标注(默认 false)'),
  },
}, async ({ text, withPos }) => {
  const bad = rejectBadText('segment-text', text);
  if (bad) return bad;
  const tokens = segmenter.doSegment(text);
  const result = withPos
    ? tokens.map((t) => ({
        w: t.w,
        pos: t.p != null ? cnPOSTag(t.p) : '',
        tag: t.p != null ? enPOSTag(t.p) : '',
      }))
    : tokens.map((t) => t.w);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});

server.registerTool('extract-keywords', {
  description:
    '从中文文本提取高频关键词:先分词,再用库自带停用词表去停用词、去标点,按词频降序取前 topN。'
    + '输入文本(≤10000 字符)与可选 topN(默认 10,上限 100);返回 JSON 数组 [{ word, count }],'
    + '同频词按首次出现顺序排列。这是词频统计而非 TF-IDF,适合单篇文本的粗粒度主题提取。空文本返回错误。',
  inputSchema: {
    text: z.string().describe('待提取关键词的中文文本'),
    topN: z.number().int().positive().max(100).optional().describe('返回的关键词个数(默认 10)'),
  },
}, async ({ text, topN }) => {
  const bad = rejectBadText('extract-keywords', text);
  if (bad) return bad;
  const words = segmenter.doSegment(text, { simple: true, stripPunctuation: true, stripStopword: true });
  const counts = new Map();
  for (const w of words) {
    const word = w.trim();
    if (word === '') continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const result = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN ?? 10)
    .map(([word, count]) => ({ word, count }));
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
