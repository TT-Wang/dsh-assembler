#!/usr/bin/env node
/**
 * MCP stdio server: APIs.guru 目录(https://api.apis.guru/v2)适配。
 * 能力点:按关键词在全网 OpenAPI 目录里搜接口、查某个提供方收录了哪些接口、
 * 列出目录收录的提供方——agent 回答"有没有现成的天气 API""GitHub 的 OpenAPI 规范在哪",
 * 一轮内拿到可直接下载的 swaggerUrl。
 *
 * 数据许可 CC0 1.0。只读:只调 GET 查询端点(该目录本来也没有写端点)。
 *
 * === 返回体裁剪(不是优化,是硬约束)===
 * GET /v2/list.json 是**全量目录**:实测 2026-08-17 为 **8,855,894 字节 / 2,529 个 API**,
 * 而且每个条目里塞着完整的 info(含长描述、x-logo、x-origin…)。整包透传等于当场炸掉上下文,
 * 所以:① 每条只留 name/title/description(截断)/version/swaggerUrl 等少数字段;
 * ② 条数强制上限;③ 全量包在进程内缓存 LIST_TTL_MS,避免每次搜索都重下 8.8MB。
 * APIs.guru 没有服务端搜索端点,"搜索"只能靠本地过滤这份全量包——这是接口的限制,不是选择。
 *
 * === 实测记录(2026-08-17,工单里的端点清单是从 spec 抽的,与实际返回有出入)===
 * 1) **两个端点的条目形状不一样,别共用一个解析器**:
 *    - /v2/list.json  → { "<apiKey>": { added, preferred, versions: { "<ver>": {info, swaggerUrl, …} } } }
 *      版本是**嵌套**的,要靠 preferred 挑一版(实测 2529 条里 preferred 全部能在 versions 里找到)。
 *    - /v2/{provider}.json → { apis: { "<apiKey>": { added, updated, info, swaggerUrl, openapiVer, link } } }
 *      **已经拍平到首选版本了,没有 versions / preferred 字段**。照 list.json 的写法去读
 *      entry.versions[entry.preferred] 会直接 TypeError。
 * 2) **查不到的 provider 返回 404 + text/html**(Cloudflare 的错误页,不是 JSON)。
 *    所以必须**先看状态码再解析 JSON**,否则会把"这个提供方不存在"误报成"响应不是合法 JSON"。
 * 3) /v2/providers.json → { data: [ "1forge.com", ... ] } 实测 677 个提供方,纯字符串数组。
 * 4) 单个提供方的接口数差异极大:github.com 20 个,azure.com 1829 个 —— 单提供方也必须限条数。
 * 5) 匿名可用:带不带 Authorization 都是 200(实测拿伪造 token 也不影响)。
 *
 * === 凭证 ===
 * .index-meta.json 声明了 APISGURU_TOKEN(可选)与 EXTRA_TOKEN。二者都**只从本进程环境变量读**,
 * 绝不写进代码、绝不做成工具参数。APIs.guru 公开匿名可用,所以未配置时一切照常工作(不是错误);
 * 配了 APISGURU_TOKEN 就按 Bearer 发出去。EXTRA_TOKEN 是脚手架用来测"分号分隔多凭证"的占位,
 * APIs.guru 侧并没有第二条凭证通道,这里如实**读取但不使用**,不编造用途。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVICE = 'APIs.guru 目录(api.apis.guru)';
const BASE_URL = 'https://api.apis.guru/v2';
const USER_AGENT = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const TIMEOUT_MS = 15000;
const LIST_TTL_MS = 10 * 60 * 1000; // 全量目录一天才更新几次,缓存 10 分钟足够且安全
const DESC_MAX = 240;               // 单条描述截断长度
const SOURCE = 'APIs.guru (https://apis.guru), CC0 1.0';

// 凭证只从环境变量读。APIs.guru 匿名可用,所以"没配"是正常状态,不构成错误。
// (EXTRA_TOKEN 见文件头:脚手架的多凭证占位,APIs.guru 侧没有第二条凭证通道,
//  这里刻意不读也不用——与其留一个永远用不上的死变量,不如把原因写在这。)
const APISGURU_TOKEN = process.env.APISGURU_TOKEN || '';

const server = new McpServer({ name: 'apisguru-directory', version: '0.0.1' });

const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });

/**
 * 传输层韧性:瞬时故障重试一次,再失败则绕开代理重试。
 *
 * 两类失败与服务的"答复"无关,属于环境:① 瞬时抖动(socket 重置、DNS/TLS
 * 打嗝)——短暂退避后重试一次即可把假红变成真读数;② 代理不对称——同一机器上
 * 某些域名必须走代理、兄弟域名走代理反而断。
 * HTTP 状态码一律不重试:404 是答复(这个 provider 不存在),不是断路。
 */
