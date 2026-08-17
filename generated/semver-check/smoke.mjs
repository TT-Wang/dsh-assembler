#!/usr/bin/env node
/** 冒烟:listTools → 版本比较(-1/0)→ 范围判断(true/false)→ 脏输入规范化 → 非法版本与纯文字被拒。 */
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
check('listTools 返回 3 个工具', tools.tools.length === 3, tools.tools.map((t) => t.name).join(','));

const r1 = await client.callTool({ name: 'compare', arguments: { a: '1.2.3', b: '1.10.0' } });
check('1.2.3 vs 1.10.0 比较得 -1', text(r1).startsWith('-1'), text(r1).split('\n')[0]);

const r2 = await client.callTool({ name: 'compare', arguments: { a: '2.0.0', b: '2.0.0' } });
check('相同版本比较得 0', text(r2).startsWith('0'), text(r2).split('\n')[0]);

const r3 = await client.callTool({ name: 'satisfies', arguments: { version: '1.2.3', range: '^1.2.0' } });
check("1.2.3 satisfies '^1.2.0' 为 true", text(r3).startsWith('true'), text(r3).split('\n')[0]);

const r4 = await client.callTool({ name: 'satisfies', arguments: { version: '2.0.0', range: '^1.2.0' } });
check("2.0.0 satisfies '^1.2.0' 为 false", text(r4).startsWith('false'), text(r4).split('\n')[0]);

const r5 = await client.callTool({ name: 'coerce-valid', arguments: { input: 'v1.2' } });
check("'v1.2' 规范化为 1.2.0", text(r5) === '1.2.0', text(r5));

const r6 = await client.callTool({ name: 'compare', arguments: { a: 'abc', b: '1.0.0' } });
check('非法版本号比较被拒', r6.isError === true || JSON.stringify(r6).includes('非法版本号'));

const r7 = await client.callTool({ name: 'coerce-valid', arguments: { input: 'hello' } });
check('纯文字无法 coerce 被拒', r7.isError === true || JSON.stringify(r7).includes('无法从'));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
