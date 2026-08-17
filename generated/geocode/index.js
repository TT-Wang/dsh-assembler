#!/usr/bin/env node
/**
 * MCP stdio server: OpenStreetMap Nominatim 地理编码服务
 * (https://nominatim.openstreetmap.org)适配。
 * 能力点:地址文本 → 坐标(正向地理编码)、坐标 → 地址(反向地理编码)。
 *
 * **服务条款(必须遵守)**:Nominatim 严格限速 1 req/s 且强制要求 User-Agent,
 * 违反会被封禁。本零件自带节流:所有请求串成一条队列,相邻两次请求的发起间隔
 * 不小于 MIN_INTERVAL_MS(1100ms),因此连续多次调用**必然变慢,这是预期行为**。
 * 同理绝不做并发扇出——即使 agent 同时发起多个工具调用,也会被队列排成串行。
 *
 * 数据许可 ODbL-1.0,使用时须保留 OpenStreetMap 署名。只读:只调查询端点。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVICE = 'Nominatim(nominatim.openstreetmap.org)';
const BASE_URL = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const TIMEOUT_MS = 15000;
const MIN_INTERVAL_MS = 1100; // 条款要求 1 req/s,留 100ms 余量
const ATTRIBUTION = 'Data © OpenStreetMap contributors, ODbL 1.0 — https://osm.org/copyright';

const server = new McpServer({ name: 'geocode', version: '0.0.1' });

const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- 节流闸:模块级时间戳 + 串行队列 ---------------------------------------
let lastRequestAt = 0;
let queue = Promise.resolve();

/**
 * 把 run() 排进全局队列执行,并保证与上一次请求的发起时刻至少相隔 MIN_INTERVAL_MS。
 * 队列不会因为某次请求失败而中断(尾部 catch 吞掉结果,只保留时序)。
 */
function throttled(run) {
  const task = queue.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return run();
  });
  queue = task.then(() => undefined, () => undefined);
  return task;
}

/**
 * 单次只读 GET(已过节流闸):超时、非 2xx、JSON 解析失败一律转成
 * { error: 说明文本 },绝不向上抛裸异常。
 */
async function getJson(url) {
  return throttled(async () => {
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
      const hint = res.status === 403 || res.status === 429
        ? '(触发了 Nominatim 的限速/封禁策略——本零件已按 1 req/s 节流,若仍出现说明同一 IP 上有其他调用方)'
        : '';
      return { error: `${SERVICE} 返回 HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}:${body.slice(0, 200)}${hint}` };
    }

    try {
      return { data: JSON.parse(body) };
    } catch {
      return { error: `${SERVICE} 响应不是合法 JSON(HTTP ${res.status}),前 200 字符:${body.slice(0, 200)}` };
    }
  });
}

// zod 只把关类型,取值范围放在 handler 里查,越界时返回本零件统一的 { isError: true }。
function badCoords(latitude, longitude) {
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) {
    return `参数错误:latitude 必须是 -90..90 之间的数字,收到 ${latitude}`;
  }
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) {
    return `参数错误:longitude 必须是 -180..180 之间的数字,收到 ${longitude}`;
  }
  return null;
}

/** Nominatim 的 lat/lon/boundingbox 都是字符串,统一转成数字再交给 agent。 */
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

/** boundingbox 是 [south, north, west, east] 字符串数组。 */
function boundingBox(bb) {
  if (!Array.isArray(bb) || bb.length < 4) return undefined;
  return { south: num(bb[0]), north: num(bb[1]), west: num(bb[2]), east: num(bb[3]) };
}

/** 把一条 Nominatim 记录裁剪成 agent 用得上的字段(丢掉 place_id/licence/place_rank 等)。 */
const trim = (hit) => ({
  displayName: hit.display_name,
  name: hit.name || undefined,
  latitude: num(hit.lat),
  longitude: num(hit.lon),
  category: hit.class,
  type: hit.type,
  addressType: hit.addresstype,
  boundingBox: boundingBox(hit.boundingbox),
  osmType: hit.osm_type,
  osmId: hit.osm_id,
});

