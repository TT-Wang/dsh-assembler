#!/usr/bin/env node
/**
 * MCP stdio server: Swagger Petstore(OpenAPI 3.0 公共演示服务)适配。
 * 能力点:按上架状态找宠物、按 id 取单只宠物详情、取全店各状态库存计数——
 * agent 回答"现在有哪些宠物可领养""3 号宠物是什么品种""店里还剩多少存货",一轮内完成。
 *
 * === Base URL 的坑(必读)===
 * 源 spec(https://petstore3.swagger.io/api/v3/openapi.json)的 servers 只写了
 *   "servers": [ { "url": "/api/v3" } ]
 * —— 是**相对路径**,不带 scheme 和 host。工单里抄下来的 "Base URL:/api/v3" 就是它。
 * 相对 URL 在浏览器里靠"当前页面的 origin"补全,但零件是独立进程,没有 origin 可继承,
 * 直接拿 "/api/v3" 去 fetch 只会得到 "Failed to parse URL"。
 * 所以这里写死完整地址,host 取自 spec 的下载地址本身(spec 托管在哪,服务就在哪):
 *   /api/v3  +  petstore3.swagger.io  =  https://petstore3.swagger.io/api/v3
 * 换部署环境时改 BASE_URL 这一行即可,别回头去信 spec 的 servers。
 *
 * === 只读(刻意为之,别加写工具)===
 * 这是**公共**演示服务,任何人都能写。spec 里的 POST /pet、PUT /pet、DELETE /pet/{petId}、
 * POST /store/order 等写端点一律**不实现**:写进去的数据是全世界共用的一份,
 * 会污染其他使用者,也会被其他使用者随时改掉。本零件只调 GET 查询端点。
 *
 * === 实测记录(2026-08-17,与 spec 不符,别照 spec 想当然)===
 * 1) **集合端点整体 500**:GET /pet/findByStatus(available/pending/sold 三值全试)、
 *    GET /pet/findByTags、GET /store/inventory 全部稳定返回
 *    {"code":500,"message":"There was an error processing your request..."}。
 *    走代理和直连(--noproxy '*')结果一致,是**服务端故障不是网络问题**。
 *    成因基本可确定:这个 store 公开可写,有人写进了序列化不了的脏记录,
 *    于是任何"要把整个集合吐出来"的端点都炸。单条 GET /pet/{id} 里也能看到同样的伤:
 *    id 2 和 id 6 稳定 500,而 1/3/4/5/7..12/100/999 正常 200。
 *    → 代码按 spec 正确实现(故障是对方的,不是零件的),但错误信息必须把这件事说清楚,
 *      免得 agent 以为是自己参数传错了。
 * 2) **该部署用 500 代替 404**:查一个不存在的 id(4242 / 77777 / 999999999)返回的是 500,
 *    不是 spec 承诺的 404;/store/order/{id} 和 /user/{username} 同理。
 *    → 404 → 结构化"未找到"的分支照留(spec 如此,修好后也该如此),
 *      但 5xx 的错误文案必须同时提示"也可能只是这个 id 不存在"。
 * 3) 参数校验是好的:status 传非法值 → 400 并列出 allowable values;
 *    petId 传非数字 → 400。本零件把这两类在本地就拦下来,不浪费一次往返。
 *
 * 许可 Apache 2.0,条款 https://swagger.io/terms/,未声明限速(本零件不做并发扇出)。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVICE = 'Swagger Petstore(petstore3.swagger.io)';
// spec 的 servers 只给了相对路径 "/api/v3",必须自己补上 host —— 见文件头"Base URL 的坑"。
const BASE_URL = 'https://petstore3.swagger.io/api/v3';
const USER_AGENT = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const TIMEOUT_MS = 15000;
const STATUSES = ['available', 'pending', 'sold'];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const server = new McpServer({ name: 'petstore-demo', version: '0.0.1' });

const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });

/**
 * 传输层韧性:瞬时故障重试一次,再失败则绕开代理重试。
 *
 * 两类失败与服务的"答复"无关,属于环境:① 瞬时抖动(socket 重置、DNS/TLS
 * 打嗝)——短暂退避后重试一次即可把假红变成真读数;② 代理不对称——同一机器上
 * 某些域名必须走代理、兄弟域名走代理反而断。
 * HTTP 状态码一律不重试:500/400/404 都是答复,不是断路;
 * 重试一个 500 只会把一次故障放大成三次,还骗不到不同的结果(实测该服务的 500 是确定性的)。
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
  let res;
  try {
    res = await resilientFetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
  } catch (e) {
    const name = e?.name ?? '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { error: `${SERVICE} 请求超时:${what} 在 ${TIMEOUT_MS / 1000}s 内没有响应(${url})` };
    }
    return { error: `${SERVICE} 网络请求失败:${what}(${url})—— ${e?.message ?? String(e)}` };
  }

  let body;
  try {
    body = await res.text();
  } catch (e) {
    return { error: `${SERVICE} 读取响应体失败:${what} —— ${e?.message ?? String(e)}` };
  }

  // 服务端错误体形如 {"code":400,"message":"Input error: ..."},能解出来就用它的 message。
  const detail = (() => {
    try {
      const parsed = JSON.parse(body);
      return parsed?.message ?? body.slice(0, 250);
    } catch {
      return body.slice(0, 250) || '(无响应体)';
    }
  })();

  if (res.status === 404) {
    return { notFound: true, error: `${SERVICE} 返回 HTTP 404:${what} 不存在(${url})` };
  }
  if (res.status >= 500) {
    return {
      error: `${SERVICE} 返回 HTTP ${res.status}:${what} 失败(${url})。服务端说明:${detail}。`
        + '这是**对方服务的故障,不是请求参数的问题**,重试通常无效。两种常见成因:'
        + '(a) 这是公开可写的演示服务,有人写入了脏数据,导致任何返回整个集合的端点'
        + '(findByStatus / findByTags / store/inventory)整体 500——实测 2026-08-17 三者全挂;'
        + '(b) 该部署用 500 代替了 404,所以"这个 id 根本不存在"也长这样——'
        + '换一个已知存在的 id(如 1/5/10)能查通的话,就属于这一类。',
    };
  }
  if (!res.ok) {
    return { error: `${SERVICE} 返回 HTTP ${res.status}:${what} 被拒(${url})。服务端说明:${detail}` };
  }

  try {
    return { data: JSON.parse(body) };
  } catch {
    return { error: `${SERVICE} 响应不是合法 JSON(HTTP ${res.status},${what}),前 200 字符:${body.slice(0, 200)}` };
  }
}

/**
 * 把一条 pet 记录裁剪成 agent 用得上的字段。
 * photoUrls 实测会被写脏(见过单条记录塞几十个 /tmp/inflector*.tmp 的垃圾路径),
 * 所以只报数量 + 前 3 条样本,不整包透传。
 */
