#!/usr/bin/env node
/**
 * MCP stdio server: Slack Web API(https://slack.com/api)消息与频道适配。
 * 能力点:向频道发消息、列出工作区公开频道、查询本零件的能力与凭证要求。
 *
 * **凭证(硬规范)**:bot token 只从**本进程的环境变量** SLACK_BOT_TOKEN 读,
 * 绝不硬编码、也**绝不接受工具参数传入**——让 token 当工具参数就等于让它流经
 * 模型上下文和会话日志。
 *
 * **零凭证降级**:没配 token 时零件照常启动、listTools 照常成功(接口先就位、key 后补),
 * 需要凭证的工具返回 { isError: true } 并说清缺哪个变量、它是干什么的、去哪儿取、怎么配;
 * 绝不崩溃、绝不静默假装成功、绝不返回假数据。免凭证的 slack-capabilities 任何时候都可用。
 *
 * **Slack 的错误形状**:HTTP 200 里也可能是失败 {ok: false, error: 'invalid_auth'},
 * 所以必须判 ok 字段——只看 HTTP 状态码会把失败当成功。
 *
 * 速率限制:Tier-based(建议 <1 req/s per method)。本零件所有请求串成一条队列、
 * 相邻请求至少隔 1100ms,不做并发扇出;遇 429 按 Retry-After 明确报错而非盲目重试。
 * 写操作:post-message 会真的把消息发出去,description 里已明确标注。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVICE = 'Slack Web API(slack.com/api)';
const BASE_URL = 'https://slack.com/api';
const USER_AGENT = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const TIMEOUT_MS = 15000;
const MIN_INTERVAL_MS = 1100; // Tier-based,工单建议 <1 req/s per method
const APPS_URL = 'https://api.slack.com/apps';
const DOCS_URL = 'https://api.slack.com/web';
const ERR_DOC = 'https://api.slack.com/methods/chat.postMessage#errors';

const server = new McpServer({ name: 'slack-messaging', version: '0.0.1' });

const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 兜底:relay 服务端文本前抹掉形似 token 的片段,防止密钥流进模型上下文。 */
const redact = (s) => String(s).replace(/\bxox[abeprs]-[A-Za-z0-9-]{8,}/g, '[REDACTED_SLACK_TOKEN]');

// ---- 凭证:只读本进程环境变量 ------------------------------------------------
const SECRETS = [
  {
    env: 'SLACK_BOT_TOKEN',
    purpose: 'Slack Bot User OAuth Token(xoxb- 开头,代表机器人在工作区里的身份与权限)',
    where: `Slack App 后台(${APPS_URL})→ 选中你的 App → 左侧「OAuth & Permissions」`
      + ' → 先在 Scopes 里加好所需 bot scope、点 Install to Workspace 授权,'
      + ' 页面顶部「Bot User OAuth Token」即是',
  },
];

