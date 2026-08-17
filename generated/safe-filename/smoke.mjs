#!/usr/bin/env node
/** 冒烟:listTools → sanitize(保留字符/自定义 replacement/末尾点/maxLength 截断/Windows 保留名/空串)
 * → sanitize-path → 非法 replacement 与非法 maxLength 被拒。 */
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

const r1 = await client.callTool({ name: 'sanitize', arguments: { input: '<foo/bar>' } });
check('保留字符被 ! 替换', text(r1) === '!foo!bar!', text(r1));

const r2 = await client.callTool({ name: 'sanitize', arguments: { input: 'foo:"bar"' } });
check('引号与冒号被默认替换', text(r2) === 'foo!bar!', text(r2));

const r3 = await client.callTool({ name: 'sanitize', arguments: { input: 'foo:"bar"', replacement: '🐴' } });
check('自定义 replacement 生效', text(r3) === 'foo🐴bar🐴', text(r3));

const r4 = await client.callTool({ name: 'sanitize', arguments: { input: 'foo.bar...' } });
check('末尾点被去掉', text(r4) === 'foo.bar', text(r4));

const r5 = await client.callTool({ name: 'sanitize', arguments: { input: 'hello world test.txt', maxLength: 16 } });
check('maxLength 截断且保留扩展名', text(r5) === 'hello world.txt', text(r5));

const r6 = await client.callTool({ name: 'sanitize', arguments: { input: 'CON.txt' } });
check('Windows 保留名追加后缀', text(r6) === 'CON!.txt', text(r6));

const r7 = await client.callTool({ name: 'sanitize', arguments: { input: '' } });
check('空串得到 fallback', text(r7) === '!', text(r7));

const r8 = await client.callTool({ name: 'sanitize-path', arguments: { path: '/tmp/report:final.txt' } });
check('路径 basename 净化且目录保持', text(r8) === '/tmp/report!final.txt', text(r8));

const r9 = await client.callTool({ name: 'sanitize', arguments: { input: 'test', replacement: '<' } });
check('非法 replacement 被拒', r9.isError === true && text(r9).includes('Replacement'), text(r9));

let r10Rejected = false;
try {
  const r10 = await client.callTool({ name: 'sanitize', arguments: { input: 'test', maxLength: 0 } });
  r10Rejected = r10.isError === true;
} catch {
  r10Rejected = true;
}
check('非正 maxLength 被拒', r10Rejected);

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
