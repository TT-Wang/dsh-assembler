#!/usr/bin/env node
/** 冒烟:listTools → '中文' 经 gbk 编码为已知 base64 → 解码还原(往返一致)→ 不支持编码被拒 → 坏 base64 被拒。 */
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

const r1 = await client.callTool({ name: 'encode-to-base64', arguments: { text: '中文', encoding: 'gbk' } });
check('「中文」gbk 编码为已知字节 1tDOxA==', text(r1) === '1tDOxA==', text(r1));

const r2 = await client.callTool({ name: 'decode-base64', arguments: { base64: text(r1), encoding: 'gbk' } });
check('gbk 解码还原「中文」(往返一致)', text(r2) === '中文', JSON.stringify(text(r2)));

const r3 = await client.callTool({ name: 'decode-base64', arguments: { base64: 'LU6HZQ==', encoding: 'utf16-le' } });
check('utf16-le 解码出「中文」', text(r3) === '中文', JSON.stringify(text(r3)));

const r4 = await client.callTool({ name: 'encode-to-base64', arguments: { text: '中文', encoding: 'no-such-encoding' } });
check('不支持的编码名被拒(encode)', r4.isError === true && text(r4).includes('不支持'), text(r4));

const r5 = await client.callTool({ name: 'decode-base64', arguments: { base64: '1tDOxA==', encoding: 'not-an-encoding' } });
check('不支持的编码名被拒(decode)', r5.isError === true && text(r5).includes('不支持'), text(r5));

const r6 = await client.callTool({ name: 'decode-base64', arguments: { base64: '!!!不是base64!!!', encoding: 'gbk' } });
check('不合法 base64 被拒', r6.isError === true && text(r6).includes('base64'), text(r6));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
