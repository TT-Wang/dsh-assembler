#!/usr/bin/env node
/**
 * 冒烟(真实网络):listTools → 2026 CN 节假日清单(元旦/New Year's Day + 条目数)→
 * 周末日期判非工作日 → 节假日(工作日落点)判非工作日 → 普通工作日判工作日 →
 * 国家清单结构 → 错误路径:非法国家码 / 非法日期。
 * 断言只压结构与量纲(字段存在、条目数区间、布尔取值),不压易变的具体数值。
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
/** 从 "抬头\n{json}" 的返回体里取出 JSON 部分 */
const json = (r) => {
  const t = text(r);
  const i = Math.min(...['\n[', '\n{'].map((m) => (t.indexOf(m) === -1 ? Infinity : t.indexOf(m))));
  try { return JSON.parse(t.slice(i + 1)); } catch { return null; }
};

const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname], env: NETWORK_ENV });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
check('listTools 返回 3 个工具', tools.tools.length === 3, tools.tools.map((t) => t.name).join(','));

// --- list-holidays:2026 CN ---
const r1 = await client.callTool({ name: 'list-holidays', arguments: { year: 2026, countryCode: 'CN' } });
const holidays = json(r1);
check('list-holidays 返回数组', Array.isArray(holidays), `type=${typeof holidays}`);
check('2026 CN 节假日条目数 > 5', Array.isArray(holidays) && holidays.length > 5, `count=${Array.isArray(holidays) ? holidays.length : 'n/a'}`);
check('含元旦 或 New Year\'s Day',
  Array.isArray(holidays) && holidays.some((h) => h.localName === '元旦' || /New Year/i.test(h.name || '')),
  Array.isArray(holidays) ? holidays.slice(0, 2).map((h) => `${h.date} ${h.localName}`).join(' | ') : '');
check('每条含 date/localName/name 字段且 date 是 2026-MM-DD',
  Array.isArray(holidays) && holidays.every((h) => /^2026-\d{2}-\d{2}$/.test(h.date) && typeof h.localName === 'string' && typeof h.name === 'string'));

// --- is-workday:周末(2026-08-15 是周六)---
const r2 = await client.callTool({ name: 'is-workday', arguments: { date: '2026-08-15', countryCode: 'CN' } });
const wd2 = json(r2);
check('2026-08-15(周六)判为非工作日', wd2 && wd2.isWorkday === false && wd2.isWeekend === true, `isWorkday=${wd2 && wd2.isWorkday} isWeekend=${wd2 && wd2.isWeekend}`);
check('周末结果带 weekday 与 reason 字段', wd2 && typeof wd2.weekday === 'string' && typeof wd2.reason === 'string', wd2 && wd2.reason);

// --- is-workday:法定节假日且落在工作日(2026-01-01 是周四)---
const r3 = await client.callTool({ name: 'is-workday', arguments: { date: '2026-01-01', countryCode: 'CN' } });
const wd3 = json(r3);
check('2026-01-01(周四,元旦)判为非工作日',
  wd3 && wd3.isWorkday === false && wd3.isPublicHoliday === true && wd3.isWeekend === false,
  `isWorkday=${wd3 && wd3.isWorkday} isHoliday=${wd3 && wd3.isPublicHoliday}`);
check('节假日结果带命中的节日条目', wd3 && Array.isArray(wd3.holidays) && wd3.holidays.length > 0, wd3 && JSON.stringify(wd3.holidays && wd3.holidays[0]));

// --- is-workday:普通工作日(2026-08-19 是周三,非节假日)---
const r4 = await client.callTool({ name: 'is-workday', arguments: { date: '2026-08-19', countryCode: 'CN' } });
const wd4 = json(r4);
check('2026-08-19(周三,非节假日)判为工作日',
  wd4 && wd4.isWorkday === true && wd4.isWeekend === false && wd4.isPublicHoliday === false,
  `isWorkday=${wd4 && wd4.isWorkday}`);

// --- available-countries ---
const r5 = await client.callTool({ name: 'available-countries', arguments: {} });
const countries = json(r5);
check('available-countries 返回数组且数量 > 50', Array.isArray(countries) && countries.length > 50, `count=${Array.isArray(countries) ? countries.length : 'n/a'}`);
check('国家条目形如 {countryCode(2 位), name}',
  Array.isArray(countries) && countries.every((c) => /^[A-Z]{2}$/.test(c.countryCode) && typeof c.name === 'string'));
check('国家清单含 CN', Array.isArray(countries) && countries.some((c) => c.countryCode === 'CN'));

// --- 错误路径 1:非法国家码(格式合法但服务不认识,走真实 404)---
const e1 = await client.callTool({ name: 'list-holidays', arguments: { year: 2026, countryCode: 'ZZ' } });
check('非法国家码 ZZ 被拒(isError)', e1.isError === true, text(e1).slice(0, 110));
check('错误文案点名 Nager.Date 服务', /Nager\.Date/.test(text(e1)));

// --- 错误路径 2:非法日期(本地拦截,不发请求)---
const e2 = await client.callTool({ name: 'is-workday', arguments: { date: '2026-02-30', countryCode: 'CN' } });
check('不存在的日期 2026-02-30 被拒(isError)', e2.isError === true, text(e2).slice(0, 110));

// --- 错误路径 3:三位国家码(常见混淆:CHN)---
const e3 = await client.callTool({ name: 'list-holidays', arguments: { year: 2026, countryCode: 'CHN' } });
check('三位码 CHN 被拒(isError)', e3.isError === true, text(e3).slice(0, 110));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
