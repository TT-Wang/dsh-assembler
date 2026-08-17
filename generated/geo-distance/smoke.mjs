#!/usr/bin/env node
/** 冒烟:listTools → 京沪距离 1060-1070km(快/精两算)→ 方位角+罗盘朝南向 → 中心点/外接框 → lat>90 拒绝。 */
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

const beijing = { lat: 39.9042, lon: 116.4074 };
const shanghai = { lat: 31.2304, lon: 121.4737 };

const tools = await client.listTools();
check('listTools 返回 3 个工具', tools.tools.length === 3, tools.tools.map((t) => t.name).join(','));

const r1 = await client.callTool({ name: 'distance', arguments: { from: beijing, to: shanghai } });
const d1 = JSON.parse(text(r1));
check('京沪距离在 1060-1070km', d1.kilometers > 1060 && d1.kilometers < 1070, `${d1.kilometers}km`);
check('meters 与 kilometers 一致', Math.abs(d1.meters / 1000 - d1.kilometers) < 0.001, `${d1.meters}m`);

const r2 = await client.callTool({ name: 'distance', arguments: { from: beijing, to: shanghai, precise: true, accuracy: 100 } });
const d2 = JSON.parse(text(r2));
check('Vincenty 精确距离与快速算法相差 <10km', Math.abs(d2.meters - d1.meters) < 10000, `${d2.kilometers}km`);

const r3 = await client.callTool({ name: 'bearing', arguments: { from: beijing, to: shanghai } });
const b1 = JSON.parse(text(r3));
check('京→沪方位角在 130-170 度(东南偏南)', b1.bearingDeg > 130 && b1.bearingDeg < 170, `${b1.bearingDeg}°`);
check('罗盘方向朝南向', typeof b1.compass === 'string' && b1.compass.includes('S'), b1.compass);

const r4 = await client.callTool({ name: 'bearing', arguments: { from: beijing, to: shanghai, method: 'rhumb-line' } });
const b2 = JSON.parse(text(r4));
check('等角航线方位角也在 130-170 度', b2.bearingDeg > 130 && b2.bearingDeg < 170, `${b2.bearingDeg}°`);

const r5 = await client.callTool({ name: 'center-and-bounds', arguments: { points: [beijing, shanghai] } });
const cb = JSON.parse(text(r5));
check('中心点落在两城之间', cb.center.lat > 31.3 && cb.center.lat < 39.9 && cb.center.lon > 116.4 && cb.center.lon < 121.5,
  `(${cb.center.lat}, ${cb.center.lon})`);
check('外接框贴合输入坐标', Math.abs(cb.bounds.minLat - 31.2304) < 1e-6 && Math.abs(cb.bounds.maxLat - 39.9042) < 1e-6
  && Math.abs(cb.bounds.minLon - 116.4074) < 1e-6 && Math.abs(cb.bounds.maxLon - 121.4737) < 1e-6, JSON.stringify(cb.bounds));

const r6 = await client.callTool({ name: 'distance', arguments: { from: { lat: 91, lon: 116.4 }, to: shanghai } });
check('非法坐标 lat>90 被拒', r6.isError === true || JSON.stringify(r6).includes('非法'), text(r6).slice(0, 60));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
