#!/usr/bin/env node
/** 冒烟:listTools → schema 批量生成 → seed 可复现性 → zh_CN 中文数据 → lorem 文本 → 非法路径被拒。 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};
const text = (r) => r.content.map((b) => b.text ?? '').join('');

const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname] });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
check('listTools 返回 2 个工具', tools.tools.length === 2, tools.tools.map((t) => t.name).join(','));

const args = {
  schema: { name: 'person.fullName', email: 'internet.email', city: 'location.city' },
  n: 3,
  seed: 42,
};
const r1 = await client.callTool({ name: 'fake-records', arguments: args });
const rows = JSON.parse(text(r1));
check('fake-records 生成 3 条记录', Array.isArray(rows) && rows.length === 3);
check('每条记录字段齐全', rows.every((row) => typeof row.name === 'string' && row.name.length > 0
  && typeof row.email === 'string' && row.email.includes('@') && typeof row.city === 'string'),
  JSON.stringify(rows[0]));

const r2 = await client.callTool({ name: 'fake-records', arguments: args });
check('同 seed 两次调用结果一致(可复现)', text(r2) === text(r1));

const r3 = await client.callTool({ name: 'fake-records', arguments: { schema: { name: 'person.fullName' }, n: 5, locale: 'zh_CN', seed: 7 } });
const zhRows = JSON.parse(text(r3));
check('zh_CN 生成 5 条', zhRows.length === 5);
check('zh_CN 姓名含中文字符', zhRows.every((row) => /[一-鿿]/.test(row.name)),
  zhRows.map((row) => row.name).join(','));

const r4 = await client.callTool({ name: 'fake-text', arguments: { kind: 'sentences', count: 2, seed: 1 } });
const lorem = text(r4);
check('fake-text 生成 2 句(至少 2 个句号)', (lorem.match(/\./g) ?? []).length >= 2, lorem.slice(0, 60));
const r5 = await client.callTool({ name: 'fake-text', arguments: { kind: 'words', count: 4, seed: 1 } });
check('fake-text words 生成 4 个词', text(r5).trim().split(/\s+/).length === 4, text(r5));

const r6 = await client.callTool({ name: 'fake-records', arguments: { schema: { x: 'nope.nothing' }, n: 1 } });
check('非法 faker 路径被拒', r6.isError === true, text(r6).slice(0, 80));
check('报错列出可用顶级模块', text(r6).includes('person') && text(r6).includes('internet'), text(r6).slice(0, 120));

const r7 = await client.callTool({ name: 'fake-records', arguments: { schema: { x: '__proto__.polluted' }, n: 1 } });
check('危险路径段被拒', r7.isError === true);

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
