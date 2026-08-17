#!/usr/bin/env node
/**
 * MCP stdio server: 飞书开放平台(https://open.feishu.cn/open-apis)消息与群组适配。
 * 能力点:向指定用户/群发文本消息、列出机器人所在的群、查询本零件的能力与凭证要求。
 *
 * **凭证(硬规范)**:app_id / app_secret 只从**本进程的环境变量**读
 * (FEISHU_APP_ID / FEISHU_APP_SECRET),绝不硬编码、也**绝不接受工具参数传入**——
 * 让密钥当工具参数就等于让它流经模型上下文和会话日志。
 *
 * **零凭证降级**:没配凭证时零件照常启动、listTools 照常成功(接口先就位、key 后补),
 * 需要凭证的工具返回 { isError: true } 并说清缺哪个变量、它是干什么的、去哪儿取、怎么配;
 * 绝不崩溃、绝不静默假装成功、绝不返回假数据。免凭证的 feishu-capabilities 任何时候都可用。
 *
 * **认证流程**:app_id + app_secret → POST /auth/v3/tenant_access_token/internal 换
 * tenant_access_token(有效期约 2h),之后请求带 Authorization: Bearer <token>。
 * token 在进程内内存缓存,提前 5 分钟过期以避开边界失效;不落盘。
 *
 * **飞书的错误形状**:HTTP 200 里也可能是业务错误 {code: 99991663, msg: '...'},
 * 所以 code !== 0 一律按错误处理——只看 HTTP 状态码会把失败当成功。
 *
 * 速率限制:按应用配额(建议 <20 req/s)。本零件所有请求串成一条队列,不做并发扇出。
 * 写操作:send-message 会真的把消息发出去(不可撤回),description 里已明确标注。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVICE = '飞书开放平台(open.feishu.cn)';
const BASE_URL = 'https://open.feishu.cn/open-apis';
const USER_AGENT = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const TIMEOUT_MS = 15000;
const MIN_INTERVAL_MS = 60; // 应用配额建议 <20 req/s,留余量
const TOKEN_SKEW_MS = 5 * 60 * 1000; // 提前 5 分钟刷新
const CONSOLE_URL = 'https://open.feishu.cn/app';
const DOCS_URL = 'https://open.feishu.cn/document/';
const ERR_CODE_DOC = 'https://open.feishu.cn/document/server-docs/getting-started/server-error-codes';

const server = new McpServer({ name: 'feishu-messaging', version: '0.0.1' });

const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 兜底:relay 服务端文本前抹掉形似凭证的片段,防止密钥/令牌流进模型上下文。 */
const redact = (s) => String(s)
  .replace(/\b[tu]-[A-Za-z0-9_-]{16,}/g, '[REDACTED_TOKEN]')
  .replace(/\bcli_[A-Za-z0-9]{8,}/g, '[REDACTED_APP_ID]');

// ---- 凭证:只读本进程环境变量 ------------------------------------------------
const SECRETS = [
  {
    env: 'FEISHU_APP_ID',
    purpose: '飞书自建应用 App ID(形如 cli_xxxxxxxx,标识是哪个应用在调用)',
    where: `开放平台后台(${CONSOLE_URL})→ 选中你的自建应用 → 左侧「凭证与基础信息」→ App ID`,
  },
  {
    env: 'FEISHU_APP_SECRET',
    purpose: '飞书自建应用 App Secret(应用身份口令,用来换取 tenant_access_token)',
    where: `同一页面「凭证与基础信息」→ App Secret,点「查看」后复制(泄露需立即在该页重置)`,
  },
];

/** 每次调用时现读环境变量:host 后补 key 后重启零件即可生效,不缓存缺失状态。 */
function readCredentials() {
  const values = {};
  const missing = [];
  for (const s of SECRETS) {
    const v = (process.env[s.env] ?? '').trim();
    if (v === '') missing.push(s);
    else values[s.env] = v;
  }
  return { values, missing };
}

