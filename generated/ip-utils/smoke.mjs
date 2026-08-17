#!/usr/bin/env node
/** 冒烟:listTools → 私网/公网/环回地址分类 → IPv6 展开 → CIDR 正反例 → 非法地址与非法 CIDR 被拒。 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};
const text = (r) => (r.content ?? []).map((b) => b.text ?? '').join('');

const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname] });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
check('listTools 返回 2 个工具', tools.tools.length === 2, tools.tools.map((t) => t.name).join(','));

const r1 = await client.callTool({ name: 'parse-ip', arguments: { ip: '192.168.1.1' } });
check('192.168.1.1 → ipv4 private', /"kind":\s*"ipv4"/.test(text(r1)) && /"range":\s*"private"/.test(text(r1)), text(r1).slice(0, 100));

const r2 = await client.callTool({ name: 'parse-ip', arguments: { ip: '8.8.8.8' } });
check('8.8.8.8 → unicast', /"range":\s*"unicast"/.test(text(r2)), text(r2).slice(0, 100));

const r3 = await client.callTool({ name: 'parse-ip', arguments: { ip: '::1' } });
check('::1 → ipv6 loopback', /"kind":\s*"ipv6"/.test(text(r3)) && /"range":\s*"loopback"/.test(text(r3)), text(r3).slice(0, 100));
check('::1 全展开为 8 组 4 位', text(r3).includes('0000:0000:0000:0000:0000:0000:0000:0001'));

const r4 = await client.callTool({ name: 'cidr-match', arguments: { ip: '192.168.1.1', cidr: '192.168.0.0/16' } });
check('192.168.1.1 在 192.168.0.0/16 内', /"match":\s*true/.test(text(r4)), text(r4).slice(0, 100));

const r5 = await client.callTool({ name: 'cidr-match', arguments: { ip: '10.0.0.1', cidr: '192.168.0.0/16' } });
check('10.0.0.1 不在 192.168.0.0/16 内', /"match":\s*false/.test(text(r5)), text(r5).slice(0, 100));

const r6 = await client.callTool({ name: 'parse-ip', arguments: { ip: '999.1.1.1' } });
check('999.1.1.1 被拒', r6.isError === true, text(r6).slice(0, 80));

const r7 = await client.callTool({ name: 'cidr-match', arguments: { ip: '192.168.1.1', cidr: '192.168.0.0/33' } });
check('非法 CIDR /33 被拒', r7.isError === true, text(r7).slice(0, 80));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
