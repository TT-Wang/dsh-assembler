#!/usr/bin/env node
/**
 * MCP stdio server: 公共节假日查询(Nager.Date https://date.nager.at/api/v3)。
 * 能力点:某国某年的法定节假日清单、任意日期是否工作日(周末+节假日合并判断)、
 * 支持的国家清单——agent 排期、算工期、判断"那天上不上班",一轮内完成。
 *
 * 服务条款 https://date.nager.at/Home/Terms — 数据 MIT — 免费,建议 <10 req/s。
 * 本零件只读:只调 GET 查询端点,不做并发扇出(每个工具最多一次请求)。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVICE = 'Nager.Date (date.nager.at)';
const BASE = 'https://date.nager.at/api/v3';
const UA = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const TIMEOUT_MS = 15000;

const server = new McpServer({ name: 'public-holidays', version: '0.0.1' });

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });

/**
 * 单次 GET + JSON 解析。任何失败都返回 { error }(字符串),绝不抛裸异常。
 * 错误文案一律点名"哪个服务、什么问题",便于 agent 判断是重试还是换参数。
 */
async function getJson(path, what) {
  const url = `${BASE}${path}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err && err.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { error: `${SERVICE} 请求超时:${what} 在 ${TIMEOUT_MS / 1000}s 内没有响应(${url})。稍后重试或换个年份/国家。` };
    }
    return { error: `${SERVICE} 网络请求失败:${what}(${url})—— ${(err && err.message) || String(err)}` };
  }

  const body = await res.text().catch(() => '');
  if (!res.ok) {
    // Nager 对未知国家码返回 404 + {"title":"Unknown country code",...}
    let detail = body.slice(0, 300);
    try {
      const j = JSON.parse(body);
      if (j && (j.title || j.detail)) detail = [j.title, j.detail].filter(Boolean).join(' — ');
    } catch { /* 保留原始文本片段 */ }
    return { error: `${SERVICE} 返回 HTTP ${res.status}:${what} 查询被拒。服务说明:${detail || '(无响应体)'}` };
  }

  try {
    return { data: JSON.parse(body) };
  } catch (err) {
    return { error: `${SERVICE} 响应不是合法 JSON:${what}(HTTP ${res.status})—— ${(err && err.message) || String(err)};响应片段:${body.slice(0, 200)}` };
  }
}

const isCountryCode = (s) => /^[A-Za-z]{2}$/.test(s);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 严格解析 YYYY-MM-DD(拒绝 2026-02-30 这类"存在格式但不存在的日子")。 */
function parseDate(s) {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

const DAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 裁剪成 agent 用得上的字段,不把整个 JSON 倒回上下文。 */
function trimHoliday(h) {
  const out = {
    date: h.date,
    localName: h.localName,
    name: h.name,
    global: h.global,
  };
  if (Array.isArray(h.counties) && h.counties.length) out.counties = h.counties;
  if (Array.isArray(h.types) && h.types.length) out.types = h.types;
  return out;
}

server.registerTool('list-holidays', {
  description:
    '查询某个国家某一年的法定节假日清单(Nager.Date)。返回每个节日的日期、本地名称(如"春节")与英文名、'
    + '是否全国通用(global)、适用行政区(counties,仅地方性节日有)与类型(types)。'
    + '适合排期、算跨节工期、给用户列出"今年还有哪些假"。'
    + '注意:只含法定节假日本身,不含中国调休补班这类行政调整。',
  inputSchema: {
    year: z.number().int().describe('公历年份,如 2026(Nager 覆盖约 1975-2100)'),
    countryCode: z.string().describe('ISO 3166-1 alpha-2 两位国家码,如 CN / US / DE(不是 CHN 这种三位码)'),
  },
}, async ({ year, countryCode }) => {
  if (!Number.isInteger(year) || year < 1975 || year > 2100) {
    return fail(`参数 year 非法:${year}。需要 1975-2100 之间的整数年份(${SERVICE} 的覆盖范围)。`);
  }
  if (!isCountryCode(countryCode)) {
    return fail(`参数 countryCode 非法:"${countryCode}"。需要两位字母的 ISO 3166-1 alpha-2 码(如 CN / US),三位码或全名不接受。`);
  }
  const code = countryCode.toUpperCase();

  const { data, error } = await getJson(`/PublicHolidays/${year}/${code}`, `${code} ${year} 年节假日`);
  if (error) return fail(error);
  if (!Array.isArray(data)) {
    return fail(`${SERVICE} 返回了预期之外的结构:${code} ${year} 年节假日应为数组,实际是 ${typeof data}。`);
  }

  const list = data.map(trimHoliday);
  const header = `${code} ${year} 年法定节假日 ${list.length} 个(来源 ${SERVICE})`;
  return ok(`${header}\n${JSON.stringify(list, null, 2)}`);
});

server.registerTool('is-workday', {
  description:
    '判断某个日期在某国是不是工作日:综合"周末"与"法定节假日"两条规则本地计算'
    + '(先拉该年节假日清单,再叠加星期判断)。返回是否工作日、星期几、命中的节日名(若有)。'
    + '适合算交付日、判断"这天能不能约会议/银行开不开门"。'
    + '注意:默认周末为周六周日,可用 weekend 参数改(如中东部分国家为周五周六);'
    + '不预测中国调休补班——被调成上班的周末仍会报"非工作日"。',
  inputSchema: {
    date: z.string().describe('日期,YYYY-MM-DD 格式,如 2026-08-15'),
    countryCode: z.string().describe('ISO 3166-1 alpha-2 两位国家码,如 CN / US'),
    weekend: z.array(z.number().int().min(0).max(6)).optional()
      .describe('可选:视为周末的星期序号数组,0=周日 … 6=周六。默认 [0,6](周六周日)'),
  },
}, async ({ date, countryCode, weekend }) => {
  const dt = parseDate(date);
  if (!dt) {
    return fail(`参数 date 非法:"${date}"。需要真实存在的 YYYY-MM-DD 日期(如 2026-08-15)。`);
  }
  if (!isCountryCode(countryCode)) {
    return fail(`参数 countryCode 非法:"${countryCode}"。需要两位字母的 ISO 3166-1 alpha-2 码(如 CN / US)。`);
  }
  const code = countryCode.toUpperCase();
  const year = dt.getUTCFullYear();
  if (year < 1975 || year > 2100) {
    return fail(`参数 date 的年份 ${year} 超出 ${SERVICE} 覆盖范围(1975-2100)。`);
  }

  const weekendDays = Array.isArray(weekend) && weekend.length ? [...new Set(weekend)] : [0, 6];
  if (weekendDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return fail(`参数 weekend 非法:${JSON.stringify(weekend)}。只接受 0-6 的整数(0=周日,6=周六)。`);
  }

  const { data, error } = await getJson(`/PublicHolidays/${year}/${code}`, `${code} ${year} 年节假日(用于工作日判断)`);
  if (error) return fail(error);
  if (!Array.isArray(data)) {
    return fail(`${SERVICE} 返回了预期之外的结构:${code} ${year} 年节假日应为数组,实际是 ${typeof data}。`);
  }

  const dow = dt.getUTCDay();
  const isWeekend = weekendDays.includes(dow);
  const holidays = data.filter((h) => h && h.date === date).map(trimHoliday);
  const isHoliday = holidays.length > 0;
  const isWorkday = !isWeekend && !isHoliday;

  const reasons = [];
  if (isWeekend) reasons.push(`${DAY_CN[dow]}属于周末`);
  if (isHoliday) reasons.push(`法定节假日:${holidays.map((h) => `${h.localName}${h.name && h.name !== h.localName ? `(${h.name})` : ''}`).join('、')}`);
  if (!reasons.length) reasons.push(`${DAY_CN[dow]},既非周末也非法定节假日`);

  const result = {
    date,
    countryCode: code,
    weekday: DAY_CN[dow],
    weekdayIndex: dow,
    isWorkday,
    isWeekend,
    isPublicHoliday: isHoliday,
    holidays,
    reason: reasons.join(';'),
  };
  return ok(`${date} 在 ${code}:${isWorkday ? '工作日' : '非工作日'}(${result.reason})\n${JSON.stringify(result, null, 2)}`);
});

server.registerTool('available-countries', {
  description:
    '列出 Nager.Date 支持查询节假日的所有国家(ISO 3166-1 alpha-2 码 + 英文名)。'
    + '用于在调用 list-holidays / is-workday 前确认某国是否被覆盖、或把国名反查成国家码。',
  inputSchema: {},
}, async () => {
  const { data, error } = await getJson('/AvailableCountries', '支持的国家清单');
  if (error) return fail(error);
  if (!Array.isArray(data)) {
    return fail(`${SERVICE} 返回了预期之外的结构:国家清单应为数组,实际是 ${typeof data}。`);
  }
  const list = data.map((c) => ({ countryCode: c.countryCode, name: c.name }));
  return ok(`${SERVICE} 支持 ${list.length} 个国家/地区\n${JSON.stringify(list, null, 2)}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