async function resilientFetch(url, init) {
  const attempt = (dispatcher) => fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...(dispatcher === undefined ? {} : { dispatcher }),
  });
  try {
    return await attempt(undefined);
  } catch (first) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      return await attempt(undefined);
    } catch {
      const proxied = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
      if (!proxied) throw first;
      const { Agent } = await import('undici');
      return await attempt(new Agent());
    }
  }
}

/**
 * 单次只读 GET。超时、非 2xx、JSON 解析失败一律转成 { error: 说明文本 },绝不抛裸异常。
 * 404 额外带 { notFound: true },由调用方决定它是"正常的查不到"还是"错误"。
 * what = 这次请求在业务上是什么(拼进错误信息,让 agent 知道是哪个接口出的问题)。
 */
async function getJson(url, what) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  // 只在真的配了凭证时才加这个头:APIs.guru 匿名可用,空 Bearer 反而是噪音。
  if (APISGURU_TOKEN) headers.Authorization = `Bearer ${APISGURU_TOKEN}`;

  let res;
  try {
    res = await resilientFetch(url, { headers });
  } catch (e) {
    const name = e?.name ?? '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return {
        error: `${SERVICE} 请求超时:${what} 在 ${TIMEOUT_MS / 1000}s 内没有响应(${url})。`
          + '若查的是全量目录,注意该文件约 8.8MB,网络慢时确实可能超时,稍后重试即可。',
      };
    }
    return { error: `${SERVICE} 网络请求失败:${what}(${url})—— ${e?.message ?? String(e)}` };
  }

  // 关键顺序:先判状态码再解析 JSON。404 的响应体是 Cloudflare 的 HTML 错误页,
  // 先解析就会把"这个 provider 不存在"误报成"响应不是合法 JSON"。
  if (res.status === 404) {
    return { notFound: true, error: `${SERVICE} 返回 HTTP 404:${what} 在目录里不存在(${url})` };
  }

  let body;
  try {
    body = await res.text();
  } catch (e) {
    return { error: `${SERVICE} 读取响应体失败:${what} —— ${e?.message ?? String(e)}` };
  }

  if (res.status === 429) {
    return { error: `${SERVICE} 返回 HTTP 429:${what} 触发限速,请降低调用频率后重试(${url})` };
  }
  if (!res.ok) {
    return { error: `${SERVICE} 返回 HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}:${what} 查询失败(${url})。响应片段:${body.slice(0, 250) || '(无响应体)'}` };
  }

  try {
    return { data: JSON.parse(body) };
  } catch {
    return { error: `${SERVICE} 响应不是合法 JSON(HTTP ${res.status},${what}),前 200 字符:${body.slice(0, 200)}` };
  }
}

// ---- 全量目录缓存 -----------------------------------------------------------
// list.json 8.8MB / 2529 条。没有服务端搜索端点,只能本地过滤,所以必须缓存,
// 否则每次 search-apis 都要重下一遍。缓存的是解析后的对象,进程退出即失效。
let listCache = { at: 0, data: null };

async function getDirectory() {
  const fresh = listCache.data && (Date.now() - listCache.at) < LIST_TTL_MS;
  if (fresh) return { data: listCache.data, cached: true };

  const { data, error } = await getJson(`${BASE_URL}/list.json`, '拉取全量 API 目录(list.json,约 8.8MB)');
  if (error) return { error };
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: `${SERVICE} 响应结构异常:/list.json 预期返回 "apiKey → 条目" 的对象,实际是 ${Array.isArray(data) ? 'array' : typeof data}` };
  }
  listCache = { at: Date.now(), data };
  return { data, cached: false };
}