server.registerTool('geocode-address', {
  description:
    '正向地理编码:把地址或地名文本解析成坐标(OpenStreetMap Nominatim)。'
    + '返回 results 数组,每条含规范化地名 displayName、经纬度、地物类别(category/type/addressType)、'
    + '外接矩形 boundingBox 与 OSM 对象 id,按相关度排序。查不到时返回 { found: false, results: [] } '
    + '这种结构化结果(不是错误);只有 query 为空或 limit 越界才算参数错误。'
    + '注意:受服务条款约束,本零件内部按 1 req/s 串行节流,连续调用会变慢。',
  inputSchema: {
    query: z.string().describe('要解析的地址或地名,如 "Beijing"、"北京市朝阳区"、"1600 Amphitheatre Parkway"'),
    limit: z.number().optional().describe('最多返回几条候选,整数 1..5,默认 1'),
  },
}, async ({ query, limit }) => {
  const q = String(query ?? '').trim();
  if (q === '') return fail('参数错误:query 不能为空');

  const n = limit ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    return fail(`参数错误:limit 必须是 1..5 之间的整数,收到 ${limit}`);
  }

  const url = `${BASE_URL}/search?${new URLSearchParams({ q, format: 'json', limit: String(n) })}`;
  const { data, error } = await getJson(url);
  if (error) return fail(error);
  if (!Array.isArray(data)) {
    return fail(`${SERVICE} 响应结构异常:/search 预期返回数组,实际是 ${typeof data}`);
  }

  if (data.length === 0) {
    return ok({
      query: q,
      found: false,
      count: 0,
      results: [],
      hint: 'OpenStreetMap 里没有匹配到该地名——可换更完整的写法(补上城市/国家)或改用当地语言再试',
      attribution: ATTRIBUTION,
    });
  }

  return ok({ query: q, found: true, count: data.length, results: data.map(trim), attribution: ATTRIBUTION });
});

server.registerTool('reverse-geocode', {
  description:
    '反向地理编码:把经纬度解析成最近的地址(OpenStreetMap Nominatim)。'
    + '返回规范化地址 displayName 与拆解后的 address 结构(国家/省市/街道/邮编等),'
    + '外加地物类别与 OSM 对象 id。坐标落在公海或无覆盖区域时返回 { found: false } 这种'
    + '结构化结果(不是错误);经纬度越界(|lat|>90 或 |lon|>180)才算参数错误,且不会发出请求。'
    + '注意:受服务条款约束,本零件内部按 1 req/s 串行节流,连续调用会变慢。',
  inputSchema: {
    latitude: z.number().describe('纬度,-90..90,如 39.9042'),
    longitude: z.number().describe('经度,-180..180,如 116.4074'),
  },
}, async ({ latitude, longitude }) => {
  const bad = badCoords(latitude, longitude);
  if (bad) return fail(bad);

  const url = `${BASE_URL}/reverse?${new URLSearchParams({
    lat: String(latitude), lon: String(longitude), format: 'json',
  })}`;
  const { data, error } = await getJson(url);
  if (error) return fail(error);

  // 查不到时 Nominatim 仍回 HTTP 200,body 是 {"error":"Unable to geocode"}
  if (!data || typeof data !== 'object' || data.error) {
    return ok({
      found: false,
      latitude,
      longitude,
      hint: `该坐标附近没有可匹配的 OSM 地物(公海/无人区常见)。服务端说明:${data?.error ?? '无'}`,
      attribution: ATTRIBUTION,
    });
  }
  if (!data.display_name) {
    return fail(`${SERVICE} 响应结构异常:/reverse 返回体缺少 display_name 字段`);
  }

  return ok({
    found: true,
    ...trim(data),
    address: data.address,
    queried: { latitude, longitude },
    attribution: ATTRIBUTION,
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
