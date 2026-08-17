#!/usr/bin/env node
/**
 * MCP stdio server: GitHub REST API(https://api.github.com)issue 适配。
 * 能力点:列 issue、看单条 issue 详情、建 issue、查询本零件的能力与凭证要求。
 *
 * **凭证(硬规范)**:token 只从**本进程的环境变量** GITHUB_TOKEN 读,
 * 绝不硬编码、也**绝不接受工具参数传入**——让 token 当工具参数就等于让它流经
 * 模型上下文和会话日志。
 *
 * **零凭证降级(本零件分两档,因为 GitHub 的读写门槛不同)**:
 *   - 读操作(list-issues / get-issue):GitHub 公开仓库**未认证也能读**,所以没 token 时
 *     **降级为匿名调用**并在返回里注明 mode:'anonymous' 与限额差异(匿名 60 req/h,
 *     认证 5000 req/h)。这比硬报错有用——零凭证状态下零件仍有真实可用的表面。
 *     只有当匿名确实够不着(私有仓库 → 404)时才报错,并指出配 token 可解。
 *   - 写操作(create-issue):GitHub 强制要求认证,没 token 时返回 { isError: true } 并说清
 *     缺哪个变量、它是干什么的、去哪儿取、怎么配;绝不崩溃、绝不静默假装成功、绝不返回假数据。
 *   - 任何情况下 listTools 都照常成功(接口先就位、key 后补),免凭证的
 *     github-capabilities 任何时候都可用。
 *
 * 速率限制:认证 5000 req/h、匿名 60 req/h(按 IP 共享)。所有请求串成一条队列,
 * 不做并发扇出;每次返回都带上服务端报的剩余额度,方便调用方自己收着点。
 * 写操作:create-issue 会在**真实仓库**里建出一条真实 issue,description 里已明确标注。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVICE = 'GitHub REST API(api.github.com)';
const BASE_URL = 'https://api.github.com';
const USER_AGENT = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const API_VERSION = '2022-11-28';
const TIMEOUT_MS = 15000;
const MIN_INTERVAL_MS = 250; // 认证 5000 req/h ≈ 1.4 req/s,留足余量
const MAX_BODY_CHARS = 4000;
const TOKEN_URL = 'https://github.com/settings/tokens';
const DOCS_URL = 'https://docs.github.com/en/rest/issues';

const server = new McpServer({ name: 'github-issues', version: '0.0.1' });

const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 兜底:relay 服务端文本前抹掉形似 token 的片段,防止密钥流进模型上下文。 */
const redact = (s) => String(s)
  .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[REDACTED_GITHUB_TOKEN]')
  .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]');

// ---- 凭证:只读本进程环境变量 ------------------------------------------------
const SECRETS = [
  {
    env: 'GITHUB_TOKEN',
    purpose: 'GitHub Personal Access Token(代表你的账号身份与仓库权限;'
      + '读公开仓库可不配——那时走匿名模式、限额 60 req/h,写 issue 则必须配)',
    where: `GitHub → Settings → Developer settings → Personal access tokens(${TOKEN_URL})`
      + ' → 生成 fine-grained token(选中目标仓库,给 Issues: Read and write)'
      + ' 或 classic token(勾 repo;只读公开仓库勾 public_repo 即可);生成后只显示一次,当场复制',
  },
];

/** 每次调用时现读:host 后补 token 后重启零件即可生效。 */
function readToken() {
  const v = (process.env.GITHUB_TOKEN ?? '').trim();
  return v === '' ? null : v;
}

