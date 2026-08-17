#!/usr/bin/env node
/**
 * MCP stdio server: Frankfurter 汇率服务(https://api.frankfurter.dev/v1)适配。
 * 能力点:取最新汇率、取历史某日汇率、按汇率换算金额——agent 一轮内拿到
 * 带"实际生效日期"的可引用汇率,不必自己拼接口、也不必自己处理工作日回退。
 *
 * 数据源是欧洲央行(ECB)参考汇率:**只有工作日数据**,且每个工作日约 16:00 CET 更新。
 * 请求周末/节假日会由服务端回退到最近的工作日,本零件把"请求日期"和"实际生效日期"
 * 都返回出来,避免 agent 误以为拿到的是当天数据。
 *
 * 提供方 Frankfurter,数据许可 Public-Domain-ECB,无硬速率限制(建议 <10 req/s)。
 * 只读:本零件只调查询端点,不做写操作,也不做并发扇出。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVICE = 'Frankfurter(api.frankfurter.dev)';
const BASE_URL = 'https://api.frankfurter.dev/v1';
const USER_AGENT = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const TIMEOUT_MS = 15000;
const SOURCE = 'Frankfurter / ECB reference rates, Public-Domain';

const server = new McpServer({ name: 'currency-rates', version: '0.0.1' });

const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });

/**
 * 单次只读 GET:超时、非 2xx、JSON 解析失败一律转成 { error: 说明文本 },
 * 绝不向上抛裸异常。Frankfurter 的错误体形如 {"message":"not found"}。
 */
async function getJson(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const name = e?.name ?? '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { error: `${SERVICE} 请求超时:${TIMEOUT_MS}ms 内未返回` };
    }
    return { error: `${SERVICE} 网络请求失败:${e?.message ?? String(e)}` };
  }

  let body;
  try {
    body = await res.text();
  } catch (e) {
    return { error: `${SERVICE} 读取响应体失败:${e?.message ?? String(e)}` };
  }

  if (!res.ok) {
    let detail = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body);
      detail = parsed?.message ?? parsed?.reason ?? detail;
    } catch { /* 非 JSON 错误体,用原始文本前 300 字 */ }
    const hint = res.status === 404
      ? '(常见原因:货币代码不被 ECB 收录,或日期早于 1999-01-04 / 不是合法日期)'
      : res.status === 422 ? '(常见原因:base 与 symbols 是同一种货币)' : '';
    return { error: `${SERVICE} 返回 HTTP ${res.status}:${detail}${hint}` };
  }

  try {
    return { data: JSON.parse(body) };
  } catch {
    return { error: `${SERVICE} 响应不是合法 JSON(HTTP ${res.status}),前 200 字符:${body.slice(0, 200)}` };
  }
}

// zod 只把关类型(字符串/数字/数组),取值合法性放在 handler 里查,
// 这样非法参数返回的是本零件统一的 { isError: true },而不是 SDK 抛的 JSON-RPC 错误。
const CODE_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 规范化并校验单个货币代码,返回 { code } 或 { error }。 */
function normCode(raw, field) {
  const code = String(raw ?? '').trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    return { error: `参数错误:${field} 必须是 3 位字母的 ISO 4217 货币代码(如 USD/CNY/EUR),收到 "${raw}"` };
  }
  return { code };
}

/** 规范化并校验 symbols 列表,返回 { codes } 或 { error }。 */
function normSymbols(list, base) {
  if (list === undefined) return { codes: [] };
  if (!Array.isArray(list) || list.length === 0) {
    return { error: '参数错误:symbols 必须是非空的货币代码数组,如 ["CNY","EUR"];要取全部币种就整个省略该参数' };
  }
  const codes = [];
  for (const raw of list) {
    const r = normCode(raw, 'symbols 中的元素');
    if (r.error) return r;
    if (r.code === base) {
      return { error: `参数错误:symbols 不能包含 base 本身(${base})——ECB 不提供同币种报价,该汇率恒为 1` };
    }
    if (!codes.includes(r.code)) codes.push(r.code);
  }
  return { codes };
}

/** 校验日期,返回 { date } 或 { error }。 */
function normDate(raw, field) {
  const date = String(raw ?? '').trim();
  if (!DATE_RE.test(date)) {
    return { error: `参数错误:${field} 必须是 YYYY-MM-DD 格式的日期,收到 "${raw}"` };
  }
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
    return { error: `参数错误:${field} "${date}" 不是一个真实存在的日期` };
  }
  return { date };
}

/** 拼查询串:path 为 'latest' 或 'YYYY-MM-DD'。 */
function buildUrl(path, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
  return `${BASE_URL}/${path}?${qs.toString()}`;
}

/** ECB 只有工作日数据:请求日与生效日不一致时,给 agent 一句明确说明。 */
const dateNote = (requested, effective) =>
  requested === effective
    ? undefined
    : `ECB 只发布工作日汇率;${requested} 无数据(周末/节假日/尚未发布),已回退到最近的工作日 ${effective}`;

