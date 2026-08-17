#!/usr/bin/env node
/**
 * 冒烟:零凭证子进程 → listTools 照常成功(接口先就位)→ 免凭证 feishu-capabilities 真实调用
 * → 需凭证工具给出点名变量的可行动错误 → 参数校验错误路径(且不被凭证错误遮蔽)。
 *
 * **这个冒烟故意在"没有凭证"的环境下跑**:它验证的正是"key 后补"这条交付路径——
 * 零件能起、接口可见、调用失败得清清楚楚。凭证已配时的真实 API 路径本机无法覆盖
 * (没有 app_id/app_secret),那条路径只保证代码正确,**不伪造数据假装跑通**。
 * 因此本冒烟不发任何网络请求:所有需凭证的调用都在换 token 之前就被拦下了。
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

// 零凭证环境:显式清掉凭证变量。跑冒烟的机器上可能真配了 key(host 环境或 .env),
// 不删的话测的就不是零凭证路径了,断言会莫名其妙地变成"真发消息"。
const NO_CRED_ENV = (() => {
  const e = { ...NETWORK_ENV };
  delete e.FEISHU_APP_ID;
  delete e.FEISHU_APP_SECRET;
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

// ---- 接口就位:没凭证也能起、也能列工具 --------------------------------------
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
check('零凭证下 listTools 仍返回 3 个工具', tools.tools.length === 3, names.join(','));
check('工具名齐全', ['send-message', 'list-chats', 'feishu-capabilities'].every((n) => names.includes(n)), names.join(','));
check('send-message 的 description 标明是写操作',
  /写操作/.test(tools.tools.find((t) => t.name === 'send-message')?.description ?? ''));
check('凭证不是工具参数(send-message 入参里没有 appId/appSecret)',
  !/app_?id|app_?secret/i.test(JSON.stringify(tools.tools.find((t) => t.name === 'send-message')?.inputSchema ?? {})));

// ---- 免凭证工具:真实调用并断言内容 ------------------------------------------
const cap = await call('feishu-capabilities', {});
const c = json(cap);
check('feishu-capabilities 零凭证下调用成功', cap.isError !== true && c !== null, text(cap).slice(0, 120));
check('capabilities 报告 credentialsConfigured=false', c?.credentialsConfigured === false, String(c?.credentialsConfigured));
check('capabilities 列出两个凭证变量且都标记未配置',
  Array.isArray(c?.credentials) && c.credentials.length === 2
  && c.credentials.every((x) => x.configured === false)
  && c.credentials.map((x) => x.env).sort().join(',') === 'FEISHU_APP_ID,FEISHU_APP_SECRET',
  JSON.stringify(c?.credentials?.map((x) => x.env)));
check('capabilities 说清每个凭证的用途与获取位置',
  c?.credentials?.every((x) => typeof x.purpose === 'string' && x.purpose.length > 0
    && typeof x.where === 'string' && x.where.includes('凭证与基础信息')));
check('capabilities 的操作清单覆盖 3 个工具',
  Array.isArray(c?.operations) && c.operations.length === 3
  && ['send-message', 'list-chats', 'feishu-capabilities'].every((n) => c.operations.some((o) => o.tool === n)),
  JSON.stringify(c?.operations?.map((o) => o.tool)));
check('操作清单标注了所需权限 scope(im:message / im:chat)',
  /im:message/.test(JSON.stringify(c?.operations)) && /im:chat/.test(JSON.stringify(c?.operations)));
check('操作清单区分了读写(send-message 标 write:true)',
  c?.operations?.find((o) => o.tool === 'send-message')?.write === true
  && c?.operations?.find((o) => o.tool === 'list-chats')?.write === false);
check('免凭证工具自己标注 requiresCredentials 为空',
  Array.isArray(c?.operations?.find((o) => o.tool === 'feishu-capabilities')?.requiresCredentials)
  && c.operations.find((o) => o.tool === 'feishu-capabilities').requiresCredentials.length === 0);
check('capabilities 给出配置步骤与文档地址',
  Array.isArray(c?.setup) && c.setup.length >= 4 && typeof c?.docs === 'string' && c.docs.includes('open.feishu.cn'));
check('capabilities 说明了 code!==0 也是错误', /code/.test(c?.errorShape ?? '') && /200/.test(c?.errorShape ?? ''));
check('capabilities 不回显凭证取值(每项只有 env/configured/purpose/where)',
  Array.isArray(c?.credentials)
  && c.credentials.every((x) => Object.keys(x).sort().join(',') === 'configured,env,purpose,where')
  && !/"value"|"appSecret"|"app_secret"\s*:/.test(text(cap)));

// ---- 零凭证降级:需凭证工具点名缺失变量 --------------------------------------
const m1 = await call('send-message', { receiveId: 'ou_smoke_test_receiver', text: 'smoke test' });
check('零凭证 send-message 返回 isError', m1.isError === true, text(m1).slice(0, 80));
check('错误点名 FEISHU_APP_ID 与 FEISHU_APP_SECRET',
  text(m1).includes('FEISHU_APP_ID') && text(m1).includes('FEISHU_APP_SECRET'), text(m1).slice(0, 100));
check('错误说明变量是干什么的', /App ID/.test(text(m1)) && /App Secret/.test(text(m1)));
check('错误说明去哪里获取(凭证与基础信息)', text(m1).includes('凭证与基础信息'));
check('错误说明怎么配(环境变量 / .env)', text(m1).includes('.env') && text(m1).includes('环境'));
check('错误声明凭证不走工具参数', text(m1).includes('工具参数'));
check('零凭证 send-message 没有假装发送成功', !/"sent":\s*true/.test(text(m1)));

const m2 = await call('list-chats', {});
check('零凭证 list-chats 返回 isError 且点名变量',
  m2.isError === true && text(m2).includes('FEISHU_APP_ID'), text(m2).slice(0, 80));
check('零凭证 list-chats 没有返回假群列表', !/"chats"/.test(text(m2)));

// ---- 参数校验路径:不被凭证错误遮蔽(校验在凭证检查之前)----------------------
const e1 = await call('send-message', { receiveId: '   ', text: 'hi' });
check('空 receiveId 被拒且报的是参数错误(非凭证错误)',
  e1.isError === true && text(e1).includes('receiveId') && !text(e1).includes('FEISHU_APP_SECRET'), text(e1).slice(0, 80));

const e2 = await call('send-message', { receiveId: 'ou_x', text: '   ' });
check('空 text 被拒(参数错误)',
  e2.isError === true && text(e2).includes('text') && !text(e2).includes('FEISHU_APP_SECRET'), text(e2).slice(0, 80));

const e3 = await call('list-chats', { pageSize: 999 });
check('pageSize=999 被拒(参数错误)',
  e3.isError === true && text(e3).includes('pageSize') && !text(e3).includes('FEISHU_APP_SECRET'), text(e3).slice(0, 80));

const e4 = await call('send-message', { receiveId: 'ou_x', text: 'hi', receiveIdType: 'not_a_type' });
check('非法 receiveIdType 被 schema 拒', e4.isError === true, text(e4).slice(0, 80));

console.log('  (说明:凭证已配时的真实飞书 API 调用本机无法覆盖——没有 app_id/app_secret,不伪造)');

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
