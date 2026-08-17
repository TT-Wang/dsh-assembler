#!/usr/bin/env node
/**
 * MCP stdio server: TOML 解析/生成工具 on top of smol-toml@1.8(纯 ESM)。
 * 能力点:TOML ⇄ JSON 双向转换——agent 读配置文件、改完写回,一轮内完成。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { parse, stringify, TomlError } from 'smol-toml';

const server = new McpServer({ name: 'toml-parse', version: '0.0.1' });

// smol-toml 解析日期产出 TomlDate(继承 Date,toISOString 按 TOML 语义输出,
// 本地日期得 "1979-05-27" 这种短形),Date.toJSON 会走它的 toISOString,
// JSON.stringify 自然拿到字符串;replacer 兜底处理 bigint(integersAsBigInt 场景)。
const jsonReplacer = (_key, value) => (typeof value === 'bigint' ? value.toString() : value);

server.registerTool('toml-to-json', {
  description:
    '把 TOML 文本解析成 JSON。输入:toml(TOML 文本)。输出:等价 JSON(2 空格缩进);'
    + '日期/时间值转成 TOML 语义的 ISO 字符串(本地日期如 "1979-05-27",带时区如 "1979-05-27T07:32:00.000Z")。'
    + '边界:TOML 语法错误返回 isError,错误信息带行列号与出错位置的代码片段。',
  inputSchema: {
    toml: z.string().describe('要解析的 TOML 文本'),
  },
}, async ({ toml }) => {
  try {
    const doc = parse(toml);
    return { content: [{ type: 'text', text: JSON.stringify(doc, jsonReplacer, 2) }] };
  } catch (e) {
    const loc = e instanceof TomlError ? `(第 ${e.line} 行第 ${e.column} 列)` : '';
    return { isError: true, content: [{ type: 'text', text: `toml-to-json: TOML 解析失败${loc} — ${e.message}` }] };
  }
});

server.registerTool('json-to-toml', {
  description:
    '把 JSON 数据序列化成 TOML 文本。输入:json(JSON 字符串,顶层必须是对象——TOML 文档天然是一张表)。'
    + '输出:TOML 文本。边界(smol-toml 语义):对象里值为 null 的键被忽略(不产出键值对);'
    + '数组里的 null、以及函数/类等不可表示值会被拒绝,返回 isError;'
    + 'json 不是合法 JSON、或顶层不是对象,也返回 isError。',
  inputSchema: {
    json: z.string().describe('要转换的 JSON 数据(字符串形式,顶层为对象)'),
  },
}, async ({ json }) => {
  let data;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `json-to-toml: 输入不是合法 JSON — ${e.message}` }] };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { isError: true, content: [{ type: 'text', text: 'json-to-toml: TOML 顶层必须是对象(一张表),数组/标量/null 无法作为 TOML 文档' }] };
  }
  try {
    return { content: [{ type: 'text', text: stringify(data) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `json-to-toml: 存在 TOML 不可表示的值(如数组里的 null)— ${e.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
