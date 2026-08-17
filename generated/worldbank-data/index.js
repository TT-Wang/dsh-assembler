#!/usr/bin/env node
/**
 * MCP stdio server: 世界银行公开数据(World Bank Open Data https://api.worldbank.org/v2)。
 * 能力点:按"国家 + 指标"拉时间序列(GDP/人口/通胀/失业率…),外加一份常用指标码速查表——
 * agent 回答"中国近十年 GDP 怎么走""印度人口多少",一轮内完成。
 *
 * 数据许可 CC-BY-4.0 — https://datacatalog.worldbank.org/public-licenses — 无公开硬限制。
 * 本零件只读:只调 GET 查询端点,不做并发扇出(每个工具最多一次请求)。
 *
 * 两个实测坑(决定了下面的实现):
 *  1) 服务端 date=YYYY:YYYY 过滤器响应极慢(实测 >18s,常打穿 15s 超时),
 *     所以年份区间改为"一次取回整条序列(per_page=500,约 66 个点)后本地过滤"。
 *  2) 非法国家码/指标码不返回 4xx,而是 HTTP 200 + [{"message":[{"id":"120",...}]}],
 *     必须识别这个形状才能正确报错。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVICE = 'World Bank Open Data (api.worldbank.org)';
const BASE = 'https://api.worldbank.org/v2';
const UA = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const TIMEOUT_MS = 15000;
const PER_PAGE = 500; // 一次取回整条序列:最长的指标也只有 ~66 个年度点

const server = new McpServer({ name: 'worldbank-data', version: '0.0.1' });

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });

/** 常用指标码速查表(静态数据,不发请求)。 */
const COMMON_INDICATORS = [
  { code: 'NY.GDP.MKTP.CD', zh: 'GDP(现价美元)', en: 'GDP (current US$)', unit: '美元' },
  { code: 'NY.GDP.MKTP.KD.ZG', zh: 'GDP 年增长率', en: 'GDP growth (annual %)', unit: '%' },
  { code: 'NY.GDP.PCAP.CD', zh: '人均 GDP(现价美元)', en: 'GDP per capita (current US$)', unit: '美元' },
  { code: 'SP.POP.TOTL', zh: '总人口', en: 'Population, total', unit: '人' },
  { code: 'SP.POP.GROW', zh: '人口年增长率', en: 'Population growth (annual %)', unit: '%' },
  { code: 'SP.DYN.LE00.IN', zh: '预期寿命(出生时)', en: 'Life expectancy at birth, total (years)', unit: '岁' },
  { code: 'FP.CPI.TOTL.ZG', zh: '通货膨胀率(消费者价格)', en: 'Inflation, consumer prices (annual %)', unit: '%' },
  { code: 'SL.UEM.TOTL.ZS', zh: '失业率(占劳动力比重,ILO 估计)', en: 'Unemployment, total (% of total labor force)', unit: '%' },
  { code: 'NE.EXP.GNFS.ZS', zh: '货物与服务出口(占 GDP 比重)', en: 'Exports of goods and services (% of GDP)', unit: '%' },
  { code: 'NE.IMP.GNFS.ZS', zh: '货物与服务进口(占 GDP 比重)', en: 'Imports of goods and services (% of GDP)', unit: '%' },
  { code: 'BX.KLT.DINV.CD.WD', zh: '外国直接投资净流入', en: 'Foreign direct investment, net inflows (BoP, current US$)', unit: '美元' },
  { code: 'GC.DOD.TOTL.GD.ZS', zh: '中央政府债务(占 GDP 比重)', en: 'Central government debt, total (% of GDP)', unit: '%' },
  { code: 'EN.GHG.CO2.MT.CE.AR5', zh: '二氧化碳排放量', en: 'Carbon dioxide (CO2) emissions (Mt CO2e)', unit: '百万吨' },
  { code: 'EG.USE.PCAP.KG.OE', zh: '人均能源使用量', en: 'Energy use (kg of oil equivalent per capita)', unit: '千克油当量' },
  { code: 'IT.NET.USER.ZS', zh: '互联网使用人口比例', en: 'Individuals using the Internet (% of population)', unit: '%' },
  { code: 'SE.XPD.TOTL.GD.ZS', zh: '教育经费支出(占 GDP 比重)', en: 'Government expenditure on education, total (% of GDP)', unit: '%' },
  { code: 'SH.XPD.CHEX.GD.ZS', zh: '医疗卫生支出(占 GDP 比重)', en: 'Current health expenditure (% of GDP)', unit: '%' },
  { code: 'AG.LND.FRST.ZS', zh: '森林覆盖率', en: 'Forest area (% of land area)', unit: '%' },
];

/**
 * 单次 GET + JSON 解析。任何失败都返回 { error }(字符串),绝不抛裸异常。
 */