/** 缺凭证时的可行动错误文本:缺哪个、是什么、去哪取、怎么配。 */
function missingTokenMessage(operation, scopes) {
  const s = SECRETS[0];
  return [
    `未配置凭证,${SERVICE}的${operation}无法执行——GitHub 的写操作强制要求认证,匿名调用一定被拒(接口先就位、key 后补是预期状态)。`,
    '缺少 1 个环境变量:',
    `  - 缺 ${s.env}:${s.purpose}。获取:${s.where}`,
    scopes?.length ? `本操作需要的 token 权限:${scopes.join('、')}` : '',
    '配置方式:写进 host 进程环境(export GITHUB_TOKEN=ghp_... 或 github_pat_...)或部署环境的 .env,'
    + '由 host 注入本零件子进程;配好后重启本零件生效。',
    '注意:本零件只从自己进程的环境变量读凭证,不接受把 token 当工具参数传入'
    + '——那会让密钥流经模型上下文与会话日志。',
    '提示:读操作(list-issues / get-issue)不需要 token,现在就能以匿名模式查公开仓库;'
    + '免凭证的 github-capabilities 也随时可用。',
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

/**
 * 单次请求(已过节流闸)。超时/网络失败/非 2xx/JSON 解析失败一律转成
 * { error: 说明文本 },绝不抛裸异常。token 只出现在请求头里,不写进任何返回文本。
 */
async function callGitHub(path, { method = 'GET', query, body, token } = {}) {
  const url = `${BASE_URL}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  return throttled(async () => {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
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

    const rateLimit = {
      limit: res.headers.get('x-ratelimit-limit') ?? undefined,
      remaining: res.headers.get('x-ratelimit-remaining') ?? undefined,
      resetAt: res.headers.get('x-ratelimit-reset')
        ? new Date(Number(res.headers.get('x-ratelimit-reset')) * 1000).toISOString()
        : undefined,
    };

    let raw;
    try {
      raw = await res.text();
    } catch (e) {
      return { error: `${SERVICE} 读取响应体失败(${method} ${path}):${e?.message ?? String(e)}` };
    }

    let json;
    try {
      json = raw === '' ? null : JSON.parse(raw);
    } catch {
      if (res.ok) {
        return { error: `${SERVICE} 响应不是合法 JSON(HTTP ${res.status},${method} ${path}):${redact(raw).slice(0, 200)}` };
      }
      json = null;
    }

    if (!res.ok) {
      const msg = redact(json?.message ?? raw).slice(0, 300);
      return { error: `${SERVICE} 返回 HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}(${method} ${path}):${msg}`, status: res.status, rateLimit, details: json };
    }
    return { data: json, rateLimit };
  });
}

/** 把 GitHub 的失败按状态码翻成可行动说明——匿名模式下额外指出"配 token 可解"。 */
function explain(error, status, rateLimit, authenticated, details) {
  const mode = authenticated ? '认证模式' : '匿名模式(未配置 GITHUB_TOKEN)';
  const tail = [];
  if (status === 401) {
    tail.push('GITHUB_TOKEN 无效或已过期(拼错、被撤销、或已过有效期)'
      + `——到 ${TOKEN_URL} 重新生成一个,再注入环境变量并重启本零件。`);
  } else if (status === 403 && rateLimit?.remaining === '0') {
    tail.push(`触发速率限制:${mode}额度已用尽(limit=${rateLimit.limit ?? '?'},重置时间 ${rateLimit.resetAt ?? '未知'})。`
      + (authenticated ? '认证额度是 5000 req/h,等重置即可。' : '匿名额度只有 60 req/h 且按 IP 共享;配置 GITHUB_TOKEN 可提到 5000 req/h。'));
  } else if (status === 403) {
    tail.push(authenticated
      ? 'token 权限不足或该仓库禁止此操作(fine-grained token 需勾选目标仓库的 Issues: Read and write)。'
      : '匿名调用没有权限做这件事——配置 GITHUB_TOKEN 后重试。');
  } else if (status === 404) {
    tail.push(authenticated
      ? '仓库/issue 不存在,或当前 token 无权访问它(私有仓库需要 token 覆盖到该仓库)。'
      : '仓库/issue 不存在,或它是**私有仓库**——匿名模式看不到私有内容,配置 GITHUB_TOKEN 后重试。');
  } else if (status === 410) {
    tail.push('该仓库已关闭 issue 功能(Settings → Features → Issues 未启用)。');
  } else if (status === 422) {
    const errs = Array.isArray(details?.errors)
      ? details.errors.map((e) => `${e.field ?? ''} ${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ')
      : '';
    tail.push(`请求内容被 GitHub 拒绝(校验失败)${errs ? `:${errs}` : ''}。常见原因:label 在该仓库里不存在、title 为空。`);
  }
  return [error, ...tail].join('\n');
}

/** GitHub 用户名/组织名:字母数字加连字符,不以连字符开头结尾,≤39 字符。 */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** 仓库名:字母数字加 . _ -,≤100 字符。 */
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

function badRepoRef(owner, repo) {
  const o = String(owner ?? '').trim();
  const r = String(repo ?? '').trim();
  if (o === '') return '参数错误:owner 不能为空(填仓库所属的用户名或组织名,如 sindresorhus)';
  if (!OWNER_RE.test(o)) {
    return `参数错误:owner 格式非法,收到 ${JSON.stringify(o)}——只接受用户名/组织名本身`
      + '(字母数字与连字符,不含 "/"、空格或 URL),别把 "owner/repo" 或完整链接塞进来';
  }
  if (r === '') return '参数错误:repo 不能为空(填仓库名本身,如 slugify)';
  if (!REPO_RE.test(r)) {
    return `参数错误:repo 格式非法,收到 ${JSON.stringify(r)}——只接受仓库名本身`
      + '(字母数字与 . _ -,不含 "/"、空格或 URL)';
  }
  return null;
}

/** 列表项裁剪:只留 agent 用得上的字段,不把整条 GitHub JSON 倒回上下文。 */
const trimIssue = (i) => ({
  number: i.number,
  title: i.title,
  state: i.state,
  labels: Array.isArray(i.labels) ? i.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : [],
  user: i.user?.login,
  createdAt: i.created_at,
  url: i.html_url,
});

/** 当前模式说明:匿名 vs 认证,连同额度差异一起讲清楚。 */
const modeNote = (authenticated) => (authenticated
  ? '认证模式(已配置 GITHUB_TOKEN):额度 5000 req/h,可访问 token 覆盖到的私有仓库'
  : '匿名模式(未配置 GITHUB_TOKEN):只能读公开仓库,限额较低——60 req/h 且按 IP 共享;'
    + '配置 GITHUB_TOKEN 后可提到 5000 req/h 并访问私有仓库、创建 issue');

// ---- 能力表(免凭证工具与 capabilities 共用同一份事实)------------------------
const OPERATIONS = [
  {
    tool: 'list-issues',
    endpoint: 'GET /repos/{owner}/{repo}/issues',
    write: false,
    credentialRequired: false,
    degradesTo: '匿名模式(公开仓库可读,60 req/h)',
    tokenScopes: ['公开仓库:不需要 token', '私有仓库:fine-grained token 的 Issues: Read,或 classic token 的 repo'],
    notes: 'GitHub 的 /issues 端点会把 PR 也算作 issue 返回,本零件已把 PR 过滤掉并单独报数量。',
  },
  {
    tool: 'get-issue',
    endpoint: 'GET /repos/{owner}/{repo}/issues/{number}',
    write: false,
    credentialRequired: false,
    degradesTo: '匿名模式(公开仓库可读,60 req/h)',
    tokenScopes: ['公开仓库:不需要 token', '私有仓库:Issues: Read / repo'],
    notes: `返回单条 issue 详情,正文超过 ${MAX_BODY_CHARS} 字符会被截断并标注。`,
  },
  {
    tool: 'create-issue',
    endpoint: 'POST /repos/{owner}/{repo}/issues',
    write: true,
    credentialRequired: true,
    degradesTo: '不降级:GitHub 强制认证,没 token 直接返回可行动错误',
    tokenScopes: ['fine-grained token:选中目标仓库并给 Issues: Read and write', 'classic token:勾 repo(公开仓库可只勾 public_repo)'],
    notes: '写操作:会在真实仓库里建出一条对所有人可见的真实 issue,并触发仓库订阅者的通知。',
  },
  {
    tool: 'github-capabilities',
    endpoint: '(本地,不发请求)',
    write: false,
    credentialRequired: false,
    degradesTo: '不适用',
    tokenScopes: [],
    notes: '免凭证:零凭证状态下也能用,用来查清每个操作要什么 token 权限、token 去哪拿。',
  },
];

// ---- 工具 1:list-issues(无 token 时降级为匿名)-----------------------------
server.registerTool('list-issues', {
  description:
    '列出某个 GitHub 仓库的 issue(GET /repos/{owner}/{repo}/issues)。'
    + '可按状态(open/closed/all)与 label 过滤,返回裁剪后的列表:'
    + 'number、title、state、labels、提出者 user、createdAt、网页 url。'
    + '注意 GitHub 把 PR 也放在这个端点里返回,本零件已过滤掉 PR 并单独报 pullRequestsFiltered。'
    + '**读操作不需要凭证**:未配置 GITHUB_TOKEN 时自动降级为匿名调用(仅公开仓库,限额 60 req/h),'
    + '返回里的 mode 字段会注明当前是匿名还是认证模式;配上 token 则额度 5000 req/h 并可读私有仓库。'
    + '仓库存在但没有符合条件的 issue 时返回 { count: 0, issues: [] }(不是错误)。',
  inputSchema: {
    owner: z.string().describe('仓库所属用户名或组织名,如 sindresorhus(不要填 "owner/repo" 或完整 URL)'),
    repo: z.string().describe('仓库名,如 slugify'),
    state: z.enum(['open', 'closed', 'all']).optional().describe('issue 状态过滤,默认 open'),
    labels: z.array(z.string()).optional().describe('按 label 过滤,多个 label 是「同时具备」的与关系,如 ["bug","help wanted"]'),
    perPage: z.number().optional().describe('每页条数,整数 1..100,默认 30'),
    page: z.number().optional().describe('页码,整数 ≥1,默认 1'),
  },
}, async ({ owner, repo, state, labels, perPage, page }) => {
  const bad = badRepoRef(owner, repo);
  if (bad) return fail(bad);
  const n = perPage ?? 30;
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    return fail(`参数错误:perPage 必须是 1..100 之间的整数,收到 ${perPage}`);
  }
  const p = page ?? 1;
  if (!Number.isInteger(p) || p < 1) {
    return fail(`参数错误:page 必须是 ≥1 的整数,收到 ${page}`);
  }

  const token = readToken();
  const query = { state: state ?? 'open', per_page: String(n), page: String(p) };
  if (Array.isArray(labels) && labels.length > 0) query.labels = labels.join(',');

  const o = String(owner).trim();
  const r = String(repo).trim();
  const { data, error, status, rateLimit, details } = await callGitHub(
    `/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}/issues`,
    { query, token },
  );
  if (error) return fail(explain(error, status, rateLimit, Boolean(token), details));
  if (!Array.isArray(data)) {
    return fail(`${SERVICE} 响应结构异常:/issues 预期返回数组,实际是 ${typeof data}`);
  }

  const issues = data.filter((i) => i && i.pull_request === undefined);
  return ok({
    repository: `${o}/${r}`,
    mode: token ? 'authenticated' : 'anonymous',
    modeNote: modeNote(Boolean(token)),
    filter: { state: state ?? 'open', labels: labels ?? [], page: p, perPage: n },
    count: issues.length,
    pullRequestsFiltered: data.length - issues.length,
    issues: issues.map(trimIssue),
    rateLimit,
    hint: issues.length === 0
      ? '该仓库在此过滤条件下没有 issue——可改 state:"all" 或去掉 labels 再试'
      : undefined,
  });
});