function trimPet(p) {
  const photos = Array.isArray(p?.photoUrls) ? p.photoUrls : [];
  return {
    id: p?.id,
    name: p?.name,
    status: p?.status,                       // 实测:部分记录缺这个字段
    category: p?.category?.name ?? undefined, // 实测:部分记录缺 category
    tags: Array.isArray(p?.tags) ? p.tags.map((t) => t?.name).filter(Boolean) : [],
    photoCount: photos.length,
    photoSample: photos.slice(0, 3),
  };
}

// zod 只把关类型,取值范围放在 handler 里查,越界时返回本零件统一的 { isError: true },
// 而不是 SDK 抛的 JSON-RPC 错误。
function normLimit(limit) {
  const n = limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    return { error: `参数错误:limit 必须是 1..${MAX_LIMIT} 之间的整数,收到 ${limit}` };
  }
  return { n };
}

server.registerTool('find-pets-by-status', {
  description:
    '按上架状态找宠物(Swagger Petstore)。status 只能是 available(可领养)/ pending(处理中)/ '
    + 'sold(已售出)三者之一。返回 { status, count, truncated, pets },每条含 id、name、status、'
    + 'category(品类名)、tags、photoCount —— 拿到 id 后可交给 get-pet 查详情。'
    + '结果条数默认最多 20 条(limit 可调 1..50):该端点一次会吐出全店同状态的宠物,不截断会淹掉上下文。'
    + '注意:这是公开可写的公共演示库,宠物数据随时被别人增删改,同样的查询两次结果不同是正常的。'
    + '实测 2026-08-17 该端点在服务端整体 500(有人写入脏数据所致),此时返回可行动的错误说明。',
  inputSchema: {
    status: z.string().describe('上架状态,必须是 "available" / "pending" / "sold" 之一'),
    limit: z.number().optional().describe(`最多返回几条,整数 1..${MAX_LIMIT},默认 ${DEFAULT_LIMIT}`),
  },
}, async ({ status, limit }) => {
  const s = String(status ?? '').trim().toLowerCase();
  if (!STATUSES.includes(s)) {
    return fail(`参数错误:status 必须是 ${STATUSES.join(' / ')} 之一,收到 "${status}"`);
  }
  const lim = normLimit(limit);
  if (lim.error) return fail(lim.error);

  const url = `${BASE_URL}/pet/findByStatus?${new URLSearchParams({ status: s })}`;
  const { data, error } = await getJson(url, `按状态 "${s}" 查宠物列表`);
  if (error) return fail(error);
  if (!Array.isArray(data)) {
    return fail(`${SERVICE} 响应结构异常:/pet/findByStatus 预期返回数组,实际是 ${typeof data}`);
  }

  const pets = data.slice(0, lim.n).map(trimPet);
  return ok({
    status: s,
    count: pets.length,
    totalReturnedByService: data.length,
    truncated: data.length > pets.length,
    pets,
    note: data.length > pets.length
      ? `服务端共返回 ${data.length} 条,已按 limit=${lim.n} 截断;需要更多请调大 limit(上限 ${MAX_LIMIT})`
      : undefined,
  });
});

