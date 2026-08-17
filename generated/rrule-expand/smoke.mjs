#!/usr/bin/env node
/** 冒烟:listTools → 每周一 COUNT=5 展开(条数/首条/全是周一)→ 无终止规则被 limit 截断 → 人话描述 → 非法 FREQ 被拒。 */
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

// 每周一 COUNT=5,从 2025-01-01(周三)起 → 首条应是 2025-01-06(周一)
const r1 = await client.callTool({ name: 'expand-rrule', arguments: { rule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=5', dtstart: '2025-01-01T00:00:00Z' } });
const e1 = JSON.parse(text(r1));
check('COUNT=5 展开出 5 条', e1.count === 5 && e1.occurrences.length === 5, `count=${e1.count}`);
check('首条是 2025-01-06', String(e1.occurrences[0] ?? '').startsWith('2025-01-06'), e1.occurrences[0]);
check('5 条全是周一(UTC)', e1.occurrences.every((d) => new Date(d).getUTCDay() === 1));
check('COUNT 内未截断', e1.truncated === false);

// 无终止条件的 FREQ=DAILY 被 limit=7 截断
const r2 = await client.callTool({ name: 'expand-rrule', arguments: { rule: 'FREQ=DAILY', dtstart: '2025-03-01T08:00:00Z', limit: 7 } });
const e2 = JSON.parse(text(r2));
check('无终止规则按 limit=7 截断', e2.count === 7 && e2.truncated === true, `count=${e2.count} truncated=${e2.truncated}`);

const r3 = await client.callTool({ name: 'describe-rrule', arguments: { rule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=5', dtstart: '2025-01-01T00:00:00Z' } });
const e3 = JSON.parse(text(r3));
check('人话描述提到 Monday', /monday/i.test(e3.text), e3.text);
check('规范化字符串含 FREQ=WEEKLY', String(e3.normalized).includes('FREQ=WEEKLY'), e3.normalized);

const r4 = await client.callTool({ name: 'expand-rrule', arguments: { rule: 'FREQ=BOGUS;COUNT=5', dtstart: '2025-01-01T00:00:00Z' } });
check('非法 FREQ 被拒', r4.isError === true && /FREQ/.test(text(r4)), text(r4).slice(0, 80));

const r5 = await client.callTool({ name: 'expand-rrule', arguments: { rule: 'FREQ=WEEKLY;COUNT=3', dtstart: 'not-a-date' } });
check('非法 dtstart 被拒', r5.isError === true, text(r5).slice(0, 80));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
