#!/usr/bin/env node
/**
 * 冒烟:listTools → 'Beijing' 正向编码(坐标落在北京经纬度窗口)→ 反查该坐标(地址含中国)
 * → 查不到时返回结构化 found:false 而非错误 → 节流闸生效(总耗时下界)→ 错误路径。
 *
 * 断言只压"结构 + 坐标区间 + 语义",不压具体数值:OSM 数据会更新,
 * 同一个地名的 place_id / 小数位 / 候选条数都可能变。
 * 另:本零件按服务条款做了 1 req/s 串行节流,所以这个冒烟会跑十几秒,属预期。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// 网络零件冒烟:必须把代理环境显式传给零件子进程。MCP SDK 的
// StdioClientTransport 默认只透传白名单 env(HOME/PATH/USER…),
// HTTPS_PROXY / NODE_USE_ENV_PROXY 都不在其中——不传的话零件在代理网络下
// 只会报 "fetch failed",看起来像零件坏了,其实是网络路径断了。
const NETWORK_ENV = (() => {
  const e = { ...process.env };
  if ((e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy) && e.NODE_USE_ENV_PROXY === undefined) {
    e.NODE_USE_ENV_PROXY = '1';
  }
  return e;
})();


let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};
const text = (r) => r.content.map((b) => b.text ?? '').join('');
const json = (r) => { try { return JSON.parse(text(r)); } catch { return null; } };

const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname], env: NETWORK_ENV });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const call = async (name, args) => {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `callTool 抛出:${e?.message ?? String(e)}` }] };
  }
};

const tools = await client.listTools();
check('listTools 返回 2 个工具', tools.tools.length === 2, tools.tools.map((t) => t.name).join(','));

console.log('  (以下 5 次真实请求受 1 req/s 节流,预计耗时 >5s)');
const t0 = Date.now();

// ---- geocode-address:Beijing ----------------------------------------------
const r1 = await call('geocode-address', { query: 'Beijing' });
const g1 = json(r1);
check('geocode-address 返回可解析 JSON 且非错误', g1 !== null && r1.isError !== true, text(r1).slice(0, 120));
check('found 为 true 且有结果', g1?.found === true && Array.isArray(g1?.results) && g1.results.length >= 1, String(g1?.count));
const hit = g1?.results?.[0];
check('Beijing 纬度落在 39..41', typeof hit?.latitude === 'number' && hit.latitude > 39 && hit.latitude < 41, String(hit?.latitude));
check('Beijing 经度落在 115..118', typeof hit?.longitude === 'number' && hit.longitude > 115 && hit.longitude < 118, String(hit?.longitude));
check('返回规范化地名 displayName', typeof hit?.displayName === 'string' && hit.displayName.length > 0, String(hit?.displayName));
check('返回地物类别 category/type', typeof hit?.category === 'string' && typeof hit?.type === 'string', `${hit?.category}/${hit?.type}`);
check('boundingBox 四至自洽', typeof hit?.boundingBox?.south === 'number' && hit.boundingBox.south < hit.boundingBox.north && hit.boundingBox.west < hit.boundingBox.east, JSON.stringify(hit?.boundingBox));
check('带 ODbL 署名', typeof g1?.attribution === 'string' && g1.attribution.includes('OpenStreetMap'), String(g1?.attribution).slice(0, 40));

// ---- limit 生效 -------------------------------------------------------------
const r2 = await call('geocode-address', { query: 'Paris', limit: 3 });
const g2 = json(r2);
check('limit=3 时结果条数在 1..3', Array.isArray(g2?.results) && g2.results.length >= 1 && g2.results.length <= 3, String(g2?.results?.length));

// ---- reverse-geocode:北京坐标 ----------------------------------------------
const r3 = await call('reverse-geocode', { latitude: 39.9042, longitude: 116.4074 });
const rev = json(r3);
check('reverse-geocode 命中(found:true)', rev?.found === true && r3.isError !== true, text(r3).slice(0, 120));
check('反查地址含"中国"或 China', /中国|China/.test(rev?.displayName ?? ''), String(rev?.displayName).slice(0, 60));
check('address 拆解出国家码 cn', rev?.address?.country_code === 'cn', String(rev?.address?.country_code));
check('反查回显查询坐标', rev?.queried?.latitude === 39.9042 && rev?.queried?.longitude === 116.4074);

// ---- 查不到 → 结构化结果而非 isError ----------------------------------------
const r4 = await call('geocode-address', { query: 'zzzqqqxxxnotaplace12345' });
const g4 = json(r4);
check('查无此地名:found 为 false 且不是 isError', g4?.found === false && r4.isError !== true, `isError=${r4.isError}`);
check('查无此地名:results 为空数组并给出 hint', Array.isArray(g4?.results) && g4.results.length === 0 && typeof g4?.hint === 'string');

const r5 = await call('reverse-geocode', { latitude: 0, longitude: 0 });
const g5 = json(r5);
check('公海坐标反查:found 为 false 且不是 isError', g5?.found === false && r5.isError !== true, `isError=${r5.isError}`);

// ---- 节流闸:5 次请求 ⇒ 至少 4 个 1100ms 间隔 --------------------------------
const elapsed = Date.now() - t0;
check('1 req/s 节流生效(5 次请求耗时 >=4.3s)', elapsed >= 4300, `${elapsed}ms`);

// ---- 错误路径(本地拦截,不发请求)------------------------------------------
const e1 = await call('reverse-geocode', { latitude: 999, longitude: 116.4074 });
check('纬度 999 被拒(isError)', e1.isError === true && text(e1).includes('latitude'), text(e1).slice(0, 80));

const e2 = await call('reverse-geocode', { latitude: 39.9042, longitude: 200 });
check('经度 200 被拒(isError)', e2.isError === true && text(e2).includes('longitude'), text(e2).slice(0, 80));

const e3 = await call('geocode-address', { query: '   ' });
check('空 query 被拒(isError)', e3.isError === true && text(e3).includes('query'), text(e3).slice(0, 80));

const e4 = await call('geocode-address', { query: 'Beijing', limit: 99 });
check('limit=99 被拒(isError)', e4.isError === true && text(e4).includes('limit'), text(e4).slice(0, 80));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
