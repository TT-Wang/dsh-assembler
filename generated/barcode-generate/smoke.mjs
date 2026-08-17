#!/usr/bin/env node
/** 冒烟:listTools → 码制清单 → code128 真实生成(PNG 魔数)→ ean13 合法校验位生成 → 非法 bcid 被拒 → ean13 位数不对被拒。 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};
const text = (r) => r.content.map((b) => b.text ?? '').join('');

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const decodePng = (r) => {
  const out = text(r);
  const nl = out.indexOf('\n');
  return Buffer.from(nl === -1 ? '' : out.slice(nl + 1).trim(), 'base64');
};
const isPng = (buf) => buf.length >= 8 && PNG_MAGIC.every((b, i) => buf[i] === b);

const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname] });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
check('listTools 返回 2 个工具', tools.tools.length === 2, tools.tools.map((t) => t.name).join(','));

const r1 = await client.callTool({ name: 'barcode-types', arguments: {} });
check('码制清单含 code128 与 qrcode', text(r1).includes('code128') && text(r1).includes('qrcode'));

const r2 = await client.callTool({ name: 'barcode-png', arguments: { bcid: 'code128', text: 'Hello-12345' } });
check('code128 生成非错误', r2.isError !== true, text(r2).slice(0, 80));
check('code128 前 8 字节是 PNG 魔数', isPng(decodePng(r2)), Array.from(decodePng(r2).subarray(0, 8)).join(','));
check('code128 首行报告宽高', /^PNG \d+x\d+/.test(text(r2).trim()), text(r2).trim().split('\n')[0]);

const r3 = await client.callTool({ name: 'barcode-png', arguments: { bcid: 'ean13', text: '9781234567897' } });
check('ean13(合法校验位)生成 PNG', r3.isError !== true && isPng(decodePng(r3)), text(r3).trim().split('\n')[0]);

const r4 = await client.callTool({ name: 'barcode-png', arguments: { bcid: 'qrcode', text: 'https://example.com/x?y=1' } });
check('qrcode 生成 PNG', r4.isError !== true && isPng(decodePng(r4)), text(r4).trim().split('\n')[0]);

// 非法 bcid:被 zod enum 挡下(SDK 可能以协议错误抛出,也可能以 isError 返回)
let badBcidRejected = false;
try {
  const r5 = await client.callTool({ name: 'barcode-png', arguments: { bcid: 'nope', text: 'x' } });
  badBcidRejected = r5.isError === true;
} catch {
  badBcidRejected = true;
}
check('非法 bcid 被拒', badBcidRejected);

const r6 = await client.callTool({ name: 'barcode-png', arguments: { bcid: 'ean13', text: '1234' } });
check('ean13 位数不对被拒', r6.isError === true, text(r6).slice(0, 80));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
