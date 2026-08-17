#!/usr/bin/env node
/**
 * MCP stdio server: 美国证监会 EDGAR 申报数据(U.S. SEC EDGAR https://data.sec.gov)。
 * 能力点:ticker ↔ CIK 互查、拉某公司最近的申报文件清单(可按 10-K/10-Q/8-K 等表单类型过滤,
 * 直接给出可打开的文档链接)——agent 回答"苹果最近一次年报是什么时候""给我特斯拉的 8-K",
 * 一轮内完成。
 *
 * 数据 Public-Domain-US-Gov — 条款 https://www.sec.gov/os/webmaster-faq#developers
 * 限速 10 req/s。本零件只读:只调 GET 查询端点,不做并发扇出(请求串行,并有最小间隔)。
 *
 * === User-Agent 说明(实测,别改回去)===
 * 工单默认 UA 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)' 会被 SEC
 * 直接 403,返回 "Your Request Originates from an Undeclared Automated Tool"。
 * 实测结论:SEC 的机器人识别拒绝带括号 URL 的 UA 形式,只接受它文档里那种
 * "产品名 + 联系邮箱" 的朴素格式(https://www.sec.gov/os/webmaster-faq#developers)。
 * 实测对照(同一 IP、同一端点 /submissions/CIK0000320193.json):
 *   'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)'                  -> 403
 *   'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler) <email>'          -> 403
 *   'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler, <email>)'         -> 403
 *   'dsh-assembler/0.1 <email>'                                                       -> 200
 * 因此这里用后者,并允许用环境变量 SEC_EDGAR_UA 覆盖成部署者自己的联系邮箱。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVICE = 'U.S. SEC EDGAR (sec.gov)';
const SUBMISSIONS_BASE = 'https://data.sec.gov/submissions';
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const ARCHIVES_BASE = 'https://www.sec.gov/Archives/edgar/data';
// SEC 强制要求可联系到人的 UA;部署时建议用 SEC_EDGAR_UA 换成自己的邮箱。
// SEC 强制要求可联系到人的 UA(A/B 实测见文件头:带括号 URL 的 UA 一律 403,
// 只有"产品名 + 邮箱"朴素格式能过)。部署者必须用 SEC_EDGAR_UA 填自己的邮箱;
// 默认值只留仓库地址,SEC 会拒——宁可明确失败并说清怎么配,也不借用他人身份。
const UA = process.env.SEC_EDGAR_UA || 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const TIMEOUT_MS = 15000;
const MIN_GAP_MS = 120; // 限速 10 req/s -> 串行请求之间至少隔 120ms

const server = new McpServer({ name: 'sec-filings', version: '0.0.1' });

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });

let lastRequestAt = 0;

/**
 * GET with a direct-connection fallback.
 *
 * Corporate/local proxies are not uniform per host: on this machine
 * www.sec.gov requires the proxy while data.sec.gov breaks under it ("Client
 * network socket disconnected before secure TLS connection was established").
 * A part that only honours the ambient proxy setting is at the mercy of that
 * split, so a transport-level failure retries once with the proxy explicitly
 * bypassed (undici reads NODE_USE_ENV_PROXY per-dispatcher, so a fresh Agent
 * without it connects directly). HTTP errors are NOT retried — a 403 is an
 * answer, not a broken path.
 */
async function fetchWithProxyFallback(url) {
  const init = {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  try {
    return await fetch(url, init);
  } catch (err) {
    const proxied = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (!proxied) throw err;
    const { Agent } = await import('undici');
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      dispatcher: new Agent(),
    });
  }
}

