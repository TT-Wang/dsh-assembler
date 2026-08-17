#!/usr/bin/env node
/** 冒烟:listTools → 校验通过 → 校验失败带错误路径 → 坏 schema 被拒 → check-schema 好/坏两态 → 2020-12 方言。 */
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

const schema = JSON.stringify({
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer', minimum: 0 },
  },
  required: ['name', 'age'],
});

// 校验通过
const r1 = await client.callTool({ name: 'validate', arguments: { data: '{"name":"tong","age":30}', schema } });
check('合法数据 valid:true', r1.isError !== true && JSON.parse(text(r1)).valid === true, text(r1));

// 校验失败:正常返回 valid:false + 错误明细(不是 isError),断言 instancePath 指到 /age
const r2 = await client.callTool({ name: 'validate', arguments: { data: '{"name":"tong","age":-5}', schema } });
const rep2 = JSON.parse(text(r2));
check('非法数据 valid:false 而非 isError', r2.isError !== true && rep2.valid === false, text(r2));
check('错误明细带 instancePath=/age 与 message',
  Array.isArray(rep2.errors) && rep2.errors.some((e) => e.instancePath === '/age' && typeof e.message === 'string' && e.message.length > 0),
  JSON.stringify(rep2.errors));

// 缺字段:instancePath 为空串、message 提到 age
const r3 = await client.callTool({ name: 'validate', arguments: { data: '{"name":"tong"}', schema } });
const rep3 = JSON.parse(text(r3));
check('缺 required 字段被报出', rep3.valid === false && JSON.stringify(rep3.errors).includes('age'), JSON.stringify(rep3.errors));

// 错误路径:schema 本身非法(type 不是合法类型名)→ isError
const badSchema = '{"type":"not-a-type"}';
const r4 = await client.callTool({ name: 'validate', arguments: { data: '{}', schema: badSchema } });
check('坏 schema 在 validate 被拒 (isError)', r4.isError === true, text(r4).slice(0, 80));

// check-schema:好 schema 通过
const r5 = await client.callTool({ name: 'check-schema', arguments: { schema } });
check('check-schema 判好 schema 合法', r5.isError !== true && JSON.parse(text(r5)).valid === true, text(r5));

// check-schema:坏 schema 得 valid:false(正常结论,非 isError)
const r6 = await client.callTool({ name: 'check-schema', arguments: { schema: badSchema } });
const rep6 = JSON.parse(text(r6));
check('check-schema 判坏 schema valid:false', r6.isError !== true && rep6.valid === false && typeof rep6.reason === 'string', text(r6).slice(0, 100));

// 2020-12 方言:prefixItems 是 2020-12 关键字
const schema2020 = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'array',
  prefixItems: [{ type: 'string' }, { type: 'integer' }],
});
const r7 = await client.callTool({ name: 'check-schema', arguments: { schema: schema2020 } });
const rep7 = JSON.parse(text(r7));
check('2020-12 schema 走 2020-12 方言且合法', rep7.valid === true && String(rep7.dialect).includes('2020-12'), text(r7));

const r8 = await client.callTool({ name: 'validate', arguments: { data: '["x",1]', schema: schema2020 } });
check('2020-12 prefixItems 校验通过', JSON.parse(text(r8)).valid === true, text(r8));

// 错误路径:data 不是合法 JSON
const r9 = await client.callTool({ name: 'validate', arguments: { data: '{oops', schema } });
check('坏 JSON data 被拒 (isError)', r9.isError === true, text(r9).slice(0, 80));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
