#!/usr/bin/env node
/** 冒烟:listTools → 小写/大写/金额三模式具体值 → 中文转数字往返 → 非数字与非法中文被拒。 */
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

const to = async (value, mode) => text(await client.callTool({ name: 'to-chinese', arguments: mode ? { value, mode } : { value } }));
const from = async (t, mode) => text(await client.callTool({ name: 'from-chinese', arguments: mode ? { text: t, mode } : { text: t } }));

check('10203 小写 → 一万零二百零三', (await to(10203)) === '一万零二百零三', await to(10203));
check('13.5 小写 → 十三点五', (await to('13.5')) === '十三点五', await to('13.5'));
check('1234 大写 → 壹仟贰佰叁拾肆', (await to(1234, 'upper')) === '壹仟贰佰叁拾肆', await to(1234, 'upper'));
check('1234.5 金额 → 人民币壹仟贰佰叁拾肆元伍角', (await to('1234.5', 'money')) === '人民币壹仟贰佰叁拾肆元伍角', await to('1234.5', 'money'));
check('1 金额 → 人民币壹元整', (await to(1, 'money')) === '人民币壹元整', await to(1, 'money'));

check('一万零二百零三 → 10203', (await from('一万零二百零三')) === '10203', await from('一万零二百零三'));
check('壹仟贰佰叁拾肆(auto 判大写)→ 1234', (await from('壹仟贰佰叁拾肆')) === '1234', await from('壹仟贰佰叁拾肆'));
check('负十三点五 → -13.5', (await from('负十三点五')) === '-13.5', await from('负十三点五'));

const roundtrip = await from(await to('9876543210'));
check('9876543210 小写往返一致', roundtrip === '9876543210', roundtrip);

const e1 = await client.callTool({ name: 'to-chinese', arguments: { value: 'abc' } });
check('非数字输入被拒', e1.isError === true, text(e1).slice(0, 60));
const e2 = await client.callTool({ name: 'from-chinese', arguments: { text: 'hello 世界' } });
check('非法中文数字被拒', e2.isError === true, text(e2).slice(0, 60));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
