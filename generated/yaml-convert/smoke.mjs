#!/usr/bin/env node
/** 冒烟:listTools → YAML→JSON 解析 → JSON→YAML→JSON 往返一致 → 非法 YAML 被拒(带行号)→ 非法 JSON 被拒。 */
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

const yamlSrc = 'name: dsh\nitems:\n  - 1\n  - two\nnested:\n  ok: true\n';
const r1 = await client.callTool({ name: 'yaml-to-json', arguments: { yamlText: yamlSrc } });
const obj1 = JSON.parse(text(r1));
check('YAML 解析出标量字段', obj1.name === 'dsh');
check('YAML 解析出序列与嵌套', obj1.items[0] === 1 && obj1.items[1] === 'two' && obj1.nested.ok === true);

const r2 = await client.callTool({ name: 'json-to-yaml', arguments: { jsonText: text(r1) } });
check('JSON 转出 YAML 文本', text(r2).includes('name: dsh') && text(r2).includes('- two'), JSON.stringify(text(r2)).slice(0, 60));

const r3 = await client.callTool({ name: 'yaml-to-json', arguments: { yamlText: text(r2), compact: true } });
check('YAML↔JSON 往返一致', text(r3) === JSON.stringify(obj1), text(r3));

const r4 = await client.callTool({ name: 'yaml-to-json', arguments: { yamlText: 'foo: [1, 2' } });
check('非法 YAML 被拒', r4.isError === true && text(r4).includes('解析失败'));
check('YAML 错误带行号定位', /第 \d+ 行/.test(text(r4)), text(r4).split('\n')[1]);

const r5 = await client.callTool({ name: 'json-to-yaml', arguments: { jsonText: '{"bad": ' } });
check('非法 JSON 被拒', r5.isError === true && text(r5).includes('解析失败'));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
