#!/usr/bin/env node
/**
 * ai-call — AI 能力零件化(P1:泛化 agent 的"模型只在有判断处出现")。
 *
 * 把"一次 AI 调用"包成可被任何调用者(agent 工具面/服务件/触发流程)使用的
 * 零件:应用无需开聊天会话即可调 AI(摘要/分类/改写/抽取)。persona 在这里
 * 降维为参数(system),不再是会话灵魂。
 *
 * Safety:密钥只从进程 env 读(DEEPSEEK_API_KEY,host 或 .env 提供),值绝不
 * 进参数/日志/返回;prompt 上限 64KB;默认 flash(便宜快),可换 pro。
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com';
const MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);

const server = new McpServer({ name: 'ai-call', version: '0.0.1' });

server.registerTool('ai-complete', {
  description:
    '一次独立的 AI 补全调用(与当前会话完全无关的新调用):给 prompt(和可选 system),'
    + '返回模型文本。用于把摘要/分类/改写/抽取等 AI 步骤嵌进确定性流程——无需开会话。'
    + '默认 deepseek-v4-flash;凭证走进程环境 DEEPSEEK_API_KEY,不经参数。',
  inputSchema: {
    prompt: z.string().describe('用户内容(≤64KB)'),
    system: z.string().optional().describe('可选 system 指令(这一步 AI 的"岗位说明")'),
    model: z.string().optional().describe('deepseek-v4-flash(默认)| deepseek-v4-pro'),
    maxTokens: z.number().optional().describe('输出上限,默认 1024,最大 8192'),
  },
}, async ({ prompt, system, model, maxTokens }) => {
  const out = await complete({ prompt, system, model, maxTokens });
  return out.error !== undefined
    ? { isError: true, content: [{ type: 'text', text: `ai-complete: ${out.error}` }] }
    : { content: [{ type: 'text', text: JSON.stringify(out) }] };
});

/**
 * 补全实现(工具面与服务脸共用同一段——双脸不分叉是纪律:改一处两脸同步)。
 * 返回 { model, text, usage? } 或 { error }。
 */
async function complete({ prompt, system, model, maxTokens }) {
  const key = process.env.DEEPSEEK_API_KEY || '';
  if (key === '') return { error: '进程环境缺 DEEPSEEK_API_KEY(host 或 .env 提供;密钥不走参数)' };
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 64 * 1024) {
    return { error: 'prompt 必须为 1 字节 ~ 64KB 的字符串' };
  }
  const useModel = MODELS.has(model) ? model : 'deepseek-v4-flash';
  // 下限 256:v4 是推理模型,completion 预算先喂隐藏思维链——上限给太小
  // (实测 32)思维链吃光预算,text 返回空串。这是消费方最容易踩的坑,零件
  // 端直接抬地板。
  const cap = Math.max(256, Math.min(8192, Number.isFinite(maxTokens) ? maxTokens : 1024));
  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: useModel,
        max_tokens: cap,
        messages: [
          ...(typeof system === 'string' && system !== '' ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) return { error: `上游 HTTP ${res.status}:${(await res.text()).slice(0, 300)}` };
    const j = await res.json();
    const text = j && j.choices && j.choices[0] && j.choices[0].message ? String(j.choices[0].message.content || '') : '';
    const usage = j && j.usage ? { prompt: j.usage.prompt_tokens, completion: j.usage.completion_tokens } : undefined;
    return { model: useModel, text, ...(usage !== undefined ? { usage } : {}) };
  } catch (e) {
    return { error: `调用失败:${String(e && e.message || e).slice(0, 200)}` };
  }
}

// ── 服务脸(ai-thin 路由的物理基础)──────────────────────────────────────────
// 页面的"薄判断"(一句话解析成结构化、一段文字改写/分类)直连本脸,不必开
// agent 会话——判断密度决定路由,这一档就该是"一次补全"而不是"一整轮会话"。
// 安全模型与 sqlite 服务脸同款:127.0.0.1 随机口 + 每次启动随机 token,
// 经 workspace/.service.json 与 ai-face-info 工具双通道分发;密钥永不出进程。
const AI_TOKEN = randomBytes(16).toString('hex');
const aiFace = createServer((req, res) => {
	const cors = () => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Service-Token');
	};
	const json = (code, obj) => { cors(); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
	if (req.method === 'OPTIONS') { cors(); res.writeHead(204); res.end(); return; }
	if (req.headers['x-service-token'] !== AI_TOKEN) return json(401, { error: 'bad or missing X-Service-Token' });
	if (req.method !== 'POST' || (req.url ?? '/').split('?')[0] !== '/complete') return json(404, { error: 'POST /complete only' });
	let body = '';
	req.on('data', (d) => { body += d; if (body.length > 128 * 1024) req.destroy(); });
	req.on('end', async () => {
		try {
			const a = JSON.parse(body || '{}');
			const out = await complete({ prompt: a.prompt, system: a.system, model: a.model, maxTokens: a.maxTokens });
			return out.error !== undefined ? json(400, { error: out.error }) : json(200, out);
		} catch (e) {
			return json(400, { error: String(e && e.message || e).slice(0, 200) });
		}
	});
});
aiFace.listen(0, '127.0.0.1');
aiFace.unref(); // 质检门契约:stdio 关闭进程必须退场
const aiPort = await new Promise((r) => aiFace.once('listening', () => r(aiFace.address().port)));
const AI_FACE_URL = `http://127.0.0.1:${aiPort}`;

const workdir = process.env.PART_WORKDIR || '';
if (workdir !== '') {
	try {
		mkdirSync(workdir, { recursive: true });
		const svcPath = join(workdir, '.service.json');
		const existing = existsSync(svcPath) ? JSON.parse(readFileSync(svcPath, 'utf8')) : {};
		existing.ai = { url: AI_FACE_URL, token: AI_TOKEN, pid: process.pid, startedAt: new Date().toISOString() };
		writeFileSync(svcPath, JSON.stringify(existing, null, 2));
	} catch { /* 档案写不进不拦工具面 */ }
}

server.registerTool('ai-face-info', {
	description: '返回本零件的 HTTP 直连端点(服务脸):页面/程序可绕开会话直接做一次 AI 补全(薄判断路由 ai-thin)。返回 { url, token };调用方以 X-Service-Token 头访问 POST /complete {prompt, system?, model?, maxTokens?}。',
	inputSchema: {},
}, async () => ({ content: [{ type: 'text', text: JSON.stringify({ url: AI_FACE_URL, token: AI_TOKEN, endpoints: ['POST /complete'] }) }] }));

const transport = new StdioServerTransport();
await server.connect(transport);