/** 每次调用时现读:host 后补 token 后重启零件即可生效。 */
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
function missingSecretsMessage(missing, scopes) {
  const lines = missing.map((s) => `  - 缺 ${s.env}:${s.purpose}。获取:${s.where}`);
  return [
    `未配置凭证,${SERVICE}接口已就位但无法调用(接口先就位、key 后补是预期状态)。`,
    `缺少 ${missing.length} 个环境变量:`,
    ...lines,
    scopes?.length ? `本操作还需要这些 OAuth scope:${scopes.join('、')}(装 App 前先在 Scopes 里加上,漏加会返回 missing_scope)` : '',
    '配置方式:写进 host 进程环境(export SLACK_BOT_TOKEN=xoxb-...)或部署环境的 .env,'
    + '由 host 注入本零件子进程;配好后重启本零件生效。',
    '注意:本零件只从自己进程的环境变量读凭证,不接受把 token 当工具参数传入'
    + '——那会让密钥流经模型上下文与会话日志。',
    '免凭证的 slack-capabilities 工具此刻就能用,可先查清每个操作需要哪些 scope。',
  ].filter(Boolean).join('\n');
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

/** Slack 常见 error 码 → 可行动的中文说明。未收录的码原样回传 + 文档链接。 */
const ERROR_HINTS = {
  invalid_auth: 'SLACK_BOT_TOKEN 无效(拼错、被撤销,或不是这个工作区的 token)——去 OAuth & Permissions 重装 App 取新 token',
  not_authed: '请求没带上 token——检查 SLACK_BOT_TOKEN 是否真的注入到了本零件进程',
  account_inactive: 'token 对应的账号/App 已被停用或从工作区移除',
  token_revoked: 'token 已被撤销,需要重新安装 App 取新 token',
  token_expired: 'token 已过期,需要重新安装 App 取新 token',
  missing_scope: 'token 缺少本操作需要的 OAuth scope——去 OAuth & Permissions 补上 scope 后**必须重装 App**,老 token 不会自动获得新权限',
  channel_not_found: 'channel 不存在或机器人看不到它——公开频道用 #name 或 C 开头的 channel id;私有频道必须先把机器人邀请进去',
  not_in_channel: '机器人不在该频道里——在频道里 /invite @你的机器人 后重试',
  is_archived: '该频道已归档,不能再发消息',
  msg_too_long: '消息正文超过 Slack 上限(约 40000 字符),请拆分后再发',
  no_text: '消息正文为空,Slack 拒绝空消息',
  ratelimited: '触发了 Slack 的限速——本零件已按 1 req/s 串行节流,若仍出现说明同一 token 上有其它调用方',
  restricted_action: '工作区策略禁止该操作(管理员限制)',
};

/**
 * 单次请求(已过节流闸)。超时/网络失败/非 2xx/JSON 解析失败/Slack 业务失败(ok:false)
 * 一律转成 { error: 说明文本 },绝不抛裸异常。token 只出现在请求头里,不写进任何返回文本。
 */
async function callSlack(method, { httpMethod = 'GET', query, body, token } = {}) {
  const url = `${BASE_URL}/${method}${query ? `?${new URLSearchParams(query)}` : ''}`;
  return throttled(async () => {
    let res;
    try {
      res = await fetch(url, {
        method: httpMethod,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const name = e?.name ?? '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { error: `${SERVICE} 请求超时:${TIMEOUT_MS}ms 内未返回(${method})` };
      }
      return { error: `${SERVICE} 网络请求失败(${method}):${e?.message ?? String(e)}` };
    }

    let raw;
    try {
      raw = await res.text();
    } catch (e) {
      return { error: `${SERVICE} 读取响应体失败(${method}):${e?.message ?? String(e)}` };
    }
    const snippet = redact(raw).slice(0, 300);

    if (res.status === 429) {
      const retry = res.headers.get('retry-after');
      return { error: `${SERVICE} 触发限速(HTTP 429,${method}):${retry ? `${retry} 秒后可重试` : '请稍后重试'}。本零件已按 1 req/s 串行节流,若仍出现说明同一 token 上有其它调用方` };
    }
    if (!res.ok) {
      return { error: `${SERVICE} 返回 HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}(${method}):${snippet}` };
    }

    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      return { error: `${SERVICE} 响应不是合法 JSON(HTTP ${res.status},${method}):${snippet}` };
    }

    // 关键:Slack HTTP 200 也可能是 {ok:false},必须判 ok 字段。
    if (json?.ok !== true) {
      const code = json?.error ?? '未知';
      const hint = ERROR_HINTS[code];
      const scopeDetail = json?.needed ? `(需要 scope:${json.needed};当前 token 有:${json.provided ?? '未知'})` : '';
      return {
        error: `${SERVICE} 调用失败(HTTP ${res.status} 但 ok:false,${method}):error=${code}${scopeDetail}`
          + `${hint ? `\n${hint}` : `\n该错误码的含义见 ${ERR_DOC}`}`,
        code,
      };
    }
    return { data: json };
  });
}

// ---- 能力表(免凭证工具与 capabilities 共用同一份事实)------------------------
const OPERATIONS = [
  {
    tool: 'post-message',
    endpoint: 'POST /chat.postMessage',
    write: true,
    requiresCredentials: ['SLACK_BOT_TOKEN'],
    scopes: ['chat:write'],
    notes: '写操作:调用会真的把消息发到 Slack 频道,成员立刻看到。'
      + '机器人必须已在目标频道里(公开频道用 /invite @bot),否则返回 not_in_channel。',
  },
  {
    tool: 'list-channels',
    endpoint: 'GET /conversations.list?types=public_channel',
    write: false,
    requiresCredentials: ['SLACK_BOT_TOKEN'],
    scopes: ['channels:read'],
    notes: '只列公开频道;要列私有频道需另加 groups:read 并把机器人拉进去。返回的 channel id 可直接喂给 post-message。',
  },
  {
    tool: 'slack-capabilities',
    endpoint: '(本地,不发请求)',
    write: false,
    requiresCredentials: [],
    scopes: [],
    notes: '免凭证:零凭证状态下也能用,用来查清每个操作要什么 scope、token 去哪拿。',
  },
];

/** 参数校验在前、凭证检查在后:两条错误路径在零凭证环境下互不遮蔽。 */
function requireToken(scopes) {
  const { values, missing } = readCredentials();
  if (missing.length > 0) return { error: missingSecretsMessage(missing, scopes) };
  return { token: values.SLACK_BOT_TOKEN };
}

// ---- 工具 1:post-message(写操作)------------------------------------------
server.registerTool('post-message', {
  description:
    '【写操作,会真的发出消息】以机器人身份向 Slack 频道发送一条消息(POST /chat.postMessage)。'
    + 'channel 填频道 id(C 开头,来自 list-channels)或 #频道名;text 是消息正文(支持 Slack mrkdwn)。'
    + '调用成功即消息已出现在频道里、工作区成员立刻可见,所以只在用户明确要求发消息时调用。'
    + '传 threadTs 可以回到某条消息的话题串里。返回 channel / ts(消息时间戳,可用作后续 threadTs)。'
    + '需要 SLACK_BOT_TOKEN 环境变量与 chat:write scope;未配凭证时返回可行动的错误,不会静默失败。',
  inputSchema: {
    channel: z.string().describe('目标频道:频道 id(如 C0123456789)或 #频道名;机器人必须已在该频道内'),
    text: z.string().describe('消息正文(纯文本或 Slack mrkdwn)'),
    threadTs: z.string().optional().describe('可选:回复到某条消息的话题串,填那条消息的 ts'),
  },
}, async ({ channel, text, threadTs }) => {
  // 参数校验在前,凭证检查在后。
  const ch = String(channel ?? '').trim();
  if (ch === '') return fail('参数错误:channel 不能为空(填频道 id 如 C0123456789,或 #频道名)');
  if (/\s/.test(ch)) return fail(`参数错误:channel 不能含空白字符,收到 ${JSON.stringify(ch)}——频道 id 形如 C0123456789,频道名形如 #general`);
  const content = String(text ?? '');
  if (content.trim() === '') return fail('参数错误:text 不能为空——Slack 拒绝空消息(no_text)');

  const { token, error: credError } = requireToken(['chat:write']);
  if (credError) return fail(credError);

  const body = { channel: ch, text: content };
  if (threadTs) body.thread_ts = String(threadTs);
  const { data, error } = await callSlack('chat.postMessage', { httpMethod: 'POST', body, token });
  if (error) return fail(error);

  return ok({
    sent: true,
    channel: data?.channel,
    ts: data?.ts,
    threadTs: data?.message?.thread_ts,
    botId: data?.message?.bot_id,
    textEcho: (data?.message?.text ?? content).slice(0, 200),
    note: '消息已真实发出;ts 可作为 threadTs 用来在这条消息下继续回复。',
  });
});

// ---- 工具 2:list-channels ---------------------------------------------------
server.registerTool('list-channels', {
  description:
    '列出 Slack 工作区的公开频道(GET /conversations.list?types=public_channel)。'
    + '返回每个频道的 id、名称、是否归档、成员数、topic/purpose 摘要,'
    + '拿到的 id 可直接交给 post-message。结果按 Slack 返回顺序,支持 cursor 翻页。'
    + '一个频道都没有时返回 { count: 0, channels: [] } 这种结构化结果(不是错误)。'
    + '需要 SLACK_BOT_TOKEN 与 channels:read scope;未配凭证时返回可行动错误。',
  inputSchema: {
    limit: z.number().optional().describe('每页条数,整数 1..200,默认 50'),
    cursor: z.string().optional().describe('翻页游标:上一次返回的 nextCursor,首次不填'),
    excludeArchived: z.boolean().optional().describe('是否排除已归档频道,默认 true'),
  },
}, async ({ limit, cursor, excludeArchived }) => {
  const n = limit ?? 50;
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    return fail(`参数错误:limit 必须是 1..200 之间的整数,收到 ${limit}`);
  }

  const { token, error: credError } = requireToken(['channels:read']);
  if (credError) return fail(credError);

  const query = {
    types: 'public_channel',
    limit: String(n),
    exclude_archived: String(excludeArchived !== false),
  };
  if (cursor) query.cursor = String(cursor);
  const { data, error } = await callSlack('conversations.list', { query, token });
  if (error) return fail(error);

  const items = Array.isArray(data?.channels) ? data.channels : [];
  return ok({
    count: items.length,
    nextCursor: data?.response_metadata?.next_cursor || undefined,
    channels: items.map((c) => ({
      id: c.id,
      name: c.name,
      isArchived: c.is_archived === true,
      isMember: c.is_member === true,
      memberCount: c.num_members,
      topic: c.topic?.value ? String(c.topic.value).slice(0, 200) : undefined,
      purpose: c.purpose?.value ? String(c.purpose.value).slice(0, 200) : undefined,
    })),
    hint: items.length === 0
      ? '没列到公开频道——确认 token 的 channels:read scope 已授权,且工作区里确实有公开频道'
      : '要往某个频道发消息,机器人得先在里面:在该频道 /invite @你的机器人',
  });
});

