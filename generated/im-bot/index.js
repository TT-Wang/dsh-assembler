#!/usr/bin/env node
/**
 * im-bot — 群机器人推送(企业微信 / 钉钉 / 飞书 + 本地 mock)。
 *
 * 国内交付刚需的"出口"件:告警、日报、审批结果推到群里。三家的群机器人都是
 * **webhook URL + JSON body**(不是 OAuth 应用),所以一件多供应商 —— 与
 * sms-gateway 同款形态,mock provider 供本地联调与冒烟真测。
 *
 * 凭证纪律:webhook URL 本身就是凭证,**只从进程环境读**
 *   WECOM_WEBHOOK / DINGTALK_WEBHOOK / FEISHU_WEBHOOK / IMBOT_MOCK_URL
 * 绝不做参数、绝不回显;未配时返回可行动错误(点名该配哪个 env)。
 * 钉钉加签(DINGTALK_SECRET)支持:HMAC-SHA256 时间戳签名自动拼进 URL。
 * 归类:出口(分类法:模型脸为主——判断后行动,不长服务脸)。
 */
import { createHmac } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PROVIDERS = {
  wecom: { env: 'WECOM_WEBHOOK', label: '企业微信群机器人' },
  dingtalk: { env: 'DINGTALK_WEBHOOK', label: '钉钉群机器人' },
  feishu: { env: 'FEISHU_WEBHOOK', label: '飞书群机器人' },
  mock: { env: 'IMBOT_MOCK_URL', label: '本地 mock(联调/冒烟用)' },
};
const MAX_LEN = 4000;
const server = new McpServer({ name: 'im-bot', version: '0.0.1' });
const text = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
const err = (m) => ({ isError: true, content: [{ type: 'text', text: `im-bot: ${m}` }] });

/** 各家的消息体形状(纯文本 + @人);差异吃在零件里,调用方只给 text。 */
function bodyOf(provider, content, atMobiles, atAll) {
  const at = Array.isArray(atMobiles) ? atMobiles.map(String) : [];
  if (provider === 'wecom') {
    return { msgtype: 'text', text: { content, mentioned_mobile_list: atAll ? ['@all'] : at } };
  }
  if (provider === 'dingtalk') {
    return { msgtype: 'text', text: { content }, at: { atMobiles: at, isAtAll: atAll === true } };
  }
  if (provider === 'feishu') {
    return { msg_type: 'text', content: { text: content } };
  }
  return { msgtype: 'text', text: { content }, at: { atMobiles: at, isAtAll: atAll === true } };
}

/** 钉钉加签:URL 追加 timestamp+sign(密钥只从 env 读,不回显)。 */
function signed(provider, url) {
  const secret = process.env.DINGTALK_SECRET || '';
  if (provider !== 'dingtalk' || secret === '') return url;
  const ts = Date.now();
  const sign = createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64');
  const u = new URL(url);
  u.searchParams.set('timestamp', String(ts));
  u.searchParams.set('sign', sign);
  return u.toString();
}

/** 上游是否认为成功:三家各有各的字段。 */
function okOf(provider, j) {
  if (provider === 'feishu') return j.code === 0 || j.StatusCode === 0 || j.msg === 'success';
  return j.errcode === 0 || j.errmsg === 'ok';
}

server.registerTool('imbot-info', {
  description: '报告各供应商的配置状态(哪些 webhook 已配、钉钉是否加签)——**不回显 URL 与密钥**。装配前用它确认"接口是否就位"。',
  inputSchema: {},
}, async () => text({
  providers: Object.entries(PROVIDERS).map(([k, v]) => ({
    provider: k, label: v.label, env: v.env,
    configured: (process.env[v.env] ?? '') !== '',
  })),
  dingtalkSigned: (process.env.DINGTALK_SECRET ?? '') !== '',
  note: 'webhook URL 本身即凭证:只从进程环境读,绝不进参数/日志/返回',
}));

server.registerTool('imbot-send', {
  description: '往群机器人推一条文本消息(告警/日报/审批结果)。provider:wecom|dingtalk|feishu|mock。URL 走进程环境,不经参数。支持 @手机号 或 @所有人。未配对应 env 时返回可行动错误。',
  inputSchema: {
    provider: z.string().describe('wecom | dingtalk | feishu | mock'),
    text: z.string().describe('消息正文(≤4000 字符)'),
    atMobiles: z.array(z.string()).optional().describe('要 @ 的手机号'),
    atAll: z.boolean().optional().describe('是否 @所有人'),
  },
}, async ({ provider, text: content, atMobiles, atAll }) => {
  const p = PROVIDERS[provider];
  if (p === undefined) return err(`未知 provider:${provider}(可选 ${Object.keys(PROVIDERS).join('/')})`);
  if (typeof content !== 'string' || content.trim() === '') return err('text 不能为空');
  if (content.length > MAX_LEN) return err(`text ${content.length} 字符 > ${MAX_LEN}`);
  const url = process.env[p.env] || '';
  if (url === '') return err(`进程环境缺 ${p.env}(${p.label} 的 webhook URL;host 或 .env 提供,不走参数)`);
  try {
    const res = await fetch(signed(provider, url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyOf(provider, content, atMobiles, atAll)),
      signal: AbortSignal.timeout(30000),
    });
    const raw = await res.text();
    let j = {};
    try { j = JSON.parse(raw); } catch { /* 非 JSON:按 HTTP 状态判 */ }
    const ok = res.ok && (Object.keys(j).length === 0 ? true : okOf(provider, j));
    if (!ok) return err(`推送被上游拒绝(HTTP ${res.status}):${raw.slice(0, 200)}`);
    return text({ provider, sent: true, chars: content.length, upstream: Object.keys(j).length > 0 ? j : { httpStatus: res.status } });
  } catch (e) { return err(`推送失败:${String(e && e.message || e).slice(0, 200)}`); }
});

await server.connect(new StdioServerTransport());
