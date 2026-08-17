#!/usr/bin/env node
/** 冒烟:listTools → 默认 atx/- 转换 → bulletListMarker 与 setext 生效 → 空白输入被拒 → 非字符串被拒。 */
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

const r1 = await client.callTool({ name: 'html-to-markdown', arguments: { html: '<h1>标题</h1><ul><li>甲</li><li>乙</li></ul>' } });
check('默认 atx 标题:含 # 标题', text(r1).includes('# 标题'), JSON.stringify(text(r1)));
check('默认 - 列表符:含 - 甲 与 - 乙', /-\s+甲/.test(text(r1)) && /-\s+乙/.test(text(r1)));  // turndown 列表缩进为 '-   ',断言放宽为 -\s+

const r2 = await client.callTool({ name: 'html-to-markdown', arguments: { html: '<ul><li>甲</li></ul>', bulletListMarker: '*' } });
check('bulletListMarker=* 生效', /\*\s+甲/.test(text(r2)), JSON.stringify(text(r2)));

const r3 = await client.callTool({ name: 'html-to-markdown', arguments: { html: '<h2>次级</h2>', headingStyle: 'setext' } });
check('setext 标题风格生效(下划线式)', text(r3).includes('次级\n--'), JSON.stringify(text(r3)));

const r4 = await client.callTool({ name: 'html-to-markdown', arguments: { html: '   ' } });
check('空白输入被拒', r4.isError === true && text(r4).includes('为空'), text(r4));

let rejected = false;
try {
  const r5 = await client.callTool({ name: 'html-to-markdown', arguments: { html: 12345 } });
  rejected = r5.isError === true;
} catch {
  rejected = true;
}
check('非字符串输入被拒', rejected);

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
