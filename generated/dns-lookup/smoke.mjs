#!/usr/bin/env node
/**
 * 冒烟:listTools → A 记录真实解析(example.com)→ MX 解析(gmail.com)→
 * 不存在域名结构化说明 → 非域名输入拒绝 → 非法 IP 拒绝。
 * 注意:本冒烟需要网络(DNS);离线环境会失败,与 http-request 零件同性质。
 */
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

const r1 = await client.callTool({ name: 'resolve-domain', arguments: { domain: 'example.com' } });
const a = JSON.parse(text(r1));
check('example.com A 记录非空且是 IPv4', a.records.length > 0 && /^\d+\.\d+\.\d+\.\d+$/.test(a.records[0]), JSON.stringify(a.records).slice(0, 60));

const r2 = await client.callTool({ name: 'resolve-domain', arguments: { domain: 'gmail.com', type: 'MX' } });
const mx = JSON.parse(text(r2));
check('gmail.com MX 记录含 google', JSON.stringify(mx.records).toLowerCase().includes('google'), JSON.stringify(mx.records).slice(0, 80));

const r3 = await client.callTool({ name: 'resolve-domain', arguments: { domain: 'definitely-not-a-real-domain-4712.com' } });
check('不存在域名返回结构化说明', text(r3).includes('域名不存在') || text(r3).includes('"records":[]') || text(r3).includes('"records": []'), text(r3).slice(0, 80));

const r4 = await client.callTool({ name: 'resolve-domain', arguments: { domain: 'https://example.com/path' } });
check('带协议输入被拒', JSON.stringify(r4).includes('不是合法裸域名'));

const r5 = await client.callTool({ name: 'reverse-lookup', arguments: { ip: 'not-an-ip' } });
check('非法 IP 被拒', JSON.stringify(r5).includes('不是合法 IP'));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
