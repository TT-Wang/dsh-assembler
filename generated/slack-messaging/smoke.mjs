#!/usr/bin/env node
/**
 * 冒烟:零凭证子进程 → listTools 照常成功(接口先就位)→ 免凭证 slack-capabilities 真实调用
 * → 需凭证工具给出点名 SLACK_BOT_TOKEN 的可行动错误 → 参数校验错误路径(且不被凭证错误遮蔽)。
 *
 * **这个冒烟故意在"没有 token"的环境下跑**:它验证的正是"key 后补"这条交付路径——
 * 零件能起、接口可见、调用失败得清清楚楚。token 已配时的真实 Slack API 路径本机无法覆盖
 * (没有 xoxb- token),那条路径只保证代码正确,**不伪造数据假装跑通**。
 * 因此本冒烟不发任何网络请求:所有需凭证的调用都在发请求之前就被拦下了。
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

// 零凭证环境:显式清掉 token。跑冒烟的机器上可能真配了 token(host 环境或 .env),
// 不删的话测的就不是零凭证路径了——更糟的是 post-message 会真的往工作区发消息。
const NO_CRED_ENV = (() => {
  const e = { ...NETWORK_ENV };
  delete e.SLACK_BOT_TOKEN;
  return e;
})();

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
check('零凭证下 listTools 仍返回 3 个工具', tools.tools.length === 3, names.join(','));
check('工具名齐全', ['post-message', 'list-channels', 'slack-capabilities'].every((n) => names.includes(n)), names.join(','));
check('post-message 的 description 标明是写操作',
  /写操作/.test(tools.tools.find((t) => t.name === 'post-message')?.description ?? ''));
check('凭证不是工具参数(post-message 入参里没有 token)',
  !/token/i.test(JSON.stringify(tools.tools.find((t) => t.name === 'post-message')?.inputSchema ?? {})
    .replace(/threadTs/g, '')));

// ---- 免凭证工具:真实调用并断言内容 ------------------------------------------
const cap = await call('slack-capabilities', {});
const c = json(cap);
check('slack-capabilities 零凭证下调用成功', cap.isError !== true && c !== null, text(cap).slice(0, 120));
check('capabilities 报告 credentialsConfigured=false', c?.credentialsConfigured === false, String(c?.credentialsConfigured));
check('capabilities 列出 SLACK_BOT_TOKEN 且标记未配置',
  Array.isArray(c?.credentials) && c.credentials.length === 1
  && c.credentials[0].env === 'SLACK_BOT_TOKEN' && c.credentials[0].configured === false,
  JSON.stringify(c?.credentials?.map((x) => x.env)));
check('capabilities 说清 token 的用途与获取位置',
  typeof c?.credentials?.[0]?.purpose === 'string' && c.credentials[0].purpose.includes('xoxb-')
  && typeof c?.credentials?.[0]?.where === 'string' && c.credentials[0].where.includes('OAuth & Permissions'));
check('capabilities 的操作清单覆盖 3 个工具',
  Array.isArray(c?.operations) && c.operations.length === 3
  && ['post-message', 'list-channels', 'slack-capabilities'].every((n) => c.operations.some((o) => o.tool === n)),
  JSON.stringify(c?.operations?.map((o) => o.tool)));
check('post-message 标注需要 chat:write scope',
  c?.operations?.find((o) => o.tool === 'post-message')?.scopes?.includes('chat:write'),
  JSON.stringify(c?.operations?.find((o) => o.tool === 'post-message')?.scopes));
check('list-channels 标注需要 channels:read scope',
  c?.operations?.find((o) => o.tool === 'list-channels')?.scopes?.includes('channels:read'),
  JSON.stringify(c?.operations?.find((o) => o.tool === 'list-channels')?.scopes));
check('操作清单区分了读写(post-message 标 write:true)',
  c?.operations?.find((o) => o.tool === 'post-message')?.write === true
  && c?.operations?.find((o) => o.tool === 'list-channels')?.write === false);
check('免凭证工具自己标注 requiresCredentials 为空',
  Array.isArray(c?.operations?.find((o) => o.tool === 'slack-capabilities')?.requiresCredentials)
  && c.operations.find((o) => o.tool === 'slack-capabilities').requiresCredentials.length === 0);
check('capabilities 给出 token 获取步骤与文档地址',
  Array.isArray(c?.setup) && c.setup.length >= 5 && typeof c?.docs === 'string' && c.docs.includes('api.slack.com'));
check('capabilities 说明了 ok:false 也是错误', /ok/.test(c?.errorShape ?? '') && /200/.test(c?.errorShape ?? ''));
check('capabilities 收录了 invalid_auth / missing_scope 等错误码',
  Array.isArray(c?.knownErrorCodes) && c.knownErrorCodes.includes('invalid_auth') && c.knownErrorCodes.includes('missing_scope'));
check('capabilities 不回显凭证取值(每项只有 env/configured/purpose/where)',
  c?.credentials?.every((x) => Object.keys(x).sort().join(',') === 'configured,env,purpose,where')
  && !/xoxb-[A-Za-z0-9]/.test(text(cap)));

// ---- 零凭证降级:需凭证工具点名缺失变量 --------------------------------------
const m1 = await call('post-message', { channel: 'C0123456789', text: 'smoke test' });
check('零凭证 post-message 返回 isError', m1.isError === true, text(m1).slice(0, 80));
check('错误点名 SLACK_BOT_TOKEN', text(m1).includes('SLACK_BOT_TOKEN'), text(m1).slice(0, 100));
check('错误说明变量是干什么的(Bot User OAuth Token)', text(m1).includes('Bot User OAuth Token'));
check('错误说明去哪里获取(OAuth & Permissions)', text(m1).includes('OAuth & Permissions'));
check('错误告诉本操作需要 chat:write scope', text(m1).includes('chat:write'), text(m1).slice(-200));
check('错误说明怎么配(环境变量 / .env)', text(m1).includes('.env') && text(m1).includes('环境'));
check('错误声明凭证不走工具参数', text(m1).includes('工具参数'));
check('零凭证 post-message 没有假装发送成功', !/"sent":\s*true/.test(text(m1)));

const m2 = await call('list-channels', {});
check('零凭证 list-channels 返回 isError 且点名 SLACK_BOT_TOKEN',
  m2.isError === true && text(m2).includes('SLACK_BOT_TOKEN'), text(m2).slice(0, 80));
check('零凭证 list-channels 提示需要 channels:read scope', text(m2).includes('channels:read'));
check('零凭证 list-channels 没有返回假频道列表', !/"channels"/.test(text(m2)));

// ---- 参数校验路径:不被凭证错误遮蔽(校验在凭证检查之前)----------------------
const e1 = await call('post-message', { channel: '   ', text: 'hi' });
check('空 channel 被拒且报的是参数错误(非凭证错误)',
  e1.isError === true && text(e1).includes('channel') && !text(e1).includes('SLACK_BOT_TOKEN'), text(e1).slice(0, 80));

const e2 = await call('post-message', { channel: 'my channel name', text: 'hi' });
check('含空格的 channel 被拒(参数错误)',
  e2.isError === true && text(e2).includes('channel') && !text(e2).includes('SLACK_BOT_TOKEN'), text(e2).slice(0, 90));

const e3 = await call('post-message', { channel: 'C0123456789', text: '   ' });
check('空 text 被拒(参数错误)',
  e3.isError === true && text(e3).includes('text') && !text(e3).includes('SLACK_BOT_TOKEN'), text(e3).slice(0, 80));

const e4 = await call('list-channels', { limit: 9999 });
check('limit=9999 被拒(参数错误)',
  e4.isError === true && text(e4).includes('limit') && !text(e4).includes('SLACK_BOT_TOKEN'), text(e4).slice(0, 80));

const e5 = await call('list-channels', { limit: 'fifty' });
check('limit 非数字被 schema 拒', e5.isError === true, text(e5).slice(0, 80));

console.log('  (说明:token 已配时的真实 Slack API 调用本机无法覆盖——没有 xoxb- token,不伪造)');

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
