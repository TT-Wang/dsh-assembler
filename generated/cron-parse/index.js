#!/usr/bin/env node
/**
 * MCP stdio server: cron 表达式解析,基于 cron-parser@5。
 * 能力点:算出一条 cron 接下来的执行时间、把表达式各字段展开成人能核对的取值——
 * agent 配置定时任务或答复"这条 cron 什么时候跑"时,一轮内拿到确定答案。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// cron-parser@5 是 CJS 包("type": "commonjs"),默认导入再解构最稳。
import cronParser from 'cron-parser';

const { CronExpressionParser } = cronParser;

const server = new McpServer({ name: 'cron-parse', version: '0.0.1' });

server.registerTool('next-runs', {
  description:
    '解析 cron 表达式,返回接下来 n 次执行时间(ISO 8601,每行一条)。'
    + '支持 5 或 6 段表达式与 @daily 等别名;可选 tz 指定 IANA 时区,'
    + '可选 from 指定起算时间(结果为该时刻之后的执行时间,默认从现在起算)。'
    + '表达式或参数非法时返回错误而不是抛异常。',
  inputSchema: {
    expression: z.string().describe("cron 表达式,如 '0 9 * * 1'(每周一 09:00)"),
    n: z.number().int().min(1).max(100).optional().describe('返回的执行次数,默认 5,最多 100'),
    tz: z.string().optional().describe("IANA 时区名,如 'Asia/Shanghai';不填按 UTC 语义"),
    from: z.string().optional().describe("起算时间,ISO 8601 字符串,如 '2025-01-01T00:00:00Z';默认当前时间"),
  },
}, async ({ expression, n, tz, from }) => {
  try {
    const interval = CronExpressionParser.parse(expression, {
      ...(tz ? { tz } : {}),
      ...(from ? { currentDate: from } : {}),
    });
    const runs = interval.take(n ?? 5).map((d) => d.toISOString() ?? d.toString());
    return { content: [{ type: 'text', text: runs.join('\n') }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `next-runs: cron 表达式或参数无法解析 — ${err.message}` }] };
  }
});

server.registerTool('describe-fields', {
  description:
    '解析 cron 表达式,返回规范化形式(含秒的 6 段写法)与各字段展开后的具体取值'
    + '(second/minute/hour/dayOfMonth/month/dayOfWeek 各一行,通配字段列出全部取值)。'
    + '用于核对一条 cron 到底覆盖哪些时间点。表达式非法时返回错误。',
  inputSchema: {
    expression: z.string().describe("cron 表达式,如 '*/15 9-17 * * 1-5'"),
  },
}, async ({ expression }) => {
  try {
    const interval = CronExpressionParser.parse(expression);
    const f = interval.fields;
    const lines = [
      `normalized: ${interval.stringify(true)}`,
      `second: ${f.second.values.join(',')}`,
      `minute: ${f.minute.values.join(',')}`,
      `hour: ${f.hour.values.join(',')}`,
      `dayOfMonth: ${f.dayOfMonth.values.join(',')}`,
      `month: ${f.month.values.join(',')}`,
      `dayOfWeek: ${f.dayOfWeek.values.join(',')}`,
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `describe-fields: cron 表达式无法解析 — ${err.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