/** 描述可能极长(整段 markdown),截断并压掉换行,免得一条记录吃掉半个上下文。 */
function shortDesc(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (s === '') return undefined;
  return s.length > DESC_MAX ? `${s.slice(0, DESC_MAX)}…` : s;
}

/**
 * list.json 的条目:版本是**嵌套**的,用 preferred 挑一版。
 * 形状见文件头实测记录 (1) —— 别拿这个函数去读 {provider}.json 的条目。
 */
function trimListEntry(name, entry) {
  const v = entry?.versions?.[entry?.preferred];
  if (!v) return null;
  return {
    name,                                  // 目录里的唯一键,如 "github.com:api.github.com"
    title: v.info?.title,
    description: shortDesc(v.info?.description),
    version: v.info?.version ?? entry.preferred,
    preferredVersion: entry.preferred,
    versionCount: Object.keys(entry.versions ?? {}).length,
    provider: v.info?.['x-providerName'],
    categories: v.info?.['x-apisguru-categories'] ?? [],
    swaggerUrl: v.swaggerUrl,              // 可直接下载的 OpenAPI 文档地址
    openapiVer: v.openapiVer,
    updated: v.updated,
  };
}

/**
 * {provider}.json 的条目:**已拍平到首选版本,没有 versions / preferred**。
 * 形状见文件头实测记录 (1)。
 */
function trimProviderEntry(name, entry) {
  return {
    name,
    title: entry?.info?.title,
    description: shortDesc(entry?.info?.description),
    version: entry?.info?.version,
    provider: entry?.info?.['x-providerName'],
    serviceName: entry?.info?.['x-serviceName'],
    categories: entry?.info?.['x-apisguru-categories'] ?? [],
    swaggerUrl: entry?.swaggerUrl,
    openapiVer: entry?.openapiVer,
    updated: entry?.updated,
  };
}

// zod 只把关类型,取值范围放在 handler 里查,越界时返回本零件统一的 { isError: true }。
function normLimit(limit, def, max) {
  const n = limit ?? def;
  if (!Number.isInteger(n) || n < 1 || n > max) {
    return { error: `参数错误:limit 必须是 1..${max} 之间的整数,收到 ${limit}` };
  }
  return { n };
}

server.registerTool('search-apis', {
  description:
    '在 APIs.guru 目录里按关键词搜 OpenAPI 接口(目前收录约 2500 个 API / 677 个提供方)。'
    + '关键词会在目录键名、标题、描述、提供方、分类里做不分大小写的子串匹配,'
    + '命中优先级:键名 > 标题 > 分类/提供方 > 描述。'
    + '返回 { query, totalMatched, count, results },每条含 name(目录唯一键,可直接喂给 get-api-info)、'
    + 'title、description(已截断)、version、provider、categories、swaggerUrl(可直接下载的 OpenAPI 文档地址)。'
    + '结果默认最多 10 条(limit 可调 1..25):全量目录约 8.8MB,不裁剪会淹掉上下文;'
    + 'totalMatched 会告诉你一共命中多少条,便于判断要不要换更具体的关键词。'
    + '搜不到时返回 { totalMatched: 0, results: [] } 这种结构化结果(不是错误)。',
  inputSchema: {
    query: z.string().describe('搜索关键词,如 "weather"、"github"、"payment"、"machine learning"'),
    limit: z.number().optional().describe('最多返回几条,整数 1..25,默认 10'),
  },
}, async ({ query, limit }) => {
  const q = String(query ?? '').trim().toLowerCase();
  if (q === '') return fail('参数错误:query 不能为空');
  const lim = normLimit(limit, 10, 25);
  if (lim.error) return fail(lim.error);

  const { data, error, cached } = await getDirectory();
  if (error) return fail(error);

  // 本地过滤 + 打分。APIs.guru 没有服务端搜索端点,只能这么干。
  const matches = [];
  for (const [name, entry] of Object.entries(data)) {
    const trimmed = trimListEntry(name, entry);
    if (!trimmed) continue;

    const inName = name.toLowerCase().includes(q);
    const inTitle = String(trimmed.title ?? '').toLowerCase().includes(q);
    const inCat = String(trimmed.provider ?? '').toLowerCase().includes(q)
      || trimmed.categories.some((c) => String(c).toLowerCase().includes(q));
    const inDesc = String(trimmed.description ?? '').toLowerCase().includes(q);
    if (!inName && !inTitle && !inCat && !inDesc) continue;

    const score = (inName ? 8 : 0) + (inTitle ? 4 : 0) + (inCat ? 2 : 0) + (inDesc ? 1 : 0);
    matches.push({ score, name, trimmed });
  }

  // 同分按名字排,保证同一份目录下结果顺序稳定(不随对象枚举顺序抖)。
  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const results = matches.slice(0, lim.n).map((m) => m.trimmed);

  return ok({
    query: String(query).trim(),
    totalMatched: matches.length,
    count: results.length,
    truncated: matches.length > results.length,
    directorySize: Object.keys(data).length,
    results,
    hint: matches.length === 0
      ? '目录里没有匹配的接口——换个更宽泛的英文关键词试试(目录条目基本都是英文),或用 list-providers 看有哪些提供方'
      : (matches.length > results.length
        ? `共命中 ${matches.length} 条,已按 limit=${lim.n} 截断;换更具体的关键词可以收窄`
        : undefined),
    cacheHit: cached,
    source: SOURCE,
  });
});

