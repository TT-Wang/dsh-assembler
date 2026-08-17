#!/usr/bin/env node
/** 冒烟:listTools → 中文转写(README 示例值)→ slug 全小写无空格无特殊字符 → 自定义分隔符 → 空文本转写返回空串 → 空文本 slug 被拒。 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};
const text = (r) => (r.content ?? []).map((b) => b.text ?? '').join('');
// 空白宽容:折叠连续空白、去首尾,再比较
const squash = (s) => s.replace(/\s+/g, ' ').trim();

const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname] });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
check('listTools 返回 2 个工具', tools.tools.length === 2, tools.tools.map((t) => t.name).join(','));

// README 示例:transliterate('你好') → 'Ni Hao'
const r1 = await client.callTool({ name: 'transliterate-text', arguments: { text: '你好' } });
check("'你好' 转写为 'Ni Hao'", squash(text(r1)) === 'Ni Hao', JSON.stringify(text(r1)));

const r2 = await client.callTool({ name: 'transliterate-text', arguments: { text: '你好, world!' } });
check('中英混排转写含 Ni Hao 与 world', squash(text(r2)).includes('Ni Hao') && text(r2).includes('world'), JSON.stringify(text(r2)));

const r3 = await client.callTool({ name: 'make-slug', arguments: { text: '北京 Hello World!' } });
check("slug 为 'bei-jing-hello-world'", text(r3) === 'bei-jing-hello-world', JSON.stringify(text(r3)));
check('slug 全小写、无空格、无特殊字符', /^[a-z0-9-]+$/.test(text(r3)));

const r4 = await client.callTool({ name: 'make-slug', arguments: { text: '北京 Hello', separator: '_' } });
check('自定义分隔符 _ 生效', /^[a-z0-9_]+$/.test(text(r4)) && text(r4).includes('_'), JSON.stringify(text(r4)));

const r5 = await client.callTool({ name: 'transliterate-text', arguments: { text: '' } });
check('空文本转写返回空串(非 isError)', r5.isError !== true && text(r5) === '', JSON.stringify(text(r5)));

const r6 = await client.callTool({ name: 'make-slug', arguments: { text: '' } });
check('空文本 slug 被拒', r6.isError === true, text(r6).slice(0, 80));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
