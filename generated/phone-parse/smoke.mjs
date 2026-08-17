#!/usr/bin/env node
/** 冒烟:listTools → +86 手机号解析(国家/有效性/类型)→ 无 + 号靠 defaultCountry → 四格式输出 → 过短号码被拒 → 错长度返回 valid:false。 */
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

const r1 = await client.callTool({ name: 'parse-phone', arguments: { number: '+8613800138000' } });
const p1 = JSON.parse(text(r1));
check('+8613800138000 国家为 CN', p1.country === 'CN', text(r1).slice(0, 120));
check('+8613800138000 有效(valid:true)', p1.valid === true && p1.possible === true);
check('e164 为 +8613800138000', p1.e164 === '+8613800138000');
check('类型判为 MOBILE', p1.type === 'MOBILE', String(p1.type));

const r2 = await client.callTool({ name: 'parse-phone', arguments: { number: '13800138000', defaultCountry: 'cn' } });
const p2 = JSON.parse(text(r2));
check('无 + 号靠 defaultCountry(小写 cn 也接受)解析', p2.e164 === '+8613800138000' && p2.country === 'CN');

const r3 = await client.callTool({ name: 'format-phone', arguments: { number: '+8613800138000' } });
const f3 = JSON.parse(text(r3));
check('format e164 精确', f3.e164 === '+8613800138000');
check('format international 是 +86 加空格分组', f3.international.startsWith('+86 ') && f3.international.replace(/\s/g, '') === '+8613800138000', f3.international);
check('format uri 为 tel 链接', f3.uri === 'tel:+8613800138000', f3.uri);

const r4 = await client.callTool({ name: 'parse-phone', arguments: { number: '12345' } });
check('过短且无国家的「12345」被拒', r4.isError === true && text(r4).includes('无法解析'), text(r4));

const r5 = await client.callTool({ name: 'parse-phone', arguments: { number: '+861380013800' } });
const bad = r5.isError === true || JSON.parse(text(r5)).valid === false;
check('错长度号码被拒或返回 valid:false', bad, text(r5).slice(0, 120));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