server.registerTool('get-api-info', {
  description:
    '查某个提供方在 APIs.guru 目录里收录的接口元数据。'
    + 'provider 是域名形式的提供方标识(如 "github.com"、"stripe.com"、"googleapis.com"),'
    + '可用 list-providers 或 search-apis 的结果拿到。'
    + '可选的 api 参数用来在该提供方下筛某一个接口(填 search-apis 返回的 name 全键如 '
    + '"github.com:api.github.com",或冒号后的服务名如 "api.github.com" 均可)。'
    + '返回 { provider, totalApis, count, apis },每条含 title、description、version、'
    + 'categories、swaggerUrl(可直接下载的 OpenAPI 文档地址)、openapiVer、updated。'
    + '注意单个提供方的接口数差异极大(github.com 20 个,azure.com 1829 个),所以结果默认最多 25 条'
    + '(limit 可调 1..100),totalApis 给出真实总数。'
    + '提供方不存在、或该提供方下没有匹配的 api 时,返回 { found: false } 这种结构化结果(不是错误)。',
  inputSchema: {
    provider: z.string().describe('提供方标识,域名形式,如 "github.com"'),
    api: z.string().optional().describe('可选:只看该提供方下的这一个接口,如 "github.com:api.github.com" 或 "api.github.com"'),
    limit: z.number().optional().describe('最多返回几条,整数 1..100,默认 25'),
  },
}, async ({ provider, api, limit }) => {
  const p = String(provider ?? '').trim();
  if (p === '') return fail('参数错误:provider 不能为空(域名形式,如 "github.com")');
  // provider 会拼进 URL 路径:斜杠和 .. 会改变请求的是哪个端点,本地就拦掉。
  if (/[/\\?#\s]/.test(p) || p.includes('..')) {
    return fail(`参数错误:provider 只能是域名形式的标识(如 "github.com"),不能包含斜杠、问号、井号、空白或 "..",收到 "${provider}"`);
  }
  const lim = normLimit(limit, 25, 100);
  if (lim.error) return fail(lim.error);

  const url = `${BASE_URL}/${encodeURIComponent(p)}.json`;
  const { data, error, notFound } = await getJson(url, `查提供方 "${p}" 收录的接口`);

  // 404 是正常业务结果(目录里没有这个提供方),不是故障 —— 走结构化"未找到"。
  if (notFound) {
    return ok({
      found: false,
      provider: p,
      apis: [],
      hint: `目录里没有 "${p}" 这个提供方。提供方标识是域名形式(如 "github.com"),`
        + '可用 list-providers 列出全部,或用 search-apis 按关键词反查。',
      source: SOURCE,
    });
  }
  if (error) return fail(error);

  // 实测形状:{ apis: { "<apiKey>": 已拍平到首选版本的条目 } } —— 没有 versions/preferred。
  const apisObj = data?.apis;
  if (!apisObj || typeof apisObj !== 'object' || Array.isArray(apisObj)) {
    return fail(`${SERVICE} 响应结构异常:/${p}.json 预期返回 { apis: {…} },实际顶层字段是 ${Object.keys(data ?? {}).join(',') || '(空)'}`);
  }

  let entries = Object.entries(apisObj);
  const totalApis = entries.length;

  if (api !== undefined) {
    const want = String(api).trim().toLowerCase();
    if (want === '') return fail('参数错误:api 传了但为空——要看该提供方的全部接口就整个省略这个参数');
    // 全键 "provider:service" 与裸服务名都接受。
    entries = entries.filter(([k]) => {
      const key = k.toLowerCase();
      return key === want || key.split(':')[1] === want || key.endsWith(`:${want}`);
    });
    if (entries.length === 0) {
      return ok({
        found: false,
        provider: p,
        api: String(api).trim(),
        totalApis,
        apis: [],
        availableApis: Object.keys(apisObj).slice(0, 25), // 给出可选项,便于纠正
        hint: `提供方 "${p}" 存在(共收录 ${totalApis} 个接口),但其中没有叫 "${api}" 的。`
          + 'availableApis 列出了前 25 个可用的键名(省略 api 参数可看全部)。',
        source: SOURCE,
      });
    }
  }

  const apis = entries.slice(0, lim.n).map(([k, v]) => trimProviderEntry(k, v));

  return ok({
    found: true,
    provider: p,
    api: api === undefined ? undefined : String(api).trim(),
    totalApis,
    count: apis.length,
    truncated: entries.length > apis.length,
    apis,
    note: entries.length > apis.length
      ? `该提供方共收录 ${totalApis} 个接口,已按 limit=${lim.n} 截断;用 api 参数可以精确定位某一个`
      : undefined,
    source: SOURCE,
  });
});

server.registerTool('list-providers', {
  description:
    '列出 APIs.guru 目录收录的提供方(实测约 677 个,域名形式,如 "github.com"、"azure.com")。'
    + '拿到的标识可直接喂给 get-api-info 查该提供方收录了哪些接口。'
    + '可选的 filter 参数按子串筛选(不分大小写),比如 filter="google" 只看 Google 系。'
    + '返回 { totalProviders, matched, count, providers }:totalProviders 是目录里的总数,'
    + 'matched 是筛选后命中数,providers 是本次返回的名单。'
    + '结果默认最多 50 条(limit 可调 1..200)——677 个全吐出来对上下文不划算,'
    + '要找特定提供方请用 filter 而不是调大 limit。'
    + '收录数天天在涨,不要把某个具体数量当常量。',
  inputSchema: {
    filter: z.string().optional().describe('可选:只保留包含该子串的提供方,不分大小写,如 "google"、".gov"'),
    limit: z.number().optional().describe('最多返回几条,整数 1..200,默认 50'),
  },
}, async ({ filter, limit }) => {
  const lim = normLimit(limit, 50, 200);
  if (lim.error) return fail(lim.error);

  const { data, error } = await getJson(`${BASE_URL}/providers.json`, '列出目录收录的提供方');
  if (error) return fail(error);

  // 实测形状:{ data: [ "1forge.com", ... ] } —— 纯字符串数组。
  const all = data?.data;
  if (!Array.isArray(all)) {
    return fail(`${SERVICE} 响应结构异常:/providers.json 预期返回 { data: [...] },实际 data 字段是 ${typeof all}`);
  }

  const f = filter === undefined ? '' : String(filter).trim().toLowerCase();
  const matched = f === '' ? all : all.filter((x) => String(x).toLowerCase().includes(f));
  const providers = matched.slice(0, lim.n);

  return ok({
    filter: f === '' ? undefined : String(filter).trim(),
    totalProviders: all.length,
    matched: matched.length,
    count: providers.length,
    truncated: matched.length > providers.length,
    providers,
    hint: matched.length === 0
      ? `没有提供方包含 "${filter}"——提供方是域名形式的标识,试试更短的子串(如 "google" 而不是 "Google Cloud")`
      : (matched.length > providers.length
        ? `共命中 ${matched.length} 个,已按 limit=${lim.n} 截断;用 filter 收窄比调大 limit 划算`
        : undefined),
    source: SOURCE,
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
