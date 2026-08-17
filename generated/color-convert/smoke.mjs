#!/usr/bin/env node
/** 冒烟:listTools → hex→rgb/命名色→hex/rgb→hsl/hex→oklch 转换 → 黑白对比度≈21 与达标判定 → 非法颜色拒绝。 */
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

const r1 = await client.callTool({ name: 'convert-color', arguments: { color: '#ff0000', target: 'rgb' } });
check('#ff0000 → rgb(255, 0, 0)', text(r1).replace(/\s+/g, '') === 'rgb(255,0,0)', text(r1));

const r2 = await client.callTool({ name: 'convert-color', arguments: { color: 'red', target: 'hex' } });
check('命名色 red → #ff0000', text(r2).trim().toLowerCase() === '#ff0000', text(r2));

const r3 = await client.callTool({ name: 'convert-color', arguments: { color: 'rgb(0, 128, 255)', target: 'hsl' } });
check('rgb() → hsl(...) 表示', text(r3).trim().startsWith('hsl(') && text(r3).includes('%'), text(r3));

const r4 = await client.callTool({ name: 'convert-color', arguments: { color: '#ff0000', target: 'oklch' } });
check('hex → oklch(...) 表示', text(r4).trim().startsWith('oklch('), text(r4));

const r5 = await client.callTool({ name: 'contrast-check', arguments: { colorA: 'black', colorB: 'white' } });
const contrast = JSON.parse(text(r5));
check('黑白对比度 ≈ 21', Math.abs(contrast.ratio - 21) < 0.1, `ratio=${contrast.ratio}`);
check('黑白 AA/AAA 全达标', contrast.aaNormal === true && contrast.aaaNormal === true && contrast.aaLarge === true, text(r5));

const r6 = await client.callTool({ name: 'contrast-check', arguments: { colorA: '#777777', colorB: '#888888' } });
const low = JSON.parse(text(r6));
check('近似色对比度低且 AA 不达标', low.ratio < 2 && low.aaNormal === false, `ratio=${low.ratio}`);

const r7 = await client.callTool({ name: 'convert-color', arguments: { color: 'definitely-not-a-color', target: 'hex' } });
check('非法颜色被拒', r7.isError === true || JSON.stringify(r7).includes('无法解析'), text(r7).slice(0, 60));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