/** 串行节流:保证两次 SEC 请求之间至少间隔 MIN_GAP_MS。 */
async function throttle() {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

/**
 * 单次 GET + JSON 解析。任何失败都返回 { error }(字符串),绝不抛裸异常。
 */
async function getJson(url, what) {
  await throttle();
  let res;
  try {
    res = await fetchWithProxyFallback(url);
  } catch (err) {
    const name = err && err.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { error: `${SERVICE} 请求超时:${what} 在 ${TIMEOUT_MS / 1000}s 内没有响应(${url})。` };
    }
    return { error: `${SERVICE} 网络请求失败:${what}(${url})—— ${(err && err.message) || String(err)}` };
  }

  const body = await res.text().catch(() => '');

  if (res.status === 404) {
    return { notFound: true, error: `${SERVICE} 返回 HTTP 404:${what} 不存在(${url})。` };
  }
  if (res.status === 403) {
    return {
      error: `${SERVICE} 返回 HTTP 403:${what} 被拒。SEC 要求请求头带可联系到人的 User-Agent`
        + `(形如 "产品名 联系邮箱",见 https://www.sec.gov/os/webmaster-faq#developers),`
        + `当前用的是 "${UA}"。可设置环境变量 SEC_EDGAR_UA 换成自己的联系方式;若 UA 无误则多半是触发了 10 req/s 限速,稍后重试。`,
    };
  }
  if (res.status === 429) {
    return { error: `${SERVICE} 返回 HTTP 429:${what} 触发限速(SEC 限 10 req/s),请降低频率后重试。` };
  }
  if (!res.ok) {
    return { error: `${SERVICE} 返回 HTTP ${res.status}:${what} 查询失败。响应片段:${body.slice(0, 250) || '(无响应体)'}` };
  }

  try {
    return { data: JSON.parse(body) };
  } catch (err) {
    const looksHtml = /^\s*<(!DOCTYPE|html|\?xml)/i.test(body);
    return {
      error: `${SERVICE} 响应不是合法 JSON:${what}(HTTP ${res.status})`
        + `${looksHtml ? ',返回的是 HTML/XML 页面(多半被 SEC 的机器人拦截页替换)' : ''}`
        + ` —— ${(err && err.message) || String(err)};响应片段:${body.slice(0, 200)}`,
    };
  }
}

/** company_tickers.json 有 ~10400 条、约 800KB,进程内缓存一次,避免每次查询都重下。 */
let tickerMapCache = null;
async function loadTickerMap() {
  if (tickerMapCache) return { map: tickerMapCache };
  const { data, error } = await getJson(TICKERS_URL, 'ticker→CIK 映射表 company_tickers.json');
  if (error) return { error };
  // 形状:{"0":{cik_str:1045810,ticker:"NVDA",title:"NVIDIA CORP"}, "1":{...}, ...}
  if (!data || typeof data !== 'object') {
    return { error: `${SERVICE} 返回了预期之外的结构:company_tickers.json 应为对象,实际是 ${typeof data}。` };
  }
  const map = new Map();
  for (const row of Object.values(data)) {
    if (row && row.ticker) map.set(String(row.ticker).toUpperCase(), { cik: Number(row.cik_str), ticker: String(row.ticker).toUpperCase(), name: row.title });
  }
  if (map.size === 0) {
    return { error: `${SERVICE} 的 company_tickers.json 解析后为空(结构可能已变更)。` };
  }
  tickerMapCache = map;
  return { map };
}

const padCik = (n) => String(n).padStart(10, '0');
const TICKER_RE = /^[A-Za-z][A-Za-z0-9.-]{0,9}$/;

/** 把 "AAPL" / "320193" / "0000320193" / "CIK0000320193" 统一解析成 { cik, ticker?, name? }。 */
async function resolveCompany(query) {
  const raw = String(query).trim();
  if (!raw) return { error: '参数为空:请给出 ticker(如 AAPL)或 CIK(如 320193)。' };

  const cikLike = raw.replace(/^CIK/i, '');
  if (/^\d{1,10}$/.test(cikLike)) {
    return { cik: Number(cikLike) };
  }
  if (!TICKER_RE.test(raw)) {
    return { error: `参数非法:"${raw}" 既不是合法 ticker(1-10 位字母数字,如 AAPL、BRK.B),也不是数字 CIK(如 320193 / 0000320193)。` };
  }

  const { map, error } = await loadTickerMap();
  if (error) return { error };
  const hit = map.get(raw.toUpperCase());
  if (!hit) {
    return { notFound: true, message: `在 ${SERVICE} 的 ticker→CIK 映射表(共 ${map.size} 条)里找不到 ticker "${raw.toUpperCase()}"。该表只含在美国有活跃申报的上市公司;请核对拼写,或直接用 CIK 查询。` };
  }
  return hit;
}

