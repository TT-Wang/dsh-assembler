#!/usr/bin/env node
/** 冒烟:listTools → 两页真实生成(PK zip 魔数 + 字节数 > 10000 + 首行字节数一致)→ 空 slides 被拒。 */
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
check('listTools 返回 1 个工具', tools.tools.length === 1, tools.tools.map((t) => t.name).join(','));

const slides = [
  { title: '季度回顾', bullets: ['营收 +12%', '成本 -3%', '新客户 48 家'], notes: '开场控制在 2 分钟内' },
  { title: '下季度计划', bullets: ['发布 2.0', '扩张华东市场'] },
];
const r1 = await client.callTool({ name: 'create-pptx', arguments: { slides, themeColor: '0B5394' } });
const out = text(r1);
const nl = out.indexOf('\n');
const head = nl === -1 ? out : out.slice(0, nl);
const buf = Buffer.from(nl === -1 ? '' : out.slice(nl + 1).trim(), 'base64');
check('生成结果非错误', r1.isError !== true, out.slice(0, 80));
check('base64 解码后前 2 字节是 PK(zip 魔数)', buf[0] === 0x50 && buf[1] === 0x4b, `${buf[0]},${buf[1]}`);
check('字节数 > 10000', buf.length > 10000, String(buf.length));
check('首行报告的字节数与实际一致', head.trim().startsWith(`${buf.length} bytes`), head.trim());
check('首行含页数 2 slides', head.includes('2 slides'), head.trim());

const r2 = await client.callTool({ name: 'create-pptx', arguments: { slides: [] } });
check('空 slides 被拒', r2.isError === true && text(r2).includes('空'), text(r2).slice(0, 80));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
