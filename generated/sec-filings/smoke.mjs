#!/usr/bin/env node
/**
 * 冒烟(真实网络):listTools → AAPL ticker→CIK → AAPL 申报清单(公司名/CIK/文件列表结构)→
 * 按 10-K 过滤 → 用纯数字 CIK 查同一家公司 → 未找到路径(不存在的 ticker,结构化说明而非报错)→
 * 错误路径:非法 ticker 形状 / limit 越界。
 * 申报清单每天都在变,所以只断言**结构与稳定标识**:公司名含 Apple、CIK=320193(主键不漂移)、
 * 文件条目含 form/filingDate/accessionNumber 且格式正确,不断言具体某份文件或条目数。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// 网络零件冒烟:必须把代理环境显式传给零件子进程。MCP SDK 的
// StdioClientTransport 默认只透传白名单 env(HOME/PATH/USER…),
// HTTPS_PROXY / NODE_USE_ENV_PROXY / SEC_EDGAR_UA 都不在其中——不传的话零件在代理网络下
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

// --- lookup-cik:AAPL ---
const r1 = await client.callTool({ name: 'lookup-cik', arguments: { ticker: 'AAPL' } });
const cik = json(r1);
check('lookup-cik AAPL 未报错', r1.isError !== true, text(r1).slice(0, 130));
check('AAPL found=true', cik && cik.found === true, `found=${cik && cik.found}`);
check('AAPL CIK 为 320193 / 0000320193', cik && cik.cik === 320193 && cik.cikPadded === '0000320193', `cik=${cik && cik.cik} padded=${cik && cik.cikPadded}`);
check('AAPL 公司名含 Apple', cik && /Apple/i.test(cik.companyName || ''), cik && cik.companyName);

// --- lookup-cik:小写输入也认 ---
const r2 = await client.callTool({ name: 'lookup-cik', arguments: { ticker: 'aapl' } });
const cik2 = json(r2);
check('小写 aapl 解析到同一个 CIK', cik2 && cik2.cik === 320193, `cik=${cik2 && cik2.cik}`);

// --- company-filings:AAPL 最近申报 ---
const r3 = await client.callTool({ name: 'company-filings', arguments: { query: 'AAPL', limit: 10 } });
const f = json(r3);
check('company-filings AAPL 未报错', r3.isError !== true, text(r3).slice(0, 130));
check('公司名含 Apple 且 CIK 为 320193', f && /Apple/i.test(f.companyName || '') && f.cik === 320193, `${f && f.companyName} / ${f && f.cik}`);
check('最近文件列表非空', f && Array.isArray(f.filings) && f.filings.length > 0, `count=${f && f.filings && f.filings.length}`);
check('limit=10 被遵守', f && f.filings.length <= 10, `count=${f && f.filings && f.filings.length}`);
check('每条文件含 form / filingDate / accessionNumber 字段',
  f && f.filings.every((x) => typeof x.form === 'string' && x.form.length > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(x.filingDate || '')
    && /^\d{10}-\d{2}-\d{6}$/.test(x.accessionNumber || '')),
  f && f.filings[0] && `${f.filings[0].form} ${f.filings[0].filingDate} ${f.filings[0].accessionNumber}`);
check('文件带可打开的 sec.gov 归档链接',
  f && f.filings.every((x) => x.documentUrl === null || /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/320193\//.test(x.documentUrl)),
  f && f.filings[0] && f.filings[0].documentUrl);
check('带 tickers / exchanges / sicDescription 等公司元信息',
  f && Array.isArray(f.tickers) && f.tickers.includes('AAPL') && Array.isArray(f.exchanges) && typeof f.sicDescription === 'string',
  f && `${JSON.stringify(f.tickers)} ${JSON.stringify(f.exchanges)} ${f.sicDescription}`);

// --- company-filings:按 10-K 过滤(列并行数组转对象数组后过滤是否正确)---
const r4 = await client.callTool({ name: 'company-filings', arguments: { query: 'AAPL', form: '10-K', limit: 5 } });
const k = json(r4);
check('10-K 过滤未报错', r4.isError !== true, text(r4).slice(0, 130));
check('10-K 过滤结果非空', k && Array.isArray(k.filings) && k.filings.length > 0, `count=${k && k.filings && k.filings.length}`);
check('过滤结果全部是 10-K', k && k.filings.length > 0 && k.filings.every((x) => x.form === '10-K'), k && k.filings && k.filings.map((x) => x.form).join(','));
check('10-K 数量少于全部申报数(过滤真的生效了)', k && k.matchedFilings < k.totalRecentFilings, `${k && k.matchedFilings}/${k && k.totalRecentFilings}`);

// --- company-filings:用纯数字 CIK 查同一家公司 ---
const r5 = await client.callTool({ name: 'company-filings', arguments: { query: '320193', limit: 3 } });
const byCik = json(r5);
check('用数字 CIK 320193 查到同一家公司', byCik && /Apple/i.test(byCik.companyName || '') && byCik.cik === 320193, byCik && byCik.companyName);

// --- 未找到路径:不存在的 ticker → 结构化说明,不是 isError ---
const n1 = await client.callTool({ name: 'lookup-cik', arguments: { ticker: 'ZZZZQQ' } });
const nf = json(n1);
check('不存在的 ticker 不算错误(isError 未置位)', n1.isError !== true, `isError=${n1.isError}`);
check('不存在的 ticker 返回 found=false 与说明', nf && nf.found === false && typeof nf.note === 'string' && nf.note.length > 0, nf && nf.note && nf.note.slice(0, 90));

const n2 = await client.callTool({ name: 'company-filings', arguments: { query: 'ZZZZQQ' } });
const nf2 = json(n2);
check('company-filings 对不存在的 ticker 也返回 found=false 而非报错', n2.isError !== true && nf2 && nf2.found === false, text(n2).slice(0, 110));

// --- 错误路径 1:非法 ticker 形状(本地拦截)---
const e1 = await client.callTool({ name: 'lookup-cik', arguments: { ticker: 'not a ticker!!' } });
check('非法 ticker 形状被拒(isError)', e1.isError === true, text(e1).slice(0, 110));

// --- 错误路径 2:空参数 ---
const e2 = await client.callTool({ name: 'company-filings', arguments: { query: '   ' } });
check('空 query 被拒(isError)', e2.isError === true, text(e2).slice(0, 110));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