// ---- 工具 2:get-issue(无 token 时降级为匿名)-------------------------------
server.registerTool('get-issue', {
  description:
    '取单条 GitHub issue 的详情(GET /repos/{owner}/{repo}/issues/{number})。'
    + `返回标题、状态、labels、提出者、时间、评论数、指派人与正文(正文超过 ${MAX_BODY_CHARS} 字符会截断并标注)。`
    + '**读操作不需要凭证**:未配置 GITHUB_TOKEN 时自动降级为匿名调用(仅公开仓库,限额 60 req/h),'
    + '返回里的 mode 字段会注明当前模式。issue 不存在或仓库私有时返回可行动的错误(会指出配 token 可解)。',
  inputSchema: {
    owner: z.string().describe('仓库所属用户名或组织名,如 sindresorhus'),
    repo: z.string().describe('仓库名,如 slugify'),
    number: z.number().describe('issue 编号(仓库内的序号,不是全局 id)'),
  },
}, async ({ owner, repo, number }) => {
  const bad = badRepoRef(owner, repo);
  if (bad) return fail(bad);
  if (!Number.isInteger(number) || number < 1) {
    return fail(`参数错误:number 必须是 ≥1 的整数(issue 在仓库内的编号),收到 ${number}`);
  }

  const token = readToken();
  const o = String(owner).trim();
  const r = String(repo).trim();
  const { data, error, status, rateLimit, details } = await callGitHub(
    `/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}/issues/${number}`,
    { token },
  );
  if (error) return fail(explain(error, status, rateLimit, Boolean(token), details));

  const body = String(data?.body ?? '');
  const truncated = body.length > MAX_BODY_CHARS;
  return ok({
    repository: `${o}/${r}`,
    mode: token ? 'authenticated' : 'anonymous',
    modeNote: modeNote(Boolean(token)),
    issue: {
      ...trimIssue(data ?? {}),
      updatedAt: data?.updated_at,
      closedAt: data?.closed_at ?? undefined,
      comments: data?.comments,
      assignees: Array.isArray(data?.assignees) ? data.assignees.map((a) => a?.login).filter(Boolean) : [],
      isPullRequest: data?.pull_request !== undefined,
      body: truncated ? `${body.slice(0, MAX_BODY_CHARS)}\n…[正文已截断,原长 ${body.length} 字符]` : body,
      bodyTruncated: truncated,
    },
    rateLimit,
  });
});