server.registerTool('get-pet', {
  description:
    '按 id 取单只宠物的详情(Swagger Petstore)。返回 { found: true, pet } —— pet 含 id、name、'
    + 'status、category、tags、photoCount/photoSample。'
    + '宠物不存在时返回 { found: false } 这种**结构化结果(不是错误)**;'
    + 'petId 不是正整数才算参数错误,且不会发出请求。'
    + '注意:这是公开可写的公共演示库,别人随时可能删掉或改掉你要查的宠物——'
    + '不要硬编码 id,先用 find-pets-by-status 拿到真实存在的 id 再查。'
    + '另:实测该部署对"不存在的 id"回的是 500 而不是 404,且个别脏记录(如 id 2、id 6)本身就 500,'
    + '所以拿到 5xx 错误时先换个 id 试,多半不是你的参数问题。',
  inputSchema: {
    petId: z.number().describe('宠物 id,正整数,如 5(建议先用 find-pets-by-status 拿到真实 id)'),
  },
}, async ({ petId }) => {
  if (!Number.isInteger(petId) || petId <= 0) {
    return fail(`参数错误:petId 必须是正整数,收到 ${petId}`);
  }

  const url = `${BASE_URL}/pet/${encodeURIComponent(petId)}`;
  const { data, error, notFound } = await getJson(url, `查 id=${petId} 的宠物详情`);

  // 404 是正常业务结果(这只宠物不存在),不是故障 —— 走结构化"未找到"。
  if (notFound) {
    return ok({
      found: false,
      petId,
      hint: '这个 id 在店里不存在(可能从未存在,也可能已被别人删除)。'
        + '用 find-pets-by-status 拿一个当前真实存在的 id 再查。',
    });
  }
  if (error) return fail(error);
  if (!data || typeof data !== 'object' || data.id === undefined) {
    return fail(`${SERVICE} 响应结构异常:/pet/${petId} 返回体里没有 id 字段`);
  }

  return ok({ found: true, pet: trimPet(data) });
});

server.registerTool('get-inventory', {
  description:
    '取全店库存计数(Swagger Petstore)。返回 { statuses, totalCount } —— statuses 是'
    + '"上架状态 → 该状态下的宠物数量"的映射(如 { available: 12, pending: 3, sold: 7 }),'
    + 'totalCount 是各状态之和。用来回答"店里还有多少存货""可领养的还剩几只"这类总量问题,'
    + '不需要先把宠物列表拉下来自己数。无需参数。'
    + '注意:公共演示库的数据随时被别人改动,计数会变;实测 2026-08-17 该端点在服务端整体 500,'
    + '此时返回可行动的错误说明。',
  inputSchema: {},
}, async () => {
  const url = `${BASE_URL}/store/inventory`;
  const { data, error } = await getJson(url, '查全店各状态库存计数');
  if (error) return fail(error);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return fail(`${SERVICE} 响应结构异常:/store/inventory 预期返回"状态→数量"的对象,实际是 ${Array.isArray(data) ? 'array' : typeof data}`);
  }

  // 该端点返回的是自由格式的 map(键不限于三个标准状态,脏数据会带出奇怪的键),
  // 只保留数值型条目,避免把非数字塞给 agent 当计数用。
  const statuses = {};
  let totalCount = 0;
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      statuses[k] = v;
      totalCount += v;
    }
  }

  return ok({
    statuses,
    totalCount,
    statusCount: Object.keys(statuses).length,
    note: '键是服务端自由上报的状态名,除 available/pending/sold 外还可能出现别人写入的自定义状态',
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
