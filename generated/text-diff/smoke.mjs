#!/usr/bin/env node
/** 冒烟:listTools → 补丁生成(含 @@ 头与行统计)→ 补丁应用还原 → 词级标注 → 坏补丁拒绝。 */
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

const oldText = 'line one\nline two\nline three\n';
const newText = 'line one\nline 2\nline three\nline four\n';
const r1 = await client.callTool({ name: 'create-patch', arguments: { oldText, newText } });
const patch = text(r1);
check('补丁含 @@ hunk 头', patch.includes('@@'));
check('补丁含行统计 +2 -1', patch.startsWith('+2 -1'), patch.split('\n')[0]);
check('补丁含具体改动行', patch.includes('-line two') && patch.includes('+line 2'));

const r2 = await client.callTool({ name: 'apply-patch', arguments: { text: oldText, patch: patch.replace(/^\+\d+ -\d+\n/, '') } });
check('补丁应用还原出新文本', text(r2) === newText, JSON.stringify(text(r2)).slice(0, 60));

const r3 = await client.callTool({ name: 'diff-words', arguments: { oldText: '今天 天气 很好', newText: '今天 天气 不错' } });
check('词级标注含删除与新增', text(r3).includes('[-很好-]') && text(r3).includes('{+不错+}'), text(r3));

const r4 = await client.callTool({ name: 'apply-patch', arguments: { text: 'completely different\n', patch: patch.replace(/^\+\d+ -\d+\n/, '') } });
check('不匹配补丁被拒', JSON.stringify(r4).includes('不匹配') || r4.isError === true);

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
