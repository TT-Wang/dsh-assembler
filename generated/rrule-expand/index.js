#!/usr/bin/env node
/**
 * MCP stdio server: RFC 5545 重复规则工具,基于 rrule@2.8。
 * 能力点:把 RRULE 展开成具体发生时间列表、把 RRULE 翻译成人话——
 * agent 处理日历重复规则("每周一"到底落在哪几天)一轮内完成。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// rrule 的 npm main 指向 CJS 打包(dist/es5/rrule.js),Node ESM 下具名导入
// 不可靠:默认导入整个模块对象再解构,并兜底 .default 形状。
import rrulePkg from 'rrule';

const { RRule } = rrulePkg?.RRule ? rrulePkg : rrulePkg.default;

const server = new McpServer({ name: 'rrule-expand', version: '0.0.1' });

/** 解析 RRULE 字符串 + 可选 dtstart,返回 RRule 实例;非法输入抛错(由调用方转 isError)。 */
function buildRule(rule, dtstartIso) {
  const opts = RRule.parseString(rule); // 未知属性/非法星期直接抛错
  if (typeof opts.freq !== 'number') {
    throw new Error('非法或缺失 FREQ(支持 YEARLY/MONTHLY/WEEKLY/DAILY/HOURLY/MINUTELY/SECONDLY)');
  }
  if (dtstartIso !== undefined) {
    const d = new Date(dtstartIso);
    if (Number.isNaN(d.getTime())) throw new Error(`dtstart 不是合法 ISO 8601 时间: ${dtstartIso}`);
    opts.dtstart = d;
  }
  return new RRule(opts);
}

server.registerTool('expand-rrule', {
  description:
    '把 RRULE 重复规则展开成具体发生时间(ISO 8601 列表)。输入 RRULE 字符串与起始时间 dtstart;'
    + '规则里的 COUNT/UNTIL 会被尊重,无终止条件的规则按 limit(默认 100)截断,truncated 字段标明是否截断。'
    + '非法规则(FREQ 拼错、未知属性等)返回错误。',
  inputSchema: {
    rule: z.string().describe("RRULE 内容,如 'FREQ=WEEKLY;BYDAY=MO;COUNT=5'(可带 RRULE: 前缀)"),
    dtstart: z.string().describe('起始时间,ISO 8601,如 2025-01-01T00:00:00Z;不带时区后缀会按服务器本地时区解释,建议带 Z'),
    limit: z.number().int().min(1).max(1000).optional().describe('最多展开条数,默认 100(防无终止规则爆炸)'),
  },
}, async ({ rule, dtstart, limit }) => {
  const cap = limit ?? 100;
  let occurrences;
  try {
    occurrences = buildRule(rule, dtstart).all((_, i) => i < cap);
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `expand-rrule: ${e.message}` }] };
  }
  const out = {
    count: occurrences.length,
    truncated: occurrences.length === cap,
    occurrences: occurrences.map((d) => d.toISOString()),
  };
  return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
});

server.registerTool('describe-rrule', {
  description:
    '把 RRULE 重复规则翻译成人话(英文,如 "every week on Monday for 5 times"),'
    + '并附规范化后的 RRULE 字符串(含 DTSTART,若提供)。规则过于复杂无法完整转文字时,'
    + 'text 字段会说明;非法规则返回错误。',
  inputSchema: {
    rule: z.string().describe("RRULE 内容,如 'FREQ=WEEKLY;BYDAY=MO;COUNT=5'"),
    dtstart: z.string().optional().describe('可选起始时间 ISO 8601,仅影响 normalized 输出'),
  },
}, async ({ rule, dtstart }) => {
  try {
    const r = buildRule(rule, dtstart);
    const out = { text: r.toText(), normalized: r.toString() };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `describe-rrule: ${e.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