/** filings.recent 是"列并行数组",这里转成对象数组。 */
function recentToRows(recent) {
  if (!recent || typeof recent !== 'object') return [];
  const keys = Object.keys(recent).filter((k) => Array.isArray(recent[k]));
  if (keys.length === 0) return [];
  const n = Math.min(...keys.map((k) => recent[k].length));
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const row = {};
    for (const k of keys) row[k] = recent[k][i];
    rows.push(row);
  }
  return rows;
}

server.registerTool('lookup-cik', {
  description:
    '把股票代码(ticker)查成 SEC 的 CIK 编号与公司法定名称,例如 AAPL → CIK 320193 / Apple Inc.。'
    + 'CIK 是 EDGAR 里公司的唯一主键,拿到后可用于 company-filings 或任何 EDGAR 链接。'
    + '只覆盖在美国有活跃申报的上市公司;查不到时返回结构化的"未找到"说明(不算错误)。',
  inputSchema: {
    ticker: z.string().describe('股票代码,如 AAPL / MSFT / BRK.B(大小写不敏感)'),
  },
}, async ({ ticker }) => {
  const raw = String(ticker || '').trim();
  if (!raw) return fail('参数 ticker 为空:请给出股票代码,如 AAPL。');
  if (!TICKER_RE.test(raw)) {
    return fail(`参数 ticker 非法:"${raw}"。ticker 应为 1-10 位字母/数字,可含 . 或 -(如 AAPL、BRK.B)。若想用 CIK 查询请直接调 company-filings。`);
  }

  const { map, error } = await loadTickerMap();
  if (error) return fail(error);

  const hit = map.get(raw.toUpperCase());
  if (!hit) {
    return ok(JSON.stringify({
      ticker: raw.toUpperCase(),
      found: false,
      note: `在 ${SERVICE} 的 ticker→CIK 映射表(共 ${map.size} 条)里没有 "${raw.toUpperCase()}"。`
        + '该表只含在美国有活跃申报的上市公司(不含已退市、纯外国上市或未在 SEC 注册的公司)。请核对拼写。',
    }, null, 2));
  }
  return ok(JSON.stringify({
    ticker: hit.ticker,
    found: true,
    cik: hit.cik,
    cikPadded: padCik(hit.cik),
    companyName: hit.name,
    submissionsUrl: `${SUBMISSIONS_BASE}/CIK${padCik(hit.cik)}.json`,
    source: SERVICE,
  }, null, 2));
});

