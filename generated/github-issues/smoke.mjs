#!/usr/bin/env node
/**
 * 冒烟:零凭证子进程 → listTools 照常成功 → 免凭证 github-capabilities 真实调用
 * → **匿名模式真实网络调用**(读 sindresorhus/slugify 的 issue 列表 + 单条详情 + 404 路径)
 * → 写操作 create-issue 在零凭证下给出点名 GITHUB_TOKEN 的可行动错误
 * → 参数校验错误路径(且不被凭证错误遮蔽)。
 *
 * **这个冒烟故意在"没有 token"的环境下跑**,验证两档零凭证行为:
 *   - 读:降级为匿名并**真的调通** GitHub(这是真实网络断言,不是构造数据)
 *   - 写:硬报错并说清缺什么、去哪取
 * token 已配时的认证路径本机无法覆盖(没有 token),那条路径只保证代码正确,**不伪造数据假装跑通**。
 * create-issue 在整个冒烟里**永远不会真的建 issue**:token 被显式删掉,调用在发请求前就被拦下。
 *
 * 断言抗数据漂移:只压结构与类型(number 是数字、url 含仓库路径、mode 是 anonymous),
 * 不压具体 issue 标题/条数——上游仓库的 issue 每天都在变。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// 网络零件冒烟:必须把代理环境显式传给零件子进程。MCP SDK 的
// StdioClientTransport 默认只透传白名单 env(HOME/PATH/USER…),
// HTTPS_PROXY / NODE_USE_ENV_PROXY 都不在其中——不传的话零件在代理网络下
// 只会报 "fetch failed",看起来像零件坏了,其实是网络路径断了。
const NETWORK_ENV = (() => {
  const e = { ...process.env };
  if ((e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy) && e.NODE_USE_ENV_PROXY === undefined) {
    e.NODE_USE_ENV_PROXY = '1';
  }
  return e;
})();

// 零凭证环境:显式清掉 token。跑冒烟的机器上可能真配了 GITHUB_TOKEN(host 环境或 .env),
// 不删的话测的就不是匿名降级路径了——更糟的是 create-issue 会真的往仓库里建 issue。
const NO_CRED_ENV = (() => {
  const e = { ...NETWORK_ENV };
  delete e.GITHUB_TOKEN;
  delete e.GH_TOKEN;
  return e;
})();

const PUBLIC_OWNER = 'sindresorhus';
const PUBLIC_REPO = 'slugify';

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};
const text = (r) => r.content.map((b) => b.text ?? '').join('');
const json = (r) => { try { return JSON.parse(text(r)); } catch { return null; } };

const transport = new StdioClientTransport({
  command: 'node',
  args: [new URL('./index.js', import.meta.url).pathname],
  env: NO_CRED_ENV,
});
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const call = async (name, args) => {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `callTool 抛出:${e?.message ?? String(e)}` }] };
  }
};

// ---- 接口就位:没 token 也能起、也能列工具 -----------------------------------
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
check('零凭证下 listTools 仍返回 4 个工具', tools.tools.length === 4, names.join(','));
check('工具名齐全',
  ['list-issues', 'get-issue', 'create-issue', 'github-capabilities'].every((n) => names.includes(n)), names.join(','));
check('create-issue 的 description 写明会在真实仓库创建 issue',
  /真实仓库/.test(tools.tools.find((t) => t.name === 'create-issue')?.description ?? ''));
check('凭证不是工具参数(create-issue 入参里没有 token)',
  !/token/i.test(JSON.stringify(tools.tools.find((t) => t.name === 'create-issue')?.inputSchema ?? {})));

// ---- 免凭证工具:真实调用并断言内容 ------------------------------------------
const cap = await call('github-capabilities', {});
const c = json(cap);
check('github-capabilities 零凭证下调用成功', cap.isError !== true && c !== null, text(cap).slice(0, 120));
check('capabilities 报告 credentialsConfigured=false 且 mode=anonymous',
  c?.credentialsConfigured === false && c?.mode === 'anonymous', `${c?.credentialsConfigured}/${c?.mode}`);
check('capabilities 列出 GITHUB_TOKEN 且标记未配置',
  Array.isArray(c?.credentials) && c.credentials.length === 1
  && c.credentials[0].env === 'GITHUB_TOKEN' && c.credentials[0].configured === false,
  JSON.stringify(c?.credentials?.map((x) => x.env)));
check('capabilities 说清 token 的用途与获取位置',
  typeof c?.credentials?.[0]?.purpose === 'string' && c.credentials[0].purpose.includes('Personal Access Token')
  && typeof c?.credentials?.[0]?.where === 'string' && c.credentials[0].where.includes('Developer settings'));
check('capabilities 的操作清单覆盖 4 个工具',
  Array.isArray(c?.operations) && c.operations.length === 4
  && ['list-issues', 'get-issue', 'create-issue', 'github-capabilities'].every((n) => c.operations.some((o) => o.tool === n)),
  JSON.stringify(c?.operations?.map((o) => o.tool)));
check('操作清单区分读写:create-issue 是 write 且强制要凭证',
  c?.operations?.find((o) => o.tool === 'create-issue')?.write === true
  && c?.operations?.find((o) => o.tool === 'create-issue')?.credentialRequired === true);
check('操作清单标明读操作可降级为匿名',
  c?.operations?.find((o) => o.tool === 'list-issues')?.credentialRequired === false
  && /匿名/.test(c?.operations?.find((o) => o.tool === 'list-issues')?.degradesTo ?? ''),
  c?.operations?.find((o) => o.tool === 'list-issues')?.degradesTo);
check('操作清单给出所需 token scope(Issues: Read and write / repo)',
  /Issues: Read and write/.test(JSON.stringify(c?.operations)) && /public_repo|repo/.test(JSON.stringify(c?.operations)));
check('capabilities 给出 token 获取步骤与文档地址',
  Array.isArray(c?.setup) && c.setup.length >= 5 && typeof c?.docs === 'string' && c.docs.includes('docs.github.com'));
check('capabilities 说明匿名与认证的限额差异',
  /60/.test(c?.rateLimit ?? '') && /5000/.test(c?.rateLimit ?? ''), c?.rateLimit?.slice(0, 40));
check('capabilities 不回显凭证取值(每项只有 env/configured/purpose/where)',
  c?.credentials?.every((x) => Object.keys(x).sort().join(',') === 'configured,env,purpose,where')
  && !/gh[pousr]_[A-Za-z0-9]{16}/.test(text(cap)));

// ---- 匿名模式真实网络调用:读公开仓库的 issue 列表 ---------------------------
console.log(`  (以下 3 次是真实网络调用,匿名读 ${PUBLIC_OWNER}/${PUBLIC_REPO})`);
const r1 = await call('list-issues', { owner: PUBLIC_OWNER, repo: PUBLIC_REPO, state: 'all', perPage: 5 });
const g1 = json(r1);
check('匿名 list-issues 真实调通(非 isError)', r1.isError !== true && g1 !== null, text(r1).slice(0, 200));
check('返回注明 mode: anonymous', g1?.mode === 'anonymous', String(g1?.mode));
check('返回的 modeNote 说明是匿名模式且限额较低',
  /匿名/.test(g1?.modeNote ?? '') && /60/.test(g1?.modeNote ?? ''), String(g1?.modeNote).slice(0, 50));
check('拿到 issue 列表(数组且非空)',
  Array.isArray(g1?.issues) && g1.issues.length >= 1, `count=${g1?.count}`);
check('回显仓库全名', g1?.repository === `${PUBLIC_OWNER}/${PUBLIC_REPO}`, String(g1?.repository));
const first = g1?.issues?.[0];
check('列表项裁剪出 number(数字)', typeof first?.number === 'number' && first.number >= 1, String(first?.number));
check('列表项裁剪出 title(非空字符串)', typeof first?.title === 'string' && first.title.length > 0, String(first?.title).slice(0, 50));
check('列表项裁剪出 state(open/closed)', first?.state === 'open' || first?.state === 'closed', String(first?.state));
check('列表项裁剪出 labels 数组', Array.isArray(first?.labels), JSON.stringify(first?.labels));
check('列表项裁剪出 user(提出者 login)', typeof first?.user === 'string' && first.user.length > 0, String(first?.user));
check('列表项裁剪出 createdAt(可解析时间)',
  typeof first?.createdAt === 'string' && !Number.isNaN(Date.parse(first.createdAt)), String(first?.createdAt));
check('列表项裁剪出指向该仓库的 url',
  typeof first?.url === 'string' && first.url.includes(`${PUBLIC_OWNER}/${PUBLIC_REPO}`), String(first?.url));
check('未把整条 GitHub JSON 倒回(列表项只有 7 个字段)',
  Object.keys(first ?? {}).sort().join(',') === 'createdAt,labels,number,state,title,url,user',
  Object.keys(first ?? {}).join(','));
check('报告了 PR 过滤数量(GitHub 的 /issues 会混进 PR)',
  typeof g1?.pullRequestsFiltered === 'number' && g1.pullRequestsFiltered >= 0, String(g1?.pullRequestsFiltered));
check('返回带上服务端剩余额度(匿名 limit 应为 60)',
  g1?.rateLimit?.remaining !== undefined && g1?.rateLimit?.limit === '60',
  JSON.stringify(g1?.rateLimit));

// ---- 匿名模式真实网络调用:单条 issue 详情 -----------------------------------
const r2 = await call('get-issue', { owner: PUBLIC_OWNER, repo: PUBLIC_REPO, number: first?.number ?? 1 });
const g2 = json(r2);
check('匿名 get-issue 真实调通(非 isError)', r2.isError !== true && g2 !== null, text(r2).slice(0, 200));
check('get-issue 也注明 mode: anonymous', g2?.mode === 'anonymous', String(g2?.mode));
check('取到的正是刚才那条 issue', g2?.issue?.number === first?.number, `${g2?.issue?.number} vs ${first?.number}`);
check('详情含 body 字段与截断标记',
  typeof g2?.issue?.body === 'string' && typeof g2?.issue?.bodyTruncated === 'boolean',
  `bodyLen=${g2?.issue?.body?.length}, truncated=${g2?.issue?.bodyTruncated}`);
check('详情含评论数与 updatedAt',
  typeof g2?.issue?.comments === 'number' && typeof g2?.issue?.updatedAt === 'string',
  `comments=${g2?.issue?.comments}`);

// ---- 真实错误路径:不存在的仓库(匿名 404,并提示配 token 可解)---------------
const r3 = await call('get-issue', { owner: PUBLIC_OWNER, repo: 'this-repo-does-not-exist-dsh-xyz', number: 1 });
check('不存在的仓库返回 isError 且含 404', r3.isError === true && text(r3).includes('404'), text(r3).slice(0, 120));
check('404 说明匿名模式看不到私有仓库、配 token 可解',
  text(r3).includes('GITHUB_TOKEN') && text(r3).includes('私有'), text(r3).split('\n').pop()?.slice(0, 90));

// ---- 零凭证降级(写操作):必须硬报错 ----------------------------------------
const w1 = await call('create-issue', { owner: PUBLIC_OWNER, repo: PUBLIC_REPO, title: 'smoke test — 不应被创建' });
check('零凭证 create-issue 返回 isError', w1.isError === true, text(w1).slice(0, 80));
check('错误点名 GITHUB_TOKEN', text(w1).includes('GITHUB_TOKEN'), text(w1).slice(0, 100));
check('错误说明变量是干什么的(Personal Access Token)', text(w1).includes('Personal Access Token'));
check('错误说明去哪里获取(Developer settings / settings/tokens)',
  text(w1).includes('Developer settings') && text(w1).includes('settings/tokens'));
check('错误告诉本操作需要什么权限(Issues: Read and write)', text(w1).includes('Issues: Read and write'));
check('错误说明怎么配(环境变量 / .env)', text(w1).includes('.env') && text(w1).includes('环境'));
check('错误声明凭证不走工具参数', text(w1).includes('工具参数'));
check('错误指出写操作不降级为匿名', /强制要求认证|匿名调用一定被拒/.test(text(w1)));
check('零凭证 create-issue 没有假装创建成功', !/"created":\s*true/.test(text(w1)));

// ---- 参数校验路径:不被凭证错误遮蔽(校验在凭证检查之前)----------------------
const e1 = await call('create-issue', { owner: 'bad/owner', repo: PUBLIC_REPO, title: 'x' });
check('owner 含 "/" 被拒且报的是参数错误(非凭证错误)',
  e1.isError === true && text(e1).includes('owner') && !text(e1).includes('GITHUB_TOKEN'), text(e1).slice(0, 100));

const e2 = await call('create-issue', { owner: PUBLIC_OWNER, repo: PUBLIC_REPO, title: '   ' });
check('空 title 被拒(参数错误,非凭证错误)',
  e2.isError === true && text(e2).includes('title') && !text(e2).includes('GITHUB_TOKEN'), text(e2).slice(0, 80));

const e3 = await call('list-issues', { owner: 'https://github.com/sindresorhus', repo: PUBLIC_REPO });
check('把完整 URL 当 owner 被拒(参数错误)',
  e3.isError === true && text(e3).includes('owner'), text(e3).slice(0, 100));

const e4 = await call('list-issues', { owner: PUBLIC_OWNER, repo: 'has space', perPage: 5 });
check('含空格的 repo 被拒(参数错误)',
  e4.isError === true && text(e4).includes('repo'), text(e4).slice(0, 100));

const e5 = await call('list-issues', { owner: PUBLIC_OWNER, repo: PUBLIC_REPO, perPage: 500 });
check('perPage=500 被拒(参数错误)', e5.isError === true && text(e5).includes('perPage'), text(e5).slice(0, 80));

const e6 = await call('get-issue', { owner: PUBLIC_OWNER, repo: PUBLIC_REPO, number: 0 });
check('number=0 被拒(参数错误)', e6.isError === true && text(e6).includes('number'), text(e6).slice(0, 80));

const e7 = await call('list-issues', { owner: PUBLIC_OWNER, repo: PUBLIC_REPO, state: 'sideways' });
check('非法 state 被 schema 拒', e7.isError === true, text(e7).slice(0, 80));

console.log('  (说明:token 已配时的认证路径本机无法覆盖——没有 token,不伪造;create-issue 全程未真的建过 issue)');

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
