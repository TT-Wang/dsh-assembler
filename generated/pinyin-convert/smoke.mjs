#!/usr/bin/env node
/** 冒烟:listTools → 三种模式拼音断言('中国')→ 多音字读音列表('好')→ 空文本被拒 → 多字符输入被拒。 */
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

const r1 = await client.callTool({ name: 'to-pinyin', arguments: { text: '中国' } });
check("默认模式带声调 '中国'→'zhōng guó'", text(r1) === 'zhōng guó', text(r1));

const r2 = await client.callTool({ name: 'to-pinyin', arguments: { text: '中国', mode: 'none' } });
check("none 模式不带声调 '中国'→'zhong guo'", text(r2) === 'zhong guo', text(r2));

const r3 = await client.callTool({ name: 'to-pinyin', arguments: { text: '中国', mode: 'first' } });
check("first 模式仅首字母 '中国'→'z g'", text(r3) === 'z g', text(r3));

const r4 = await client.callTool({ name: 'multi-tone', arguments: { char: '好' } });
check("多音字 '好' 含 hǎo 与 hào", text(r4).includes('hǎo') && text(r4).includes('hào'), text(r4));

const r5 = await client.callTool({ name: 'to-pinyin', arguments: { text: '   ' } });
check('空文本被拒', r5.isError === true && text(r5).includes('文本为空'));

const r6 = await client.callTool({ name: 'multi-tone', arguments: { char: '你好' } });
check('多字符输入被拒', r6.isError === true && text(r6).includes('单个汉字'), text(r6));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
