#!/usr/bin/env node
/** 冒烟:listTools → gzip 往返一致 → brotli 往返一致 → 压缩确实变小 → 坏 base64 拒绝 → 算法不匹配拒绝。 */
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

const payload = '重复重复重复重复重复重复重复重复 compressible text '.repeat(20);
const r1 = await client.callTool({ name: 'compress', arguments: { input: payload } });
const [sizes1, b64gz] = text(r1).split('\n');
check('gzip 压缩变小', /^\d+ → \d+ bytes$/.test(sizes1) && Number(sizes1.split(' → ')[1].split(' ')[0]) < Number(sizes1.split(' → ')[0]), sizes1);
const r2 = await client.callTool({ name: 'decompress', arguments: { input: b64gz } });
check('gzip 往返一致', text(r2) === payload);

const r3 = await client.callTool({ name: 'compress', arguments: { input: payload, algorithm: 'brotli' } });
const b64br = text(r3).split('\n')[1];
const r4 = await client.callTool({ name: 'decompress', arguments: { input: b64br, algorithm: 'brotli' } });
check('brotli 往返一致', text(r4) === payload);

const r5 = await client.callTool({ name: 'decompress', arguments: { input: '!!!bad!!!' } });
check('坏 base64 被拒', JSON.stringify(r5).includes('无法解码'));
const r6 = await client.callTool({ name: 'decompress', arguments: { input: b64br } });
check('算法不匹配被拒(brotli 数据按 gzip 解)', JSON.stringify(r6).includes('解压失败'));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