server.registerTool('company-filings', {
  description:
    '按 ticker 或 CIK 拉某公司在 EDGAR 上最近的申报文件清单:返回公司名、CIK、交易所/代码、行业(SIC),'
    + '以及一份文件列表(表单类型 form、申报日 filingDate、报告期 reportDate、受理号 accessionNumber、'
    + '可直接打开的主文档链接 documentUrl 与索引页 filingIndexUrl)。'
    + '可用 form 参数过滤表单类型,如 10-K(年报)、10-Q(季报)、8-K(重大事项)、4(内部人交易)、DEF 14A(股东会材料)。'
    + '公司不存在时返回结构化的"未找到"说明(不算错误);参数非法则报错。'
    + '注意:只覆盖 EDGAR 最近约 1000 份申报(更早的历史归档不在本工具范围)。',
  inputSchema: {
    query: z.string().describe('股票代码或 CIK,如 AAPL、MSFT、320193、0000320193'),
    form: z.string().optional().describe('可选:按表单类型过滤,如 10-K / 10-Q / 8-K / 4 / DEF 14A(大小写不敏感,精确匹配表单名)'),
    limit: z.number().int().min(1).max(100).optional().describe('可选:返回多少份文件,1-100,默认 20'),
  },
}, async ({ query, form, limit }) => {
  const raw = String(query || '').trim();
  if (!raw) return fail('参数 query 为空:请给出 ticker(如 AAPL)或 CIK(如 320193)。');
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    return fail(`参数 limit 非法:${limit}。需要 1-100 之间的整数。`);
  }
  const take = limit ?? 20;

  const resolved = await resolveCompany(raw);
  if (resolved.error) return fail(resolved.error);
  if (resolved.notFound) {
    return ok(JSON.stringify({ query: raw, found: false, note: resolved.message }, null, 2));
  }

  const cikPadded = padCik(resolved.cik);
  const { data, error, notFound } = await getJson(`${SUBMISSIONS_BASE}/CIK${cikPadded}.json`, `CIK ${cikPadded} 的申报索引`);
  if (notFound) {
    return ok(JSON.stringify({
      query: raw,
      cik: resolved.cik,
      found: false,
      note: `${SERVICE} 里没有 CIK ${cikPadded} 的申报索引(该 CIK 不存在,或该主体从未提交过申报)。`,
    }, null, 2));
  }
  if (error) return fail(error);
  if (!data || typeof data !== 'object' || !data.filings) {
    return fail(`${SERVICE} 返回了预期之外的结构:CIK ${cikPadded} 的申报索引缺少 filings 字段。`);
  }

  const allRows = recentToRows(data.filings.recent);
  const wanted = form ? String(form).trim().toUpperCase() : null;
  const matched = wanted ? allRows.filter((r) => String(r.form || '').toUpperCase() === wanted) : allRows;

  const cikInt = Number(data.cik ?? resolved.cik);
  const filings = matched.slice(0, take).map((r) => {
    const accNoDash = String(r.accessionNumber || '').replace(/-/g, '');
    const base = `${ARCHIVES_BASE}/${cikInt}/${accNoDash}`;
    return {
      form: r.form,
      filingDate: r.filingDate,
      reportDate: r.reportDate || null,
      accessionNumber: r.accessionNumber,
      description: r.primaryDocDescription || null,
      items: r.items || undefined,
      sizeBytes: r.size,
      documentUrl: r.primaryDocument ? `${base}/${r.primaryDocument}` : null,
      filingIndexUrl: r.accessionNumber ? `${base}/${r.accessionNumber}-index.htm` : null,
    };
  });

  if (wanted && filings.length === 0) {
    const seen = [...new Set(allRows.map((r) => r.form).filter(Boolean))];
    return ok(JSON.stringify({
      companyName: data.name,
      cik: cikInt,
      found: true,
      form: wanted,
      filingsReturned: 0,
      note: `${data.name} 最近 ${allRows.length} 份申报里没有表单类型 "${wanted}"。`
        + `这批申报里出现过的表单类型有:${seen.slice(0, 25).join('、')}${seen.length > 25 ? ' …' : ''}。`,
      filings: [],
    }, null, 2));
  }

  const result = {
    companyName: data.name,
    cik: cikInt,
    cikPadded,
    found: true,
    entityType: data.entityType,
    tickers: data.tickers,
    exchanges: data.exchanges,
    sic: data.sic,
    sicDescription: data.sicDescription,
    formFilter: wanted,
    totalRecentFilings: allRows.length,
    matchedFilings: matched.length,
    filingsReturned: filings.length,
    filings,
    source: `${SERVICE},数据为美国政府公共领域作品`,
  };
  const head = `${data.name}(CIK ${cikInt}${data.tickers && data.tickers.length ? `,${data.tickers.join('/')}` : ''})`
    + ` — 返回 ${filings.length}/${matched.length} 份${wanted ? ` ${wanted}` : ''}申报`;
  return ok(`${head}\n${JSON.stringify(result, null, 2)}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
