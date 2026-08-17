#!/usr/bin/env node
/**
 * MCP stdio server: 数学表达式求值 / 单位换算,基于 mathjs@15。
 * 能力点:安全求值数学表达式(算术、函数、常量)与物理单位换算——agent 需要
 * 精确算数或把 '5 cm' 换成 inch 时,一轮内拿到确定结果,不靠心算。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { evaluate, format } from 'mathjs';

const server = new McpServer({ name: 'math-eval', version: '0.0.1' });

// 统一出口格式:precision 14 抹掉浮点噪声(0.1+0.2 → '0.3'),单位/复数/矩阵同样适用。
const fmt = (v) => format(v, { precision: 14 });

server.registerTool('evaluate', {
  description:
    "安全求值一个数学表达式,返回结果文本。支持算术('2+3*4')、函数('sqrt(16)'、'sin(45 deg)')、"
    + '常量(pi、e)、复数与矩阵。求值在 mathjs 沙箱内进行,不接触 JS 运行时;'
    + '表达式语法错误或无法求值时返回错误而不是抛异常。',
  inputSchema: {
    expression: z.string().describe("数学表达式,如 '2+3*4'、'sqrt(16)'、'sin(45 deg)^2'"),
  },
}, async ({ expression }) => {
  try {
    const result = evaluate(expression);
    if (result === undefined) {
      return { isError: true, content: [{ type: 'text', text: 'evaluate: 表达式没有产生值' }] };
    }
    return { content: [{ type: 'text', text: fmt(result) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `evaluate: 表达式无法求值 — ${err.message}` }] };
  }
});

server.registerTool('unit-convert', {
  description:
    '单位换算:把带单位的量换算到目标单位,如 value=\'12.7 cm\' + target=\'inch\' → \'5 inch\'。'
    + '支持 mathjs 全部内置单位(长度/质量/时间/温度/数据量等)。'
    + '单位不认识或量纲不兼容(如 cm 转 kg)时返回错误。',
  inputSchema: {
    value: z.string().describe("带单位的量,如 '12.7 cm'、'3 kg'、'90 km/h'"),
    target: z.string().describe("目标单位,如 'inch'、'lb'、'm/s'"),
  },
}, async ({ value, target }) => {
  try {
    const result = evaluate(`(${value}) to (${target})`);
    return { content: [{ type: 'text', text: fmt(result) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `unit-convert: 换算失败 — ${err.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
