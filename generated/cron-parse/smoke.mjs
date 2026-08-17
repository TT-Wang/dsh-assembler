#!/usr/bin/env node
/** 冒烟:listTools → 固定起点算下 3 次执行(2025-01 的周一)→ 字段展开与规范化 → 非法表达式被拒。 */
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

// 2025-01-01 是周三;'0 9 * * 1' 从此起算的周一 09:00 依次是 1/6、1/13、1/20(UTC)。
const r1 = await client.callTool({
  name: 'next-runs',
  arguments: { expression: '0 9 * * 1', n: 3, tz: 'UTC', from: '2025-01-01T00:00:00Z' },
});
const runs = text(r1).split('\n');
check('返回 3 条执行时间', runs.length === 3, text(r1));
check('第一次执行是 2025-01-06 09:00', runs[0]?.includes('2025-01-06T09:00:00'), runs[0]);
check('第二次执行是 2025-01-13 09:00', runs[1]?.includes('2025-01-13T09:00:00'), runs[1]);

const r2 = await client.callTool({ name: 'describe-fields', arguments: { expression: '0 9 * * 1' } });
const desc = text(r2);
check('规范化为 6 段写法', desc.includes('normalized: 0 0 9 * * 1'), desc.split('\n')[0]);
check('hour 字段展开为 9', desc.includes('hour: 9'));
check('dayOfWeek 字段展开为 1', desc.includes('dayOfWeek: 1'));

const r3 = await client.callTool({ name: 'next-runs', arguments: { expression: '99 * * * *' } });
check('非法表达式(分钟 99)被拒', r3.isError === true || JSON.stringify(r3).includes('无法解析'));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