async function getJson(url, what) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err && err.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { error: `${SERVICE} 请求超时:${what} 在 ${TIMEOUT_MS / 1000}s 内没有响应(${url})。该服务对冷门国家/指标组合响应很慢,稍后重试或换个组合。` };
    }
    return { error: `${SERVICE} 网络请求失败:${what}(${url})—— ${(err && err.message) || String(err)}` };
  }

  const body = await res.text().catch(() => '');
  if (!res.ok) {
    return { error: `${SERVICE} 返回 HTTP ${res.status}:${what} 查询失败。响应片段:${body.slice(0, 300) || '(无响应体)'}` };
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    // WAF 拦截时会返回 HTML 而不是 JSON,这里如实说明
    const looksHtml = /^\s*<(!DOCTYPE|html|\?xml)/i.test(body);
    return {
      error: `${SERVICE} 响应不是合法 JSON:${what}(HTTP ${res.status})`
        + `${looksHtml ? ',返回的是 HTML 页面(多半被上游 WAF/错误页拦截)' : ''}`
        + ` —— ${(err && err.message) || String(err)};响应片段:${body.slice(0, 200)}`,
    };
  }

  // 坑 2:非法参数走 HTTP 200 + [{"message":[...]}]
  const msgs = Array.isArray(data) && data[0] && Array.isArray(data[0].message) ? data[0].message : null;
  if (msgs) {
    const detail = msgs.map((m) => `${m.key || ''}${m.value ? `: ${m.value}` : ''}`.trim()).filter(Boolean).join('; ');
    return { error: `${SERVICE} 拒绝了这次查询(${what}):${detail || JSON.stringify(msgs).slice(0, 200)}。请核对国家码是否为 ISO3(如 CHN 而非 CN)、指标码是否存在(可用 common-indicators 查常用码)。` };
  }

  if (!Array.isArray(data) || data.length < 2) {
    return { error: `${SERVICE} 返回了预期之外的结构:${what} 应为 [元信息, 数据数组] 两元数组,实际是 ${JSON.stringify(data).slice(0, 200)}。` };
  }
  return { meta: data[0] || {}, rows: Array.isArray(data[1]) ? data[1] : null };
}

