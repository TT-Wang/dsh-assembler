#!/usr/bin/env node
/**
 * MCP stdio server: JMESPath JSON 查询工具 on top of jmespath@0.16。
 * 能力点:用 JMESPath 表达式在 JSON 文档上取值/过滤/投影,单条与批量两种形态——
 * agent 面对一大坨 JSON 只想要其中几个值时,一轮内查完。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// jmespath 是 CJS(main: jmespath.js, IIFE 挂 exports),ESM 下用默认导入拿整个对象
import jmespath from 'jmespath';

const server = new McpServer({ name: 'json-query', version: '0.0.1' });

/** 解析 JSON 字符串;成功 {ok:true,data} / 失败 {ok:false,err} */
function tryParseJson(text) {
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

server.registerTool('query', {
  description:
    '对 JSON 文档执行一条 JMESPath 表达式,返回查询结果的 JSON 文本。'
    + '输入:json(JSON 字符串)+ expression(JMESPath 表达式,如 a.b[1]、foo[?age>`30`]、foo[*].name)。'
    + '输出:结果值的 JSON 序列化;表达式没匹配到任何东西时返回 null(这是正常结果不是错误)。'
    + '边界:json 不是合法 JSON、或表达式语法错误,各自返回 isError 与具体原因。',
  inputSchema: {
    json: z.string().describe('要查询的 JSON 文档(字符串形式)'),
    expression: z.string().describe('JMESPath 表达式'),
  },
}, async ({ json, expression }) => {
  const parsed = tryParseJson(json);
  if (!parsed.ok) {
    return { isError: true, content: [{ type: 'text', text: `query: 输入不是合法 JSON — ${parsed.err}` }] };
  }
  try {
    const result = jmespath.search(parsed.data, expression);
    return { content: [{ type: 'text', text: JSON.stringify(result === undefined ? null : result) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `query: JMESPath 表达式无效或求值失败 — ${e.message}` }] };
  }
});

server.registerTool('query-multi', {
  description:
    '对同一份 JSON 文档批量执行多条 JMESPath 表达式,一次拿回全部结果。'
    + '输入:json(JSON 字符串)+ expressions(表达式数组,至少一条)。'
    + '输出:{表达式: 结果} 的 JSON 映射,键为原表达式文本,值为该表达式的查询结果'
    + '(没匹配到为 null)。边界:json 非法、或任何一条表达式语法错误,整体返回 isError'
    + '并指出是哪一条表达式出的错(不产出半套结果)。',
  inputSchema: {
    json: z.string().describe('要查询的 JSON 文档(字符串形式)'),
    expressions: z.array(z.string()).min(1).describe('JMESPath 表达式列表'),
  },
}, async ({ json, expressions }) => {
  const parsed = tryParseJson(json);
  if (!parsed.ok) {
    return { isError: true, content: [{ type: 'text', text: `query-multi: 输入不是合法 JSON — ${parsed.err}` }] };
  }
  const results = {};
  for (const expr of expressions) {
    try {
      const value = jmespath.search(parsed.data, expr);
      results[expr] = value === undefined ? null : value;
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: `query-multi: 表达式 ${JSON.stringify(expr)} 无效或求值失败 — ${e.message}` }],
      };
    }
  }
  return { content: [{ type: 'text', text: JSON.stringify(results) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
