#!/usr/bin/env node
/** 冒烟:listTools → query 取具体值 → query-multi 映射 → 坏表达式被拒 → 坏 JSON 被拒。 */
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

// query:具体值断言(结果按 JSON 解析比较,不依赖空白格式)
const doc = '{"a":{"b":[1,2,3]}}';
const r1 = await client.callTool({ name: 'query', arguments: { json: doc, expression: 'a.b[1]' } });
check('query a.b[1] 得 2', JSON.parse(text(r1)) === 2, text(r1));

const people = '{"foo":[{"name":"a","age":20},{"name":"b","age":35},{"name":"c","age":40}]}';
const r2 = await client.callTool({ name: 'query', arguments: { json: people, expression: 'foo[?age > `30`].name' } });
check('query 过滤投影得 ["b","c"]', JSON.stringify(JSON.parse(text(r2))) === '["b","c"]', text(r2));

const r3 = await client.callTool({ name: 'query', arguments: { json: doc, expression: 'a.nope' } });
check('query 无匹配返回 null(非错误)', r3.isError !== true && JSON.parse(text(r3)) === null, text(r3));

// query-multi:{表达式: 结果} 映射
const r4 = await client.callTool({ name: 'query-multi', arguments: { json: doc, expressions: ['a.b[0]', 'a.b[2]', 'a.b'] } });
const multi = JSON.parse(text(r4));
check('query-multi 三条表达式各归各位',
  multi['a.b[0]'] === 1 && multi['a.b[2]'] === 3 && JSON.stringify(multi['a.b']) === '[1,2,3]',
  text(r4));

// 错误路径 1:表达式语法错
const r5 = await client.callTool({ name: 'query', arguments: { json: doc, expression: 'a.[' } });
check('坏表达式被拒 (isError)', r5.isError === true, text(r5).slice(0, 80));

// 错误路径 2:JSON 非法
const r6 = await client.callTool({ name: 'query', arguments: { json: '{not json', expression: 'a' } });
check('坏 JSON 被拒 (isError)', r6.isError === true, text(r6).slice(0, 80));

// 错误路径 3:query-multi 中一条坏表达式 → 整体拒且指名
const r7 = await client.callTool({ name: 'query-multi', arguments: { json: doc, expressions: ['a.b[0]', 'a.b['] } });
check('query-multi 坏表达式整体被拒且指名', r7.isError === true && text(r7).includes('a.b['), text(r7).slice(0, 80));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
