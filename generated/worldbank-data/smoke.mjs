#!/usr/bin/env node
/**
 * 冒烟(真实网络):listTools → CHN GDP 时间序列 → 年份区间过滤 → 常用指标表 →
 * 错误路径:非法指标码 / 非法国家码(两位码 CN)。
 * GDP 数值天天修订,所以只断言**结构与量纲**:数据点数 > 0、value 为正数、
 * 量级 > 1e12(中国 GDP 是万亿美元级,这个数量级几十年内稳定),不断言具体数值。
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
const json = (r) => {
  const t = text(r);
  const i = Math.min(...['\n[', '\n{'].map((m) => (t.indexOf(m) === -1 ? Infinity : t.indexOf(m))));
  const body = Number.isFinite(i) ? t.slice(i + 1) : t;
  try { return JSON.parse(body); } catch { return null; }
};

const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname], env: NETWORK_ENV });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
check('listTools 返回 2 个工具', tools.tools.length === 2, tools.tools.map((t) => t.name).join(','));

// --- country-indicator:CHN GDP(量纲断言)---
const r1 = await client.callTool({ name: 'country-indicator', arguments: { countryIso3: 'CHN', indicator: 'NY.GDP.MKTP.CD' } });
const gdp = json(r1);
check('CHN GDP 查询未报错', r1.isError !== true, text(r1).slice(0, 120));
check('返回 found=true 且带 dataPoints 数组', gdp && gdp.found === true && Array.isArray(gdp.dataPoints), `found=${gdp && gdp.found}`);
check('数据点数 > 0', gdp && gdp.dataPoints.length > 0, `count=${gdp && gdp.dataPoints.length}`);
check('每个数据点形如 {year:整数, value:数字}',
  gdp && gdp.dataPoints.every((p) => Number.isInteger(p.year) && p.year > 1900 && typeof p.value === 'number' && Number.isFinite(p.value)));
check('最新一点 value 为正数', gdp && typeof gdp.latest.value === 'number' && gdp.latest.value > 0, `latest=${gdp && JSON.stringify(gdp.latest)}`);
// 量纲断言:中国 GDP 万亿美元级 —— 稳定的数量级,不是具体数值
check('最新 GDP 量级 > 1e12(万亿美元级)', gdp && gdp.latest.value > 1e12, `value=${gdp && gdp.latest.value}`);
check('最新 GDP 量级 < 1e15(上界防单位漂移)', gdp && gdp.latest.value < 1e15);
check('国家名/指标名被解析出来', gdp && /China/i.test(gdp.countryName || '') && /GDP/i.test(gdp.indicatorName || ''), `${gdp && gdp.countryName} / ${gdp && gdp.indicatorName}`);
check('年份倒序排列', gdp && gdp.dataPoints.every((p, i, a) => i === 0 || a[i - 1].year > p.year));

// --- country-indicator:年份区间过滤(本地过滤路径)---
const r2 = await client.callTool({ name: 'country-indicator', arguments: { countryIso3: 'CHN', indicator: 'SP.POP.TOTL', yearFrom: 2015, yearTo: 2020 } });
const pop = json(r2);
check('CHN 人口 2015-2020 查询未报错', r2.isError !== true, text(r2).slice(0, 120));
check('区间过滤后所有年份都落在 [2015,2020]',
  pop && Array.isArray(pop.dataPoints) && pop.dataPoints.length > 0 && pop.dataPoints.every((p) => p.year >= 2015 && p.year <= 2020),
  pop && pop.dataPoints && pop.dataPoints.map((p) => p.year).join(','));
// 量纲断言:中国人口十亿级
check('人口量级在 1e9–2e9(十亿级)', pop && pop.latest.value > 1e9 && pop.latest.value < 2e9, `value=${pop && pop.latest.value}`);

// --- common-indicators(静态,不联网)---
const r3 = await client.callTool({ name: 'common-indicators', arguments: {} });
const inds = json(r3);
check('common-indicators 返回数组且条目 > 10', Array.isArray(inds) && inds.length > 10, `count=${Array.isArray(inds) ? inds.length : 'n/a'}`);
check('条目含 code/zh/en/unit 四字段', Array.isArray(inds) && inds.every((i) => i.code && i.zh && i.en && i.unit));
check('含 GDP / 人口 / 通胀 / 失业率 的指标码',
  Array.isArray(inds) && ['NY.GDP.MKTP.CD', 'NY.GDP.PCAP.CD', 'SP.POP.TOTL', 'FP.CPI.TOTL.ZG', 'SL.UEM.TOTL.ZS'].every((c) => inds.some((i) => i.code === c)));

const r4 = await client.callTool({ name: 'common-indicators', arguments: { keyword: 'GDP' } });
const filtered = json(r4);
check('关键词过滤只返回匹配项', Array.isArray(filtered) && filtered.length > 0 && filtered.every((i) => /gdp/i.test(i.code + i.zh + i.en)), `count=${Array.isArray(filtered) ? filtered.length : 'n/a'}`);

// --- 错误路径 1:非法指标码(服务端 HTTP 200 + message 数组,必须被识别成错误)---
const e1 = await client.callTool({ name: 'country-indicator', arguments: { countryIso3: 'CHN', indicator: 'NOT.A.REAL.CODE' } });
check('非法指标码被拒(isError)', e1.isError === true, text(e1).slice(0, 130));
check('错误文案点名 World Bank 服务', /World Bank/i.test(text(e1)));

// --- 错误路径 2:两位国家码(常见混淆:CN 应为 CHN,本地拦截)---
const e2 = await client.callTool({ name: 'country-indicator', arguments: { countryIso3: 'CN', indicator: 'NY.GDP.MKTP.CD' } });
check('两位码 CN 被拒并提示用 CHN(isError)', e2.isError === true && /CHN/.test(text(e2)), text(e2).slice(0, 130));

// --- 错误路径 3:年份区间倒置 ---
const e3 = await client.callTool({ name: 'country-indicator', arguments: { countryIso3: 'CHN', indicator: 'SP.POP.TOTL', yearFrom: 2020, yearTo: 2010 } });
check('倒置年份区间被拒(isError)', e3.isError === true, text(e3).slice(0, 110));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