/** 缺凭证时的可行动错误文本:缺哪个、是什么、去哪取、怎么配。 */
function missingSecretsMessage(missing) {
  const lines = missing.map((s) => `  - 缺 ${s.env}:${s.purpose}。获取:${s.where}`);
  return [
    `未配置凭证,${SERVICE}接口已就位但无法调用(接口先就位、key 后补是预期状态)。`,
    `缺少 ${missing.length} 个环境变量:`,
    ...lines,
    '配置方式:写进 host 进程环境(export FEISHU_APP_ID=... / export FEISHU_APP_SECRET=...)'
    + '或部署环境的 .env,由 host 注入本零件子进程;配好后重启本零件生效。',
    '注意:本零件只从自己进程的环境变量读凭证,不接受把 app_id/app_secret 当工具参数传入'
    + '——那会让密钥流经模型上下文与会话日志。',
    '免凭证的 feishu-capabilities 工具此刻就能用,可先查清每个操作需要开通哪些权限。',
  ].join('\n');
}

// ---- 节流闸:串行队列,不并发扇出 --------------------------------------------
let lastRequestAt = 0;
let queue = Promise.resolve();

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
 * 单次请求(已过节流闸)。超时/网络失败/非 2xx/JSON 解析失败/飞书业务错误(code !== 0)
 * 一律转成 { error: 说明文本 },绝不抛裸异常。`quiet` 用于换 token 那一跳:
 * 该响应体里含 tenant_access_token,不能把原始 body 抄进错误文本。
 */
