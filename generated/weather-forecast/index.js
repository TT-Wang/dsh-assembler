#!/usr/bin/env node
/**
 * MCP stdio server: Open-Meteo 天气服务(https://api.open-meteo.com/v1)适配。
 * 能力点:按经纬度取当前实况、取未来 1-16 天逐日预报——agent 一轮内拿到
 * 可直接引用的温度/湿度/风速/天气现象,以及逐日高低温与降水量。
 *
 * 提供方 Open-Meteo,数据许可 CC-BY-4.0(免费非商用无限制;商用需订阅)。
 * 只读:本零件只调 /v1/forecast 查询端点,不做任何写操作,也不做并发扇出。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVICE = 'Open-Meteo(api.open-meteo.com)';
const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const USER_AGENT = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const TIMEOUT_MS = 15000;

const server = new McpServer({ name: 'weather-forecast', version: '0.0.1' });

const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });

/** WMO weather code → 中文含义(取常见档位,未收录的码返回 `未知天气现象(码 N)`)。 */
const WMO = {
  0: '晴', 1: '大部晴朗', 2: '局部多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '中毛毛雨', 55: '大毛毛雨', 56: '冻毛毛雨(小)', 57: '冻毛毛雨(大)',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨(小)', 67: '冻雨(大)',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '小阵雨', 81: '中阵雨', 82: '强阵雨', 85: '小阵雪', 86: '大阵雪',
  95: '雷暴', 96: '雷暴伴小冰雹', 99: '雷暴伴大冰雹',
};
const describeCode = (code) =>
  typeof code === 'number' ? (WMO[code] ?? `未知天气现象(WMO 码 ${code})`) : '未提供';

/**
 * 单次只读 GET:超时、非 2xx、JSON 解析失败一律转成 { error: 说明文本 },
 * 绝不向上抛裸异常。调用方拿到 error 就直接 fail()。
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
    // Open-Meteo 的 4xx 会带 {"error":true,"reason":"Latitude must be in range..."}
    let detail = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body);
      detail = parsed?.reason ?? parsed?.message ?? detail;
    } catch { /* 非 JSON 错误体,用原始文本前 300 字 */ }
    return { error: `${SERVICE} 返回 HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}:${detail}` };
  }

  try {
    return { data: JSON.parse(body) };
  } catch {
    return { error: `${SERVICE} 响应不是合法 JSON(HTTP ${res.status}),前 200 字符:${body.slice(0, 200)}` };
  }
}

/**
 * 经纬度合法性自查。zod 只把关"是不是数字",取值范围放在 handler 里查,
 * 越界时返回本零件统一的 { isError: true } 结果,而不是让 SDK 抛 JSON-RPC 错误。
 */
function badCoords(latitude, longitude) {
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) {
    return `参数错误:latitude 必须是 -90..90 之间的数字,收到 ${latitude}`;
  }
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) {
    return `参数错误:longitude 必须是 -180..180 之间的数字,收到 ${longitude}`;
  }
  return null;
}

const locationOf = (data) => ({
  latitude: data.latitude,
  longitude: data.longitude,
  elevation: data.elevation,
  timezone: data.timezone,
});

server.registerTool('current-weather', {
  description:
    '查询指定经纬度的当前天气实况(Open-Meteo)。返回当前温度(°C)、相对湿度(%)、'
    + '10 米风速(km/h)、WMO 天气代码及其中文含义,并附观测时刻(当地时区)与实际匹配到的'
    + '网格点坐标/海拔/时区。经纬度越界(|lat|>90 或 |lon|>180)时返回错误而不发请求。',
  inputSchema: {
    latitude: z.number().describe('纬度,-90..90,如北京 39.9042'),
    longitude: z.number().describe('经度,-180..180,如北京 116.4074'),
  },
}, async ({ latitude, longitude }) => {
  const bad = badCoords(latitude, longitude);
  if (bad) return fail(bad);

  const url = `${ENDPOINT}?latitude=${latitude}&longitude=${longitude}`
    + '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code'
    + '&timezone=auto';
  const { data, error } = await getJson(url);
  if (error) return fail(error);

  const cur = data?.current;
  const units = data?.current_units ?? {};
  if (!cur || typeof cur.temperature_2m !== 'number') {
    return fail(`${SERVICE} 响应结构异常:缺少 current.temperature_2m 字段`);
  }

  return ok({
    location: locationOf(data),
    observedAt: cur.time,
    temperature: { value: cur.temperature_2m, unit: units.temperature_2m ?? '°C' },
    humidity: { value: cur.relative_humidity_2m, unit: units.relative_humidity_2m ?? '%' },
    windSpeed: { value: cur.wind_speed_10m, unit: units.wind_speed_10m ?? 'km/h' },
    weather: { code: cur.weather_code, description: describeCode(cur.weather_code) },
    source: 'Open-Meteo, CC-BY-4.0',
  });
});

server.registerTool('daily-forecast', {
  description:
    '查询指定经纬度未来 N 天(1-16)的逐日预报(Open-Meteo)。每天返回日期、最高温、最低温'
    + '(均为 °C)与日累计降水量(mm),按当地时区切分自然日。days 越界或经纬度越界时返回错误'
    + '而不发请求;返回的 days 数组长度即请求天数。',
  inputSchema: {
    latitude: z.number().describe('纬度,-90..90'),
    longitude: z.number().describe('经度,-180..180'),
    days: z.number().optional().describe('预报天数,整数 1..16,默认 7'),
  },
}, async ({ latitude, longitude, days }) => {
  const bad = badCoords(latitude, longitude);
  if (bad) return fail(bad);

  const n = days ?? 7;
  if (!Number.isInteger(n) || n < 1 || n > 16) {
    return fail(`参数错误:days 必须是 1..16 之间的整数,收到 ${days}`);
  }

  const url = `${ENDPOINT}?latitude=${latitude}&longitude=${longitude}`
    + '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum'
    + `&forecast_days=${n}&timezone=auto`;
  const { data, error } = await getJson(url);
  if (error) return fail(error);

  const daily = data?.daily;
  const units = data?.daily_units ?? {};
  if (!daily || !Array.isArray(daily.time)) {
    return fail(`${SERVICE} 响应结构异常:缺少 daily.time 数组`);
  }

  return ok({
    location: locationOf(data),
    units: {
      tempMax: units.temperature_2m_max ?? '°C',
      tempMin: units.temperature_2m_min ?? '°C',
      precipitation: units.precipitation_sum ?? 'mm',
    },
    days: daily.time.map((date, i) => ({
      date,
      tempMax: daily.temperature_2m_max?.[i] ?? null,
      tempMin: daily.temperature_2m_min?.[i] ?? null,
      precipitation: daily.precipitation_sum?.[i] ?? null,
    })),
    source: 'Open-Meteo, CC-BY-4.0',
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
