#!/usr/bin/env node
/** 冒烟:listTools → sha256 已知向量 → base64 字节哈希 → HMAC 签名+校验 → UUID 格式/数量 → 坏 base64 拒绝。 */
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
check('listTools 返回 3 个工具', tools.tools.length === 3, tools.tools.map((t) => t.name).join(','));

// 已知向量:sha256("abc")
const r1 = await client.callTool({ name: 'hash-text', arguments: { input: 'abc' } });
check('sha256 已知向量', text(r1) === 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', text(r1));

const r2 = await client.callTool({ name: 'hash-text', arguments: { input: Buffer.from('abc').toString('base64'), inputKind: 'base64' } });
check('base64 字节哈希与文本一致', text(r2) === text(r1));

const r3 = await client.callTool({ name: 'hmac-sign', arguments: { text: 'payload', key: 'secret' } });
check('HMAC 输出 64 位 hex', /^[0-9a-f]{64}$/.test(text(r3)), text(r3).slice(0, 20));
const r4 = await client.callTool({ name: 'hmac-sign', arguments: { text: 'payload', key: 'secret', expected: text(r3) } });
check('HMAC 校验匹配', text(r4) === 'match: true');
const r5 = await client.callTool({ name: 'hmac-sign', arguments: { text: 'payload', key: 'secret', expected: 'deadbeef' } });
check('HMAC 错误签名不匹配', text(r5).startsWith('match: false'));

const r6 = await client.callTool({ name: 'generate-uuid', arguments: { count: 3 } });
const uuids = text(r6).split('\n');
check('UUID 3 个且格式合法', uuids.length === 3 && uuids.every((u) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u)));

const r7 = await client.callTool({ name: 'hash-text', arguments: { input: '!!!bad!!!', inputKind: 'base64' } });
check('坏 base64 被拒', JSON.stringify(r7).includes('无法解码'));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
