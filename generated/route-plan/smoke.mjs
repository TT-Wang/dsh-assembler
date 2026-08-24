// route-plan 冒烟:真调 OSRM(北京→天津路线 + 三点矩阵)+ 参数闸。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${ok ? '' : ' | ' + d}`); if (!ok) failures++; };
const J = (r) => JSON.parse(r.content[0].text);
const transport = new StdioClientTransport({ command: 'node', args: ['index.js'], env: process.env });
const client = new Client({ name: 'route-smoke', version: '0.0.1' });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check('listTools:3 工具', tools.length === 3 && tools.includes('plan-route') && tools.includes('travel-matrix'), tools.join(','));
  const info = J(await client.callTool({ name: 'route-info', arguments: {} }));
  check('自述端点与坐标顺序(与 geocode 一致)', info.coordinateOrder === '[lon, lat]' && info.profiles.includes('driving'));
  // 北京天安门 → 天津站(真实距离 ~120-160km)
  const r = J(await client.callTool({ name: 'plan-route', arguments: { coordinates: [[116.397, 39.909], [117.208, 39.135]] } }));
  check('真调:北京→天津 距离量级合理(80-250km)', r.distanceMeters > 80000 && r.distanceMeters < 250000, `${r.distanceMeters}m`);
  check('真调:返回时长与转向指引', r.durationSeconds > 1800 && r.legs[0].steps.length > 3, `${r.durationSeconds}s / ${r.legs[0].steps.length} steps`);
  const m = J(await client.callTool({ name: 'travel-matrix', arguments: { coordinates: [[116.397, 39.909], [117.208, 39.135], [114.502, 38.045]] } }));
  check('真调:3×3 矩阵且对角为 0', m.durationsSeconds.length === 3 && m.durationsSeconds[0].length === 3 && m.durationsSeconds[1][1] === 0);
  check('参数闸:单点拒', (await client.callTool({ name: 'plan-route', arguments: { coordinates: [[116, 39]] } })).isError === true);
  check('参数闸:越界坐标拒(纬度 99)', (await client.callTool({ name: 'plan-route', arguments: { coordinates: [[116, 99], [117, 39]] } })).isError === true);
} catch (e) { console.error('SMOKE CRASHED:', e); failures += 1; }
finally { try { await transport.close(); } catch {} }
console.log(`\n${failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
