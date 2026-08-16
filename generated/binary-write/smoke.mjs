#!/usr/bin/env node
/** 冒烟:listTools → 真实写入(%PDF- 魔数)→ 越界拒绝 → 坏 base64 拒绝。 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};

const cwd = mkdtempSync(join(tmpdir(), 'binary-write-smoke-'));
const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname], cwd });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
check('listTools 返回 1 个工具', tools.tools.length === 1, tools.tools.map(t => t.name).join(','));

const pdfB64 = Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64');
const r1 = await client.callTool({ name: 'write-binary-file', arguments: { path: 'out/probe.pdf', base64: pdfB64 } });
check('写入返回字节数', JSON.stringify(r1).includes('bytes'));
const head = readFileSync(join(cwd, 'out/probe.pdf'), 'utf8').slice(0, 5);
check('落盘文件以 %PDF- 开头', head === '%PDF-', head);

const r2 = await client.callTool({ name: 'write-binary-file', arguments: { path: '../escape.bin', base64: pdfB64 } });
check('越出工作区被拒', JSON.stringify(r2).includes('escapes'));

const r3 = await client.callTool({ name: 'write-binary-file', arguments: { path: 'x.bin', base64: '!!!not-base64!!!' } });
check('坏 base64 被拒', JSON.stringify(r3).includes('无法解码') || JSON.stringify(r3).includes('isError'));

await client.close();
console.log(failures === 0 ? '\n==== 冒烟结果: 全部通过 ✅ ====' : `\n==== 冒烟结果: ${failures} 项失败 ❌ ====`);
process.exit(failures === 0 ? 0 : 1);
