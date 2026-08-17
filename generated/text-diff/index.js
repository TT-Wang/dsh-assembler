#!/usr/bin/env node
/**
 * MCP stdio server: text diff / patch tools on top of jsdiff (diff@9).
 * 能力点:统一 diff 生成、补丁应用、词级差异标注——agent 比较两版文本、
 * 核对改动、把别处生成的补丁落到文本上,一轮内完成。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createTwoFilesPatch, applyPatch, diffWords, diffLines } from 'diff';

const server = new McpServer({ name: 'text-diff', version: '0.0.1' });

server.registerTool('create-patch', {
  description:
    '对比两段文本,生成统一 diff(unified diff)补丁文本。输入旧文本/新文本与可选文件名;'
    + '返回标准补丁(含 ---/+++/@@ 头),可直接交给 apply-patch 或人工审阅。',
  inputSchema: {
    oldText: z.string().describe('旧版本文本'),
    newText: z.string().describe('新版本文本'),
    oldName: z.string().optional().describe('旧文件名(默认 old)'),
    newName: z.string().optional().describe('新文件名(默认 new)'),
  },
}, async ({ oldText, newText, oldName, newName }) => {
  const patch = createTwoFilesPatch(oldName ?? 'old', newName ?? 'new', oldText, newText);
  const stats = diffLines(oldText, newText).reduce(
    (acc, part) => {
      const n = part.value.split('\n').length - (part.value.endsWith('\n') ? 1 : 0);
      if (part.added) acc.added += n;
      else if (part.removed) acc.removed += n;
      return acc;
    },
    { added: 0, removed: 0 },
  );
  return { content: [{ type: 'text', text: `+${stats.added} -${stats.removed}\n${patch}` }] };
});

server.registerTool('apply-patch', {
  description:
    '把统一 diff 补丁应用到文本上,返回打完补丁的新文本。补丁与文本对不上(上下文不匹配)时'
    + '返回错误而不是产出损坏结果。',
  inputSchema: {
    text: z.string().describe('要打补丁的原文本'),
    patch: z.string().describe('统一 diff 补丁(create-patch 的输出格式)'),
  },
}, async ({ text, patch }) => {
  const result = applyPatch(text, patch);
  if (result === false) {
    return { isError: true, content: [{ type: 'text', text: 'apply-patch: 补丁与文本不匹配(上下文对不上),拒绝应用' }] };
  }
  return { content: [{ type: 'text', text: result }] };
});

server.registerTool('diff-words', {
  description:
    '词级对比两段文本,返回带标注的合并视图:新增词包在 {+...+} 里,删除词包在 [-...-] 里,'
    + '未变的词原样保留。适合向用户展示两版措辞的具体差别。',
  inputSchema: {
    oldText: z.string().describe('旧版本文本'),
    newText: z.string().describe('新版本文本'),
  },
}, async ({ oldText, newText }) => {
  const marked = diffWords(oldText, newText)
    .map((p) => (p.added ? `{+${p.value}+}` : p.removed ? `[-${p.value}-]` : p.value))
    .join('');
  return { content: [{ type: 'text', text: marked }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
