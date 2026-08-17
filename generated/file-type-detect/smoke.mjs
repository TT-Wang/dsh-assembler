#!/usr/bin/env node
/** 冒烟:listTools → 真实 1x1 PNG 认出 png → zlib 现造 gzip 字节认出 gz → 纯文本走"无法识别"结构化路径 → 坏 base64 被拒。 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { gzipSync } from 'node:zlib';

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

// 真实 1x1 PNG(硬编码 base64,70 字节,含完整 PNG 签名 + IHDR)
const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const r1 = await client.callTool({ name: 'detect-file-type', arguments: { base64: pngB64 } });
const e1 = JSON.parse(text(r1));
check('PNG 认出 ext=png', e1.recognized === true && e1.ext === 'png', JSON.stringify(e1));
check('PNG mime=image/png', e1.mime === 'image/png', e1.mime);

// zlib 现造 gzip 字节(1F 8B 08 开头)
const gzB64 = gzipSync(Buffer.from('hello file-type smoke')).toString('base64');
const r2 = await client.callTool({ name: 'detect-file-type', arguments: { base64: gzB64 } });
const e2 = JSON.parse(text(r2));
check('gzip 认出 ext=gz', e2.recognized === true && e2.ext === 'gz', JSON.stringify(e2));
check('gzip mime 含 gzip', String(e2.mime).includes('gzip'), e2.mime);

// 纯文本没有魔数 → 结构化"无法识别",非错误
const r3 = await client.callTool({ name: 'detect-file-type', arguments: { base64: Buffer.from('hello').toString('base64') } });
const e3 = JSON.parse(text(r3));
check('纯文本走无法识别路径(非错误)', r3.isError !== true && e3.recognized === false && String(e3.note).includes('无法识别'), e3.note);

// 坏 base64 被拒
const r4 = await client.callTool({ name: 'detect-file-type', arguments: { base64: 'not base64 at all!!!' } });
check('坏 base64 被拒', r4.isError === true, text(r4).slice(0, 80));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
