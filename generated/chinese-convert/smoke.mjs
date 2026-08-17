#!/usr/bin/env node
/** 冒烟:listTools → 简→繁('汉语'→'漢語')→ twp 词汇转换('软件'→'軟體')→ 繁→简还原 → 非法变体被拒。 */
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

const r1 = await client.callTool({ name: 's2t', arguments: { text: '汉语' } });
check("默认 tw 变体 '汉语'→'漢語'", text(r1) === '漢語', text(r1));

const r2 = await client.callTool({ name: 's2t', arguments: { text: '软件', variant: 'twp' } });
check("twp 词汇转换 '软件'→'軟體'", text(r2) === '軟體', text(r2));

const r3 = await client.callTool({ name: 's2t', arguments: { text: '汉语', variant: 'hk' } });
check("hk 变体 '汉语'→'漢語'", text(r3) === '漢語', text(r3));

const r4 = await client.callTool({ name: 't2s', arguments: { text: '漢語' } });
check("繁→简 '漢語'→'汉语'", text(r4) === '汉语', text(r4));

const r5 = await client.callTool({ name: 's2t', arguments: { text: '汉语', variant: 'xx' } });
check('非法目标变体被拒', r5.isError === true && text(r5).includes('非法目标变体'), text(r5));

const r6 = await client.callTool({ name: 't2s', arguments: { text: '漢語', variant: 'cn' } });
check('非法来源变体被拒', r6.isError === true && text(r6).includes('非法来源变体'), text(r6));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