// ---- 工具 3:create-issue(写操作,强制需要 token)---------------------------
server.registerTool('create-issue', {
  description:
    '【写操作,会在真实仓库里创建一条真实 issue】在指定 GitHub 仓库新建 issue'
    + '(POST /repos/{owner}/{repo}/issues)。创建后该 issue 对所有能看到这个仓库的人可见、'
    + '会触发仓库订阅者的邮件/站内通知,且**本零件不提供删除**(GitHub 本身也只能关闭不能删)。'
    + '所以只在用户明确要求"提 issue / 建 issue"时调用,并且先确认 owner/repo 是不是他想要的那个仓库。'
    + '返回新 issue 的 number 与网页 url。'
    + '**这个操作必须有凭证**:GitHub 强制认证,未配置 GITHUB_TOKEN 时返回可行动的错误'
    + '(说明缺哪个变量、去哪取、需要什么权限),不会静默失败、也不会降级为匿名。',
  inputSchema: {
    owner: z.string().describe('仓库所属用户名或组织名——写操作,务必确认是目标仓库'),
    repo: z.string().describe('仓库名——写操作,务必确认是目标仓库'),
    title: z.string().describe('issue 标题'),
    body: z.string().optional().describe('issue 正文(Markdown)'),
    labels: z.array(z.string()).optional().describe('要打的 label 名数组;label 必须在该仓库里已存在,否则 GitHub 返回 422'),
  },
}, async ({ owner, repo, title, body, labels }) => {
  // 参数校验在前,凭证检查在后:两条错误路径在零凭证环境下互不遮蔽。
  const bad = badRepoRef(owner, repo);
  if (bad) return fail(bad);
  const t = String(title ?? '').trim();
  if (t === '') return fail('参数错误:title 不能为空——GitHub 不接受无标题的 issue');
  if (labels !== undefined && (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string' || l.trim() === ''))) {
    return fail('参数错误:labels 必须是非空字符串数组,如 ["bug"]');
  }

  const token = readToken();
  if (!token) {
    return fail(missingTokenMessage('create-issue(在真实仓库里创建 issue)', [
      'fine-grained token:选中目标仓库 + Issues: Read and write',
      'classic token:repo(公开仓库可只勾 public_repo)',
    ]));
  }

  const o = String(owner).trim();
  const r = String(repo).trim();
  const payload = { title: t };
  if (body !== undefined) payload.body = String(body);
  if (Array.isArray(labels) && labels.length > 0) payload.labels = labels;

  const { data, error, status, rateLimit, details } = await callGitHub(
    `/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}/issues`,
    { method: 'POST', body: payload, token },
  );
  if (error) return fail(explain(error, status, rateLimit, true, details));

  return ok({
    created: true,
    repository: `${o}/${r}`,
    mode: 'authenticated',
    issue: trimIssue(data ?? {}),
    rateLimit,
    note: 'issue 已在真实仓库里创建,订阅者会收到通知;本零件不提供删除(GitHub 只能关闭 issue)。',
  });
});

// ---- 工具 4:github-capabilities(免凭证)------------------------------------
server.registerTool('github-capabilities', {
  description:
    '【免凭证】列出本零件支持的 GitHub issue 操作、每个操作需要的 token 权限(scope)与环境变量,'
    + '说明哪些操作在没 token 时能降级为匿名(读)、哪些必须有 token(写),'
    + '并报告 token 当前是否已配置(只报"配没配",绝不回显取值)。'
    + '零凭证状态下也能正常调用——用它先搞清 token 要什么权限、在哪儿生成、怎么注入。',
  inputSchema: {},
}, async () => {
  const token = readToken();
  return ok({
    part: 'github-issues',
    service: SERVICE,
    baseUrl: BASE_URL,
    apiVersion: API_VERSION,
    auth: '每次请求带 Authorization: Bearer ${GITHUB_TOKEN} + Accept: application/vnd.github+json'
      + ` + X-GitHub-Api-Version: ${API_VERSION};读公开仓库时可以完全不带 Authorization(匿名模式)`,
    credentialsConfigured: Boolean(token),
    mode: token ? 'authenticated' : 'anonymous',
    modeNote: modeNote(Boolean(token)),
    // 只报布尔"是否已配",不返回任何取值——凭证不进模型上下文。
    credentials: SECRETS.map((s) => ({
      env: s.env,
      configured: Boolean(token),
      purpose: s.purpose,
      where: s.where,
    })),
    operations: OPERATIONS,
    setup: [
      `1. 到 ${TOKEN_URL} 生成 token:推荐 fine-grained(Repository access 选中目标仓库,Permissions → Issues 给 Read and write)`,
      '2. 也可以用 classic token:勾 repo(只操作公开仓库时勾 public_repo 就够)',
      '3. token 生成后只显示一次,当场复制',
      '4. 把 GITHUB_TOKEN 注入 host 进程环境或部署 .env(不要写进代码、不要当工具参数传)',
      '5. 重启本零件;再调 github-capabilities 应看到 credentialsConfigured: true、mode: authenticated',
      '注意:不配 token 也能用——list-issues / get-issue 会以匿名模式读公开仓库,只是限额 60 req/h;只有 create-issue 硬性要求 token',
    ],
    rateLimit: '认证 5000 req/h;匿名 60 req/h(按 IP 共享)。本零件所有请求串行排队,不做并发扇出,'
      + '并把服务端报的剩余额度放在每次返回的 rateLimit 字段里',
    docs: DOCS_URL,
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