// ---- 工具 3:slack-capabilities(免凭证)-------------------------------------
server.registerTool('slack-capabilities', {
  description:
    '【免凭证】列出本零件支持的 Slack 操作、每个操作需要的 OAuth scope(chat:write / channels:read 等)'
    + '与环境变量,并报告 token 当前是否已配置(只报"配没配",绝不回显取值)。'
    + '零凭证状态下也能正常调用——用它先搞清要开哪些 scope、token 在后台哪儿取、怎么注入。',
  inputSchema: {},
}, async () => {
  const { missing } = readCredentials();
  const missingEnvs = new Set(missing.map((s) => s.env));
  return ok({
    part: 'slack-messaging',
    service: SERVICE,
    baseUrl: BASE_URL,
    auth: '每次请求带 Authorization: Bearer ${SLACK_BOT_TOKEN}(bot token 长期有效,不需要换取步骤)',
    credentialsConfigured: missingEnvs.size === 0,
    // 只报布尔"是否已配",不返回任何取值——凭证不进模型上下文。
    credentials: SECRETS.map((s) => ({
      env: s.env,
      configured: !missingEnvs.has(s.env),
      purpose: s.purpose,
      where: s.where,
    })),
    operations: OPERATIONS,
    requiredScopes: ['chat:write(发消息)', 'channels:read(列公开频道)'],
    optionalScopes: ['groups:read(要列私有频道时加)', 'chat:write.customize(要自定义机器人显示名/头像时加)'],
    setup: [
      `1. 到 ${APPS_URL} 创建/选中一个 Slack App(From scratch 即可),选定目标工作区`,
      '2. 「OAuth & Permissions」→ Bot Token Scopes 里加上 chat:write 与 channels:read',
      '3. 点 Install to Workspace 授权,复制页面顶部的「Bot User OAuth Token」(xoxb- 开头)',
      '4. 把 SLACK_BOT_TOKEN 注入 host 进程环境或部署 .env(不要写进代码、不要当工具参数传)',
      '5. 重启本零件;再调 slack-capabilities 应看到 credentialsConfigured: true',
      '6. 在要发消息的频道里 /invite @你的机器人,否则 post-message 会返回 not_in_channel',
      '注意:补加 scope 之后必须重新安装 App,老 token 不会自动获得新权限(否则报 missing_scope)',
    ],
    rateLimit: 'Tier-based,建议 <1 req/s per method;本零件所有请求串行排队(间隔 ≥1.1s),不做并发扇出',
    errorShape: `Slack HTTP 200 里也可能是失败 {ok:false, error:'invalid_auth'},本零件把 ok !== true 一律当错误。错误码见 ${ERR_DOC}`,
    knownErrorCodes: Object.keys(ERROR_HINTS),
    docs: DOCS_URL,
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
