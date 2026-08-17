#!/usr/bin/env node
/**
 * 冒烟:listTools → 北京坐标实况(温度量纲与区间)→ 3 天预报(天数/日期/单位)
 * → 错误路径(纬度 999、days=99)。
 * 天气值天天变,所以断言只压"结构 + 量纲 + 合理区间",不压具体数值。
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

// 工具调用统一兜底:意外 reject 也算一条失败,而不是把冒烟整个炸掉。
const call = async (name, args) => {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `callTool 抛出:${e?.message ?? String(e)}` }] };
  }
};

const tools = await client.listTools();
check('listTools 返回 2 个工具', tools.tools.length === 2, tools.tools.map((t) => t.name).join(','));

// ---- current-weather:北京 -------------------------------------------------
const r1 = await call('current-weather', { latitude: 39.9042, longitude: 116.4074 });
const cur = json(r1);
check('current-weather 返回可解析 JSON 且非错误', cur !== null && r1.isError !== true, text(r1).slice(0, 120));
check('温度单位是 °C', cur?.temperature?.unit === '°C', String(cur?.temperature?.unit));
check('温度在 -50..60 合理区间', typeof cur?.temperature?.value === 'number' && cur.temperature.value > -50 && cur.temperature.value < 60, String(cur?.temperature?.value));
check('湿度是 0..100 的百分比', typeof cur?.humidity?.value === 'number' && cur.humidity.value >= 0 && cur.humidity.value <= 100 && cur.humidity.unit === '%', `${cur?.humidity?.value}${cur?.humidity?.unit}`);
check('风速非负且单位 km/h', typeof cur?.windSpeed?.value === 'number' && cur.windSpeed.value >= 0 && cur.windSpeed.unit === 'km/h', `${cur?.windSpeed?.value}${cur?.windSpeed?.unit}`);
check('WMO 码带中文含义', typeof cur?.weather?.code === 'number' && typeof cur?.weather?.description === 'string' && cur.weather.description.length > 0, `${cur?.weather?.code}=${cur?.weather?.description}`);
check('坐标落在北京附近', Math.abs(cur?.location?.latitude - 39.9042) < 1 && Math.abs(cur?.location?.longitude - 116.4074) < 1, `${cur?.location?.latitude},${cur?.location?.longitude}`);
check('观测时刻是 ISO 形状', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(cur?.observedAt ?? ''), String(cur?.observedAt));

// ---- daily-forecast:3 天 --------------------------------------------------
const r2 = await call('daily-forecast', { latitude: 39.9042, longitude: 116.4074, days: 3 });
const fc = json(r2);
check('daily-forecast 天数等于请求的 3', Array.isArray(fc?.days) && fc.days.length === 3, String(fc?.days?.length));
check('每日单位是 °C / mm', fc?.units?.tempMax === '°C' && fc?.units?.tempMin === '°C' && fc?.units?.precipitation === 'mm', JSON.stringify(fc?.units));
const d0 = fc?.days?.[0];
check('首日日期是 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(d0?.date ?? ''), String(d0?.date));
check('首日高低温在区间内且 max>=min', typeof d0?.tempMax === 'number' && typeof d0?.tempMin === 'number' && d0.tempMax > -60 && d0.tempMax < 60 && d0.tempMin > -70 && d0.tempMax >= d0.tempMin, `${d0?.tempMin}..${d0?.tempMax}`);
check('降水量非负', typeof d0?.precipitation === 'number' && d0.precipitation >= 0, String(d0?.precipitation));
check('日期逐日递增', Array.isArray(fc?.days) && fc.days.every((d, i) => i === 0 || d.date > fc.days[i - 1].date), fc?.days?.map((d) => d.date).join(','));

const r3 = await call('daily-forecast', { latitude: 39.9042, longitude: 116.4074, days: 1 });
check('days=1 时只返回 1 天', json(r3)?.days?.length === 1, String(json(r3)?.days?.length));

// ---- 错误路径 --------------------------------------------------------------
const e1 = await call('current-weather', { latitude: 999, longitude: 116.4074 });
check('纬度 999 被拒(isError)', e1.isError === true && text(e1).includes('latitude'), text(e1).slice(0, 80));

const e2 = await call('current-weather', { latitude: 39.9042, longitude: -200 });
check('经度 -200 被拒(isError)', e2.isError === true && text(e2).includes('longitude'), text(e2).slice(0, 80));

const e3 = await call('daily-forecast', { latitude: 39.9042, longitude: 116.4074, days: 99 });
check('days=99 被拒(isError)', e3.isError === true && text(e3).includes('days'), text(e3).slice(0, 80));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
