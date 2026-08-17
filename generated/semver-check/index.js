#!/usr/bin/env node
/**
 * MCP stdio server: 语义化版本号工具,基于 semver@7(npm 同款解析器)。
 * 能力点:两个版本谁新谁旧、版本是否落在依赖范围内、脏版本串规范化——
 * agent 处理依赖升级、兼容性判断、changelog 版本核对时一轮内拿到确定结论。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// semver@7 是 CJS 包(main: index.js),整体默认导入。
import semver from 'semver';

const server = new McpServer({ name: 'semver-check', version: '0.0.1' });

server.registerTool('compare', {
  description:
    '比较两个语义化版本号 a 与 b,首行返回 -1/0/1(a 低于/等于/高于 b),'
    + '第二行给出人话结论。遵循 semver 优先级规则(1.10.0 > 1.2.3,预发布低于正式版)。'
    + '任一版本号非法时返回错误。',
  inputSchema: {
    a: z.string().describe("版本号 a,如 '1.2.3'"),
    b: z.string().describe("版本号 b,如 '1.10.0'"),
  },
}, async ({ a, b }) => {
  try {
    const r = semver.compare(a, b);
    const verdict = r === 0 ? `${a} 与 ${b} 版本相等` : r < 0 ? `${a} 低于(旧于)${b}` : `${a} 高于(新于)${b}`;
    return { content: [{ type: 'text', text: `${r}\n${verdict}` }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `compare: 非法版本号 — ${err.message}` }] };
  }
});

server.registerTool('satisfies', {
  description:
    '判断版本号是否落在版本范围内,首行返回 true/false,第二行给出人话结论。'
    + "范围支持 npm 语法:'^1.2.0'、'~1.2.3'、'>=1.0.0 <2.0.0'、'1.x' 等。"
    + '版本号或范围非法时返回错误(而不是含糊地返回 false)。',
  inputSchema: {
    version: z.string().describe("版本号,如 '1.2.3'"),
    range: z.string().describe("版本范围,如 '^1.2.0'"),
  },
}, async ({ version, range }) => {
  if (semver.valid(version) === null) {
    return { isError: true, content: [{ type: 'text', text: `satisfies: 非法版本号 "${version}"` }] };
  }
  if (semver.validRange(range) === null) {
    return { isError: true, content: [{ type: 'text', text: `satisfies: 非法版本范围 "${range}"` }] };
  }
  const ok = semver.satisfies(version, range);
  return { content: [{ type: 'text', text: `${ok}\n${version} ${ok ? '落在' : '不在'}范围 ${range} 内` }] };
});

server.registerTool('coerce-valid', {
  description:
    "把脏版本输入规范化成合法 semver:'v1.2' → '1.2.0'、'v2' → '2.0.0'、"
    + "'release-3.4.5-final' → '3.4.5'。提取不出任何版本号(如纯文字)时返回错误。",
  inputSchema: {
    input: z.string().describe("脏版本串,如 'v1.2'、'2'、'node-v18.17.1-x64'"),
  },
}, async ({ input }) => {
  const coerced = semver.coerce(input);
  if (coerced === null) {
    return { isError: true, content: [{ type: 'text', text: `coerce-valid: 无法从 "${input}" 提取合法 semver` }] };
  }
  return { content: [{ type: 'text', text: coerced.version }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
