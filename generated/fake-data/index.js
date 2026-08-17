#!/usr/bin/env node
/**
 * MCP stdio server: 假数据生成工具,基于 @faker-js/faker@10。
 * 能力点:按 schema 批量生成结构化假记录(可选 zh_CN 中文数据、seed 可复现)与
 * lorem 占位文本——agent 造测试数据、填充示例文档,一轮内完成,不访问网络。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { faker, fakerZH_CN } from '@faker-js/faker';

const server = new McpServer({ name: 'fake-data', version: '0.0.1' });

const INSTANCES = { en: faker, zh_CN: fakerZH_CN };

// 可用顶级模块(用于报错提示):faker 实例上含函数成员(模块方法在原型上)的对象属性
const listModules = (f) =>
  Object.keys(f)
    .filter((k) => !k.startsWith('_') && k !== 'definitions' && k !== 'rawDefinitions'
      && f[k] && typeof f[k] === 'object')
    .filter((k) => {
      const proto = Object.getPrototypeOf(f[k]);
      const names = proto ? Object.getOwnPropertyNames(proto) : [];
      return names.some((n) => n !== 'constructor' && typeof f[k][n] === 'function');
    })
    .sort();

const SEG_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

// 解析 'person.fullName' 之类的路径 → { parent, key };失败返回 { error }
const resolvePath = (f, path) => {
  const segs = String(path).split('.');
  if (segs.some((s) => !SEG_RE.test(s) || s === 'constructor' || s === 'prototype')) {
    return { error: `非法路径 "${path}"` };
  }
  let parent = f;
  for (let i = 0; i < segs.length - 1; i++) {
    parent = parent?.[segs[i]];
    if (!parent || typeof parent !== 'object') return { error: `路径 "${path}" 中 "${segs[i]}" 不是可用模块` };
  }
  const key = segs[segs.length - 1];
  if (typeof parent?.[key] !== 'function') return { error: `路径 "${path}" 没有对应的生成方法` };
  return { parent, key };
};

server.registerTool('fake-records', {
  description:
    '按 schema 批量生成假记录,返回 JSON 数组。schema 是 {字段名: faker 方法路径} 映射,'
    + '如 {"name":"person.fullName","email":"internet.email","city":"location.city"};'
    + 'n 为条数(1~100);locale 可选 en(默认)或 zh_CN(中文姓名/地址等);'
    + 'seed 可选,给定后结果可复现(同参数同 seed 两次调用输出一致)。'
    + '非法的 faker 路径返回错误并列出可用顶级模块。生成方法一律无参调用。',
  inputSchema: {
    schema: z.record(z.string()).describe('字段名 → faker 方法路径,如 {"name":"person.fullName"}'),
    n: z.number().int().min(1).max(100).optional().describe('生成条数,1~100,默认 3'),
    locale: z.enum(['en', 'zh_CN']).optional().describe('数据语言,默认 en'),
    seed: z.number().int().optional().describe('随机种子,给定后结果可复现'),
  },
}, async ({ schema, n, locale, seed }) => {
  const f = INSTANCES[locale ?? 'en'];
  const fields = Object.entries(schema);
  if (fields.length === 0) {
    return { isError: true, content: [{ type: 'text', text: 'fake-records: schema 不能为空' }] };
  }
  const resolved = [];
  for (const [field, path] of fields) {
    const r = resolvePath(f, path);
    if (r.error) {
      return {
        isError: true,
        content: [{ type: 'text', text: `fake-records: ${r.error};可用顶级模块:${listModules(f).join(', ')}` }],
      };
    }
    resolved.push([field, r.parent, r.key]);
  }
  if (seed !== undefined) f.seed(seed);
  try {
    const rows = Array.from({ length: n ?? 3 }, () =>
      Object.fromEntries(resolved.map(([field, parent, key]) => [field, parent[key]()])));
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `fake-records: 生成失败 — ${err?.message ?? err}` }] };
  }
});

server.registerTool('fake-text', {
  description:
    '生成 lorem 占位文本。kind 取 sentences(句子,空格连接)/ paragraphs(段落,空行连接)/ words(单词,空格连接),'
    + 'count 为数量(1~50,默认 3);seed 可选,给定后结果可复现。返回纯文本。',
  inputSchema: {
    kind: z.enum(['sentences', 'paragraphs', 'words']).optional().describe('文本单位,默认 sentences'),
    count: z.number().int().min(1).max(50).optional().describe('数量,1~50,默认 3'),
    seed: z.number().int().optional().describe('随机种子,给定后结果可复现'),
  },
}, async ({ kind, count, seed }) => {
  if (seed !== undefined) faker.seed(seed);
  const c = count ?? 3;
  const out = kind === 'paragraphs' ? faker.lorem.paragraphs(c, '\n\n')
    : kind === 'words' ? faker.lorem.words(c)
    : faker.lorem.sentences(c, ' ');
  return { content: [{ type: 'text', text: out }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
