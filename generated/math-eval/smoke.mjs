#!/usr/bin/env node
/** 冒烟:listTools → 表达式求值(2+3*4=14、sqrt)→ 单位换算(12.7 cm→5 inch)→ 非法表达式与量纲不兼容被拒。 */
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

const r1 = await client.callTool({ name: 'evaluate', arguments: { expression: '2+3*4' } });
check('2+3*4 求出 14', text(r1) === '14', text(r1));

const r2 = await client.callTool({ name: 'evaluate', arguments: { expression: 'sqrt(16)' } });
check('sqrt(16) 求出 4', text(r2) === '4', text(r2));

const r3 = await client.callTool({ name: 'evaluate', arguments: { expression: '0.1 + 0.2' } });
check('0.1+0.2 输出干净的 0.3', text(r3) === '0.3', text(r3));

const r4 = await client.callTool({ name: 'unit-convert', arguments: { value: '12.7 cm', target: 'inch' } });
check('12.7 cm 换算为 5 inch', text(r4).includes('5 inch'), text(r4));

const r5 = await client.callTool({ name: 'evaluate', arguments: { expression: '2+*3' } });
check('非法表达式被拒', r5.isError === true || JSON.stringify(r5).includes('无法求值'));

const r6 = await client.callTool({ name: 'unit-convert', arguments: { value: '5 cm', target: 'kg' } });
check('量纲不兼容换算被拒', r6.isError === true || JSON.stringify(r6).includes('换算失败'));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
