#!/usr/bin/env node
/**
 * 冒烟:listTools → 最新汇率(量纲区间)→ 历史汇率(工作日精确命中 + 周末回退)
 * → 金额换算(内部一致性)→ 错误路径(非法货币码 / 同币种 / 非法日期)。
 * 汇率天天变,所以断言只压"结构 + 区间 + 日期语义",不压具体数值。
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
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');

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
check('listTools 返回 3 个工具', tools.tools.length === 3, tools.tools.map((t) => t.name).join(','));

// ---- latest-rates ----------------------------------------------------------
const r1 = await call('latest-rates', { base: 'USD', symbols: ['CNY', 'EUR'] });
const latest = json(r1);
check('latest-rates 返回可解析 JSON 且非错误', latest !== null && r1.isError !== true, text(r1).slice(0, 120));
check('base 回显为 USD', latest?.base === 'USD', String(latest?.base));
check('date 是 YYYY-MM-DD', isDate(latest?.date), String(latest?.date));
check('USD→CNY 在 5..10 量纲区间', typeof latest?.rates?.CNY === 'number' && latest.rates.CNY > 5 && latest.rates.CNY < 10, String(latest?.rates?.CNY));
check('USD→EUR 在 0.5..1.5 量纲区间', typeof latest?.rates?.EUR === 'number' && latest.rates.EUR > 0.5 && latest.rates.EUR < 1.5, String(latest?.rates?.EUR));
check('只返回请求的两个币种', Object.keys(latest?.rates ?? {}).sort().join(',') === 'CNY,EUR', Object.keys(latest?.rates ?? {}).join(','));

const r2 = await call('latest-rates', { base: 'EUR' });
const all = json(r2);
check('省略 symbols 返回全部币种(>=10 种)', Object.keys(all?.rates ?? {}).length >= 10, String(Object.keys(all?.rates ?? {}).length));
check('全部汇率都是正数', Object.values(all?.rates ?? {}).every((v) => typeof v === 'number' && v > 0));

// ---- historical-rate -------------------------------------------------------
// 2026-08-14 是有数据的工作日,2026-08-16 是周末——历史数据不可变,断言稳定。
const r3 = await call('historical-rate', { date: '2026-08-14', base: 'USD', symbols: ['CNY'] });
const hist = json(r3);
check('工作日请求:effectiveDate 精确等于请求日期', hist?.effectiveDate === '2026-08-14' && hist?.requestedDate === '2026-08-14', `${hist?.requestedDate}→${hist?.effectiveDate}`);
check('历史 USD→CNY 在 5..10 量纲区间', typeof hist?.rates?.CNY === 'number' && hist.rates.CNY > 5 && hist.rates.CNY < 10, String(hist?.rates?.CNY));

const r4 = await call('historical-rate', { date: '2026-08-16', base: 'USD', symbols: ['CNY'] });
const wknd = json(r4);
check('周末请求:effectiveDate 回退到更早的工作日', isDate(wknd?.effectiveDate) && wknd.effectiveDate < '2026-08-16', `${wknd?.requestedDate}→${wknd?.effectiveDate}`);
check('回退时带 note 说明', typeof wknd?.note === 'string' && wknd.note.length > 0, String(wknd?.note).slice(0, 60));

// ---- convert-amount --------------------------------------------------------
const r5 = await call('convert-amount', { amount: 100, from: 'USD', to: 'CNY' });
const conv = json(r5);
check('换算结果在 100×(5..10) 区间', typeof conv?.result === 'number' && conv.result > 500 && conv.result < 1000, String(conv?.result));
check('rate 与 result/amount 内部自洽', typeof conv?.rate === 'number' && Math.abs(conv.rate - conv.result / 100) < 1e-5, `${conv?.rate} vs ${conv?.result / 100}`);
check('换算带 effectiveDate', isDate(conv?.effectiveDate), String(conv?.effectiveDate));
check('from/to 回显正确', conv?.from === 'USD' && conv?.to === 'CNY', `${conv?.from}→${conv?.to}`);

const r6 = await call('convert-amount', { amount: 50, from: 'eur', to: 'jpy', date: '2026-08-14' });
const conv2 = json(r6);
check('小写货币码被规范化', conv2?.from === 'EUR' && conv2?.to === 'JPY', `${conv2?.from}→${conv2?.to}`);
check('指定日期换算生效日等于该工作日', conv2?.effectiveDate === '2026-08-14', String(conv2?.effectiveDate));
check('EUR→JPY 在 100..250 量纲区间', typeof conv2?.rate === 'number' && conv2.rate > 100 && conv2.rate < 250, String(conv2?.rate));

// ---- 错误路径 --------------------------------------------------------------
const e1 = await call('latest-rates', { base: 'XXX', symbols: ['CNY'] });
check('不存在的货币码 XXX 被拒(isError)', e1.isError === true, text(e1).slice(0, 90));

const e2 = await call('latest-rates', { base: 'US', symbols: ['CNY'] });
check('格式非法的货币码 US 被拒(isError)', e2.isError === true && text(e2).includes('base'), text(e2).slice(0, 90));

const e3 = await call('convert-amount', { amount: 100, from: 'USD', to: 'USD' });
check('同币种换算被拒(isError)', e3.isError === true, text(e3).slice(0, 90));

const e4 = await call('historical-rate', { date: '2026-13-45', base: 'USD', symbols: ['CNY'] });
check('非法日期被拒(isError)', e4.isError === true && text(e4).includes('date'), text(e4).slice(0, 90));

const e5 = await call('convert-amount', { amount: -5, from: 'USD', to: 'CNY' });
check('负金额被拒(isError)', e5.isError === true && text(e5).includes('amount'), text(e5).slice(0, 90));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
