#!/usr/bin/env node
/** 冒烟:listTools → email/url 正反例 → 信用卡测试号 → 邮箱规范化建议 → 清洗三连 → 未知类型/未知操作被拒。 */
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

const validate = async (t, type) => JSON.parse(text(await client.callTool({ name: 'validate-string', arguments: { text: t, type } })));

const e1 = await validate('foo@bar.com', 'email');
check('email 正例判 valid', e1.valid === true, JSON.stringify(e1));
const e2 = await validate('not-an-email', 'email');
check('email 反例判 invalid', e2.valid === false, JSON.stringify(e2));

const u1 = await validate('https://example.com/path?q=1', 'url');
check('url 正例判 valid', u1.valid === true);
const u2 = await validate('not a url at all', 'url');
check('url 反例判 invalid', u2.valid === false);

const cc = await validate('4111111111111111', 'credit-card');
check('信用卡测试号 4111111111111111 判 valid', cc.valid === true);

const en = await validate('Foo.Bar+tag@GMAIL.com', 'email');
check('email 规范化建议 normalizeEmail', en.valid === true && en.normalized === 'foobar@gmail.com', JSON.stringify(en));

const r1 = await client.callTool({ name: 'validate-string', arguments: { text: 'x', type: 'phone-number' } });
check('未知校验类型被拒且列出支持类型', r1.isError === true && text(r1).includes('email'), text(r1).slice(0, 80));

const s1 = await client.callTool({ name: 'sanitize-string', arguments: { text: '<b>hi</b>', op: 'escape' } });
check('escape 转义 HTML', text(s1).includes('&lt;b&gt;hi&lt;'), text(s1));
const s2 = await client.callTool({ name: 'sanitize-string', arguments: { text: text(s1), op: 'unescape' } });
check('unescape 还原', text(s2) === '<b>hi</b>', text(s2));
const s3 = await client.callTool({ name: 'sanitize-string', arguments: { text: '  hi  ', op: 'trim' } });
check('trim 去两侧空白', text(s3) === 'hi', JSON.stringify(text(s3)));
const s4 = await client.callTool({ name: 'sanitize-string', arguments: { text: 'Foo.Bar+tag@GMAIL.com', op: 'normalize-email' } });
check('normalize-email 规范化', text(s4) === 'foobar@gmail.com', text(s4));

const s5 = await client.callTool({ name: 'sanitize-string', arguments: { text: 'x', op: 'rot13' } });
check('未知清洗操作被拒', s5.isError === true, text(s5).slice(0, 60));
const s6 = await client.callTool({ name: 'sanitize-string', arguments: { text: 'not-an-email', op: 'normalize-email' } });
check('normalize-email 非法邮箱被拒', s6.isError === true, text(s6).slice(0, 60));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