server.registerTool('country-indicator', {
  description:
    '拉取某个国家(或地区/聚合体)某个指标的年度时间序列,如中国 GDP、印度人口、美国通胀率。'
    + '返回指标名、国家名、单位提示、数据点数组([{year, value}],按年份倒序)与最新一个有值年份。'
    + '国家码必须是 ISO 3166-1 alpha-3 三位码(中国是 CHN 不是 CN),也支持世行聚合体(如 WLD 全球、EUU 欧盟)。'
    + '指标码不确定时先调 common-indicators。'
    + '该国该指标没有数据时返回结构化说明(不算错误);国家码/指标码非法则报错。',
  inputSchema: {
    countryIso3: z.string().describe('ISO 3166-1 alpha-3 三位国家码,如 CHN / USA / IND;也接受世行聚合体码如 WLD / EUU'),
    indicator: z.string().describe('世行指标码,如 NY.GDP.MKTP.CD(GDP)、SP.POP.TOTL(人口)。见 common-indicators'),
    yearFrom: z.number().int().optional().describe('可选:起始年份(含),如 2015。留空表示不限'),
    yearTo: z.number().int().optional().describe('可选:结束年份(含),如 2024。留空表示不限'),
    includeEmpty: z.boolean().optional().describe('可选:是否保留 value 为 null 的年份(默认 false,只返回有值的点)'),
  },
}, async ({ countryIso3, indicator, yearFrom, yearTo, includeEmpty }) => {
  if (!/^[A-Za-z]{3}$/.test(countryIso3)) {
    return fail(`参数 countryIso3 非法:"${countryIso3}"。需要三位字母的 ISO3 码(中国是 CHN,不是 CN;美国是 USA)。`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,49}$/.test(indicator)) {
    return fail(`参数 indicator 非法:"${indicator}"。世行指标码形如 NY.GDP.MKTP.CD,只含字母数字与 . _ -。可先调 common-indicators 查常用码。`);
  }
  if (yearFrom !== undefined && (!Number.isInteger(yearFrom) || yearFrom < 1900 || yearFrom > 2200)) {
    return fail(`参数 yearFrom 非法:${yearFrom}。需要 1900-2200 之间的整数年份。`);
  }
  if (yearTo !== undefined && (!Number.isInteger(yearTo) || yearTo < 1900 || yearTo > 2200)) {
    return fail(`参数 yearTo 非法:${yearTo}。需要 1900-2200 之间的整数年份。`);
  }
  if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
    return fail(`年份区间非法:yearFrom(${yearFrom})不能大于 yearTo(${yearTo})。`);
  }

  const iso3 = countryIso3.toUpperCase();
  const code = indicator.toUpperCase();
  const what = `${iso3} 的 ${code} 时间序列`;
  // 注意:刻意不使用服务端 date= 过滤(实测极慢),改为整条取回后本地过滤
  const url = `${BASE}/country/${encodeURIComponent(iso3)}/indicator/${encodeURIComponent(code)}?format=json&per_page=${PER_PAGE}`;

  const { rows, meta, error } = await getJson(url, what);
  if (error) return fail(error);

  // 空结果:服务端可能给 [meta, null] 或 total=0 —— 这是"没数据",不是错误
  if (!rows || rows.length === 0) {
    return ok(JSON.stringify({
      countryIso3: iso3,
      indicator: code,
      found: false,
      note: `${SERVICE} 对 ${iso3} 的指标 ${code} 没有返回任何观测值。指标码与国家码本身是被接受的,但该组合在世行库里无数据(常见于小国、停更指标或该国未上报)。`,
      dataPoints: [],
      lastUpdated: meta && meta.lastupdated,
    }, null, 2));
  }

  const first = rows.find((r) => r && r.indicator) || {};
  const indicatorName = (first.indicator && first.indicator.value) || code;
  const countryName = (first.country && first.country.value) || iso3;

  let points = rows
    .filter((r) => r && r.date !== undefined)
    .map((r) => ({ year: Number(r.date), value: r.value === undefined ? null : r.value }))
    .filter((p) => Number.isFinite(p.year));

  if (yearFrom !== undefined) points = points.filter((p) => p.year >= yearFrom);
  if (yearTo !== undefined) points = points.filter((p) => p.year <= yearTo);
  if (!includeEmpty) points = points.filter((p) => p.value !== null);
  points.sort((a, b) => b.year - a.year);

  if (points.length === 0) {
    const rangeDesc = [yearFrom, yearTo].some((v) => v !== undefined)
      ? `年份区间 ${yearFrom ?? '不限'}–${yearTo ?? '不限'} 内`
      : '';
    const withValue = rows.filter((r) => r && r.value !== null).map((r) => Number(r.date)).filter(Number.isFinite);
    return ok(JSON.stringify({
      countryIso3: iso3,
      indicator: code,
      indicatorName,
      countryName,
      found: false,
      note: `${countryName} 的「${indicatorName}」在${rangeDesc || '世行库中'}没有有效观测值。`
        + (withValue.length ? `该指标有数据的年份范围是 ${Math.min(...withValue)}–${Math.max(...withValue)},可调整 yearFrom/yearTo 后重试。` : ''),
      dataPoints: [],
      lastUpdated: meta && meta.lastupdated,
    }, null, 2));
  }

  const unitHint = (COMMON_INDICATORS.find((i) => i.code === code) || {}).unit;
  const latest = points.find((p) => p.value !== null) || points[0];
  const result = {
    countryIso3: iso3,
    countryName,
    indicator: code,
    indicatorName,
    unit: unitHint || (indicatorName.match(/\(([^)]+)\)\s*$/) || [, '见指标名'])[1],
    found: true,
    count: points.length,
    yearRange: { from: points[points.length - 1].year, to: points[0].year },
    latest,
    dataPoints: points,
    source: `${SERVICE},数据许可 CC-BY-4.0,最后更新 ${(meta && meta.lastupdated) || '未知'}`,
  };
  return ok(`${countryName} · ${indicatorName}:${points.length} 个数据点(${result.yearRange.from}–${result.yearRange.to}),最新 ${latest.year} = ${latest.value}\n${JSON.stringify(result, null, 2)}`);
});

server.registerTool('common-indicators', {
  description:
    '列出世界银行常用指标码及中英文说明与单位(GDP、人均 GDP、人口、通胀、失业率、预期寿命、'
    + '进出口占比、外资流入、碳排放、互联网普及率等)。纯静态速查表,不发起网络请求,'
    + '用于在调用 country-indicator 前把"人话需求"翻成正确的指标码。',
  inputSchema: {
    keyword: z.string().optional().describe('可选:按关键词过滤(匹配指标码/中文名/英文名,大小写不敏感),如 "GDP" 或 "人口"'),
  },
}, async ({ keyword }) => {
  let list = COMMON_INDICATORS;
  if (keyword && keyword.trim()) {
    const k = keyword.trim().toLowerCase();
    list = list.filter((i) => i.code.toLowerCase().includes(k) || i.zh.toLowerCase().includes(k) || i.en.toLowerCase().includes(k));
    if (list.length === 0) {
      return ok(JSON.stringify({
        keyword,
        count: 0,
        note: `常用指标表里没有匹配 "${keyword}" 的条目。该表只覆盖高频指标;世行完整指标库有两万余个指标码,`
          + `可直接把已知指标码传给 country-indicator。`,
        indicators: [],
      }, null, 2));
    }
  }
  return ok(`世行常用指标 ${list.length} 个(静态表,未联网)\n${JSON.stringify(list, null, 2)}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
