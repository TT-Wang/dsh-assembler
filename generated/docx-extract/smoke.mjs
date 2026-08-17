#!/usr/bin/env node
/** 冒烟:listTools → 路径模式提取文本(已知词)→ base64 模式同文件 → HTML 模式含 <p> → 非 docx 字节被拒 → 越界路径被拒 → 双输入被拒。 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};
const text = (r) => r.content.map((b) => b.text ?? '').join('');

// 测试夹具:mammoth 上游仓库自带的最小 docx(已知内容 "Walking on imported air")。
const fixture = new URL('../../.cache/upstream/docx-extract/test/test-data/single-paragraph.docx', import.meta.url).pathname;
const cwd = mkdtempSync(join(tmpdir(), 'docx-extract-smoke-'));
mkdirSync(join(cwd, 'in'), { recursive: true });
copyFileSync(fixture, join(cwd, 'in', 'single-paragraph.docx'));

const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname], cwd });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
check('listTools 返回 2 个工具', tools.tools.length === 2, tools.tools.map((t) => t.name).join(','));

const r1 = await client.callTool({ name: 'docx-to-text', arguments: { path: 'in/single-paragraph.docx' } });
check('路径模式提取文本含已知词', text(r1).includes('Walking on imported air'), JSON.stringify(text(r1).trim().slice(0, 60)));

const b64 = readFileSync(fixture).toString('base64');
const r2 = await client.callTool({ name: 'docx-to-text', arguments: { base64: b64 } });
check('base64 模式提取同样文本', text(r2).includes('Walking on imported air'));

const r3 = await client.callTool({ name: 'docx-to-html', arguments: { base64: b64 } });
check('HTML 模式产出 <p> 段落', text(r3).includes('<p>') && text(r3).includes('Walking on imported air'), text(r3).trim().slice(0, 80));

const r4 = await client.callTool({ name: 'docx-to-text', arguments: { base64: Buffer.from('this is not a docx file').toString('base64') } });
check('非 docx 字节被拒', r4.isError === true, text(r4).slice(0, 80));

const r5 = await client.callTool({ name: 'docx-to-text', arguments: { path: '../escape.docx' } });
check('越出工作区路径被拒', r5.isError === true && text(r5).includes('escapes'), text(r5).slice(0, 80));

const r6 = await client.callTool({ name: 'docx-to-text', arguments: { path: 'in/single-paragraph.docx', base64: b64 } });
check('path 与 base64 同时给被拒', r6.isError === true, text(r6).slice(0, 80));

await client.close();
rmSync(cwd, { recursive: true, force: true });
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