async function callFeishu(path, { method = 'GET', query, body, token, quiet = false } = {}) {
  const url = `${BASE_URL}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  return throttled(async () => {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          'Content-Type': 'application/json; charset=utf-8',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const name = e?.name ?? '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { error: `${SERVICE} 请求超时:${TIMEOUT_MS}ms 内未返回(${method} ${path})` };
      }
      return { error: `${SERVICE} 网络请求失败(${method} ${path}):${e?.message ?? String(e)}` };
    }

    let raw;
    try {
      raw = await res.text();
    } catch (e) {
      return { error: `${SERVICE} 读取响应体失败(${method} ${path}):${e?.message ?? String(e)}` };
    }
    const snippet = quiet ? '[响应体含令牌,已隐去]' : redact(raw).slice(0, 300);

    if (!res.ok) {
      return { error: `${SERVICE} 返回 HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}(${method} ${path}):${snippet}` };
    }

    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      return { error: `${SERVICE} 响应不是合法 JSON(HTTP ${res.status},${method} ${path}):${snippet}` };
    }

    // 关键:飞书 HTTP 200 也可能是业务错误,必须判 code。
    if (json?.code !== 0) {
      return {
        error: `${SERVICE} 业务错误(HTTP ${res.status} 但 code=${json?.code}):${redact(json?.msg ?? '无 msg')}`
          + `(${method} ${path};错误码含义见 ${ERR_CODE_DOC})`,
        code: json?.code,
      };
    }
    return { data: json.data ?? {} };
  });
}

// ---- tenant_access_token:内存缓存 + 提前 5 分钟刷新 --------------------------
let tokenCache = { appId: null, token: null, expiresAt: 0 };

async function getTenantAccessToken(appId, appSecret) {
  if (tokenCache.token && tokenCache.appId === appId && Date.now() < tokenCache.expiresAt) {
    return { token: tokenCache.token, cached: true };
  }
  const { data, error, code } = await callFeishu('/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    body: { app_id: appId, app_secret: appSecret },
    quiet: true,
  });
  if (error) {
    // 这一跳失败几乎只有一个原因:FEISHU_APP_ID / FEISHU_APP_SECRET 对不上。
    return {
      error: `${error}\n换取 tenant_access_token 失败。最常见原因:FEISHU_APP_ID 与 FEISHU_APP_SECRET 不匹配、`
        + `已在后台重置过 Secret、或应用未发布。请到「凭证与基础信息」页(${CONSOLE_URL})核对后重新注入环境变量并重启本零件。`
        + (code === undefined ? '' : `(服务端 code=${code})`),
    };
  }
  // 换 token 的响应把 token 平铺在顶层(与其它接口的 data 包装不同),这里两种形状都兜住。
  const token = data?.tenant_access_token ?? data?.token;
  const expire = Number(data?.expire);
  if (typeof token !== 'string' || token === '') {
    return { error: `${SERVICE} 换取 tenant_access_token 成功(code=0)但响应里没有 tenant_access_token 字段,响应结构可能已变更` };
  }
  const ttlMs = Number.isFinite(expire) && expire > 0 ? expire * 1000 : 2 * 60 * 60 * 1000;
  tokenCache = { appId, token, expiresAt: Date.now() + Math.max(ttlMs - TOKEN_SKEW_MS, 30_000) };
  return { token, cached: false };
}

/**
 * 需凭证工具的统一入口:先做参数校验(调用方在这之前完成),再取凭证、换 token。
 * 注意顺序——参数校验放在凭证检查之前,这样"参数非法"和"没配凭证"两条路径
 * 在零凭证环境下都能各自被观察到,不会互相遮蔽。
 */
async function withToken() {
  const { values, missing } = readCredentials();
  if (missing.length > 0) return { error: missingSecretsMessage(missing) };
  return getTenantAccessToken(values.FEISHU_APP_ID, values.FEISHU_APP_SECRET);
}

// ---- 能力表(免凭证工具与 capabilities 共用同一份事实)------------------------
const OPERATIONS = [
  {
    tool: 'send-message',
    endpoint: 'POST /im/v1/messages?receive_id_type=...',
    write: true,
    requiresCredentials: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'],
    scopes: ['im:message:send_as_bot(以机器人身份发消息)'],
    notes: '写操作:调用会真的把消息发到飞书,收件人立刻看到,发出后不可撤回。'
      + '机器人还必须已被加进目标群(chat_id),或与目标用户(open_id)可达。',
  },
  {
    tool: 'list-chats',
    endpoint: 'GET /im/v1/chats',
    write: false,
    requiresCredentials: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'],
    scopes: ['im:chat:readonly(获取群信息)或 im:chat'],
    notes: '只列出**本机器人已加入**的群;机器人没进群就是空列表,不是错误。',
  },
  {
    tool: 'feishu-capabilities',
    endpoint: '(本地,不发请求)',
    write: false,
    requiresCredentials: [],
    scopes: [],
    notes: '免凭证:零凭证状态下也能用,用来查清每个操作要什么权限、凭证去哪拿。',
  },
];

// ---- 工具 1:send-message(写操作)------------------------------------------
server.registerTool('send-message', {
  description:
    '【写操作,会真的发出消息】以机器人身份向飞书用户或群发送一条文本消息'
    + '(POST /im/v1/messages)。receiveId 填目标的 open_id(形如 ou_xxx)或群的 chat_id(形如 oc_xxx),'
    + 'receiveIdType 说明填的是哪一种。调用成功即消息已送达对方会话、无法撤回,'
    + '所以只在用户明确要求发消息时调用。返回 messageId / chatId / 发送时间。'
    + '需要 FEISHU_APP_ID + FEISHU_APP_SECRET 环境变量与 im:message:send_as_bot 权限;'
    + '未配凭证时返回可行动的错误(说明缺哪个变量、去哪取),不会静默失败。',
  inputSchema: {
    receiveId: z.string().describe('接收方 id:open_id(ou_ 开头,发给个人)或 chat_id(oc_ 开头,发到群)'),
    text: z.string().describe('消息正文(纯文本,会被包成飞书的 text 消息体)'),
    receiveIdType: z.enum(['open_id', 'chat_id', 'user_id', 'union_id', 'email']).optional()
      .describe('receiveId 的类型,默认 open_id;发群消息必须显式传 chat_id'),
  },
}, async ({ receiveId, text, receiveIdType }) => {
  // 参数校验在前,凭证检查在后:两条错误路径互不遮蔽。
  const id = String(receiveId ?? '').trim();
  if (id === '') return fail('参数错误:receiveId 不能为空(填 open_id ou_xxx 或群 chat_id oc_xxx)');
  const content = String(text ?? '');
  if (content.trim() === '') return fail('参数错误:text 不能为空——飞书不接受空消息体');
  const idType = receiveIdType ?? 'open_id';

  const { token, error } = await withToken();
  if (error) return fail(error);

  const { data, error: sendError } = await callFeishu('/im/v1/messages', {
    method: 'POST',
    query: { receive_id_type: idType },
    body: { receive_id: id, msg_type: 'text', content: JSON.stringify({ text: content }) },
    token,
  });
  if (sendError) {
    return fail(`${sendError}\n发送失败的常见原因:机器人未加入目标群 / 未开通 im:message:send_as_bot 权限 / `
      + `receiveIdType(${idType})与 receiveId 的实际类型对不上(群要用 chat_id)。`);
  }

  return ok({
    sent: true,
    messageId: data?.message_id,
    chatId: data?.chat_id,
    receiveIdType: idType,
    msgType: data?.msg_type ?? 'text',
    createTime: data?.create_time,
    note: '消息已真实发出,无法通过本零件撤回。',
  });
});

// ---- 工具 2:list-chats ------------------------------------------------------
server.registerTool('list-chats', {
  description:
    '列出**本机器人已加入**的飞书群(GET /im/v1/chats)。返回每个群的 chatId、名称、描述、'
    + '群主 ownerId、群模式与是否外部群,可直接拿 chatId 去 send-message 发群消息。'
    + '机器人没被拉进任何群时返回 { count: 0, chats: [] } 这种结构化结果(不是错误)。'
    + '需要 FEISHU_APP_ID + FEISHU_APP_SECRET 与 im:chat:readonly 权限;未配凭证时返回可行动错误。',
  inputSchema: {
    pageSize: z.number().optional().describe('每页条数,整数 1..100,默认 20'),
    pageToken: z.string().optional().describe('翻页游标:上一次返回的 nextPageToken,首次不填'),
  },
}, async ({ pageSize, pageToken }) => {
  const n = pageSize ?? 20;
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    return fail(`参数错误:pageSize 必须是 1..100 之间的整数,收到 ${pageSize}`);
  }

  const { token, error } = await withToken();
  if (error) return fail(error);

  const query = { page_size: String(n) };
  if (pageToken) query.page_token = String(pageToken);
  const { data, error: listError } = await callFeishu('/im/v1/chats', { query, token });
  if (listError) {
    return fail(`${listError}\n列群失败的常见原因:未开通 im:chat:readonly(或 im:chat)权限、应用未发布生效。`);
  }

  const items = Array.isArray(data?.items) ? data.items : [];
  return ok({
    count: items.length,
    hasMore: data?.has_more === true,
    nextPageToken: data?.page_token || undefined,
    chats: items.map((c) => ({
      chatId: c.chat_id,
      name: c.name,
      description: c.description || undefined,
      ownerId: c.owner_id || undefined,
      ownerIdType: c.owner_id_type || undefined,
      chatMode: c.chat_mode,
      chatType: c.chat_type,
      external: c.external === true,
    })),
    hint: items.length === 0
      ? '机器人当前没加入任何群——把机器人拉进群后再试,或改用 open_id 直接发给个人'
      : undefined,
  });
});

// ---- 工具 3:feishu-capabilities(免凭证)------------------------------------
server.registerTool('feishu-capabilities', {
  description:
    '【免凭证】列出本零件支持的飞书操作、每个操作需要的权限范围与环境变量,'
    + '并报告各凭证当前是否已配置(只报"配没配",绝不回显取值)。'
    + '零凭证状态下也能正常调用——用它先搞清要去开放平台开哪些权限、凭证在后台哪儿取、怎么注入。',
  inputSchema: {},
}, async () => {
  const { missing } = readCredentials();
  const missingEnvs = new Set(missing.map((s) => s.env));
  return ok({
    part: 'feishu-messaging',
    service: SERVICE,
    baseUrl: BASE_URL,
    auth: 'app_id + app_secret → POST /auth/v3/tenant_access_token/internal 换 tenant_access_token'
      + '(有效期约 2 小时,本零件内存缓存并提前 5 分钟刷新),后续请求带 Authorization: Bearer <token>',
    credentialsConfigured: missingEnvs.size === 0,
    // 只报布尔"是否已配",不返回任何取值——凭证不进模型上下文。
    credentials: SECRETS.map((s) => ({
      env: s.env,
      configured: !missingEnvs.has(s.env),
      purpose: s.purpose,
      where: s.where,
    })),
    operations: OPERATIONS,
    setup: [
      `1. 到开放平台(${CONSOLE_URL})创建/选中一个自建应用`,
      '2. 「凭证与基础信息」页复制 App ID 与 App Secret',
      '3. 「权限管理」里申请上面 operations 列出的权限(im:message:send_as_bot / im:chat:readonly),并发布应用版本使其生效',
      '4. 把 FEISHU_APP_ID / FEISHU_APP_SECRET 注入 host 进程环境或部署 .env(不要写进代码、不要当工具参数传)',
      '5. 重启本零件;再调 feishu-capabilities 应看到 credentialsConfigured: true',
      '6. 发群消息前先把机器人拉进目标群,再用 list-chats 拿 chatId',
    ],
    rateLimit: '按应用配额,建议 <20 req/s;本零件所有请求串行排队,不做并发扇出',
    errorShape: `飞书 HTTP 200 里也可能是业务错误 {code: 非 0, msg},本零件把 code !== 0 一律当错误。错误码见 ${ERR_CODE_DOC}`,
    docs: DOCS_URL,
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