server.registerTool('latest-rates', {
  description:
    '取最新一期 ECB 参考汇率(Frankfurter)。输入基准货币与可选的目标货币列表,'
    + '返回 { base, date, rates },其中 rates[X] 表示 1 单位 base 兑换多少 X,date 是该期汇率的'
    + '实际生效日(ECB 只发布工作日,周末拿到的是上一个工作日的数据)。省略 symbols 则返回全部约 30 种币种。'
    + '货币代码非法或不被 ECB 收录时返回错误。',
  inputSchema: {
    base: z.string().describe('基准货币的 3 位 ISO 4217 代码,如 "USD"(ECB 体系里最常用的基准是 "EUR")'),
    symbols: z.array(z.string()).optional().describe('目标货币代码数组,如 ["CNY","EUR"];省略则返回全部币种'),
  },
}, async ({ base, symbols }) => {
  const b = normCode(base, 'base');
  if (b.error) return fail(b.error);
  const s = normSymbols(symbols, b.code);
  if (s.error) return fail(s.error);

  const { data, error } = await getJson(buildUrl('latest', { base: b.code, symbols: s.codes.join(',') }));
  if (error) return fail(error);
  if (!data?.rates || typeof data.rates !== 'object' || !data?.date) {
    return fail(`${SERVICE} 响应结构异常:缺少 rates 或 date 字段`);
  }

  return ok({ base: data.base, date: data.date, rates: data.rates, source: SOURCE });
});

server.registerTool('historical-rate', {
  description:
    '取指定日期的 ECB 参考汇率(Frankfurter)。返回 { base, requestedDate, effectiveDate, rates }。'
    + '因为 ECB 只发布工作日汇率,请求周末或节假日会自动回退到最近的工作日:'
    + 'effectiveDate 才是这组汇率真正对应的日期,两者不同时 note 字段会写明。'
    + 'ECB 数据自 1999-01-04 起;日期格式非法、超出范围或货币代码非法时返回错误。',
  inputSchema: {
    date: z.string().describe('查询日期,YYYY-MM-DD,如 "2026-08-14"(需不早于 1999-01-04)'),
    base: z.string().describe('基准货币的 3 位 ISO 4217 代码,如 "USD"'),
    symbols: z.array(z.string()).optional().describe('目标货币代码数组,如 ["CNY"];省略则返回全部币种'),
  },
}, async ({ date, base, symbols }) => {
  const d = normDate(date, 'date');
  if (d.error) return fail(d.error);
  const b = normCode(base, 'base');
  if (b.error) return fail(b.error);
  const s = normSymbols(symbols, b.code);
  if (s.error) return fail(s.error);

  const { data, error } = await getJson(buildUrl(d.date, { base: b.code, symbols: s.codes.join(',') }));
  if (error) return fail(error);
  if (!data?.rates || typeof data.rates !== 'object' || !data?.date) {
    return fail(`${SERVICE} 响应结构异常:缺少 rates 或 date 字段`);
  }

  return ok({
    base: data.base,
    requestedDate: d.date,
    effectiveDate: data.date,
    rates: data.rates,
    note: dateNote(d.date, data.date),
    source: SOURCE,
  });
});

server.registerTool('convert-amount', {
  description:
    '按 ECB 参考汇率把一笔金额从一种货币换算成另一种(Frankfurter)。输入金额与 from/to 货币代码,'
    + '可选指定日期(省略则用最新一期)。返回 { amount, from, to, rate, result, effectiveDate },'
    + 'rate 是 1 单位 from 兑换多少 to,result 是换算结果。effectiveDate 是这笔换算实际采用的汇率日期——'
    + 'ECB 只有工作日数据,周末/节假日会回退到最近的工作日,note 字段会写明。'
    + 'from 与 to 相同、金额为负、货币代码非法时返回错误。',
  inputSchema: {
    amount: z.number().describe('要换算的金额,必须大于 0,如 100'),
    from: z.string().describe('源货币的 3 位 ISO 4217 代码,如 "USD"'),
    to: z.string().describe('目标货币的 3 位 ISO 4217 代码,如 "CNY"'),
    date: z.string().optional().describe('可选:按该日期(YYYY-MM-DD)的汇率换算,省略则用最新一期'),
  },
}, async ({ amount, from, to, date }) => {
  if (!Number.isFinite(amount) || amount <= 0) {
    return fail(`参数错误:amount 必须是大于 0 的有限数字,收到 ${amount}`);
  }
  const f = normCode(from, 'from');
  if (f.error) return fail(f.error);
  const t = normCode(to, 'to');
  if (t.error) return fail(t.error);
  if (f.code === t.code) {
    return fail(`参数错误:from 与 to 同为 ${f.code}——ECB 不提供同币种报价,同币种换算汇率恒为 1,结果就等于原金额`);
  }

  let path = 'latest';
  if (date !== undefined) {
    const d = normDate(date, 'date');
    if (d.error) return fail(d.error);
    path = d.date;
  }

  const { data, error } = await getJson(buildUrl(path, { base: f.code, symbols: t.code, amount }));
  if (error) return fail(error);

  const result = data?.rates?.[t.code];
  if (typeof result !== 'number' || !data?.date) {
    return fail(`${SERVICE} 响应结构异常:返回体里没有 ${t.code} 的汇率或缺少 date 字段`);
  }

  return ok({
    amount,
    from: f.code,
    to: t.code,
    rate: Number((result / amount).toFixed(6)),
    result,
    requestedDate: path === 'latest' ? undefined : path,
    effectiveDate: data.date,
    note: path === 'latest' ? undefined : dateNote(path, data.date),
    source: SOURCE,
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
