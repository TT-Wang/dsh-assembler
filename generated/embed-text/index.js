#!/usr/bin/env node
/**
 * embed-text — 文本嵌入(语义检索的"理解"半边;与 vector-store 配对)。
 *
 * 上游:任何 OpenAI 兼容的 /embeddings 端点(OpenAI、硅基流动、本地 vLLM/Ollama…),
 * 经 EMBED_API_BASE 切换,模型经 EMBED_MODEL 切换。凭证契约:未配 EMBED_API_KEY
 * 时零件照常起、listTools 成功、调用返回**可行动错误**(点名 env 与端点)。
 * 分工纪律:本件只产向量,存与搜归 vector-store——可验的部分留在可验的一侧。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = process.env.EMBED_API_BASE || 'https://api.openai.com/v1';
const MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
const MAX_ITEMS = 256;
const MAX_CHARS = 8000;

const server = new McpServer({ name: 'embed-text', version: '0.0.1' });
const text = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
const err = (m) => ({ isError: true, content: [{ type: 'text', text: `embed-text: ${m}` }] });

server.registerTool('embed-info', {
	description: '报告当前嵌入端点、模型与凭证状态(不回显密钥值)。装配前用它确认"接口是否就位"。',
	inputSchema: {},
}, async () => text({
	base: BASE, model: MODEL,
	credential: process.env.EMBED_API_KEY ? 'configured' : 'missing:EMBED_API_KEY',
	note: '产出的向量交给 vector-store 零件存与搜(vector-add / vector-search)',
}));

server.registerTool('embed-texts', {
	description: '把若干段文本转成向量(OpenAI 兼容 /embeddings)。返回每段的向量与维度——直接可喂 vector-store 的 vector-add。凭证走进程环境 EMBED_API_KEY,不经参数。',
	inputSchema: {
		texts: z.array(z.string()).describe('待嵌入文本(单次 ≤256 段,每段 ≤8000 字符)'),
		model: z.string().optional().describe('覆盖默认模型'),
	},
}, async ({ texts, model }) => {
	const key = process.env.EMBED_API_KEY || '';
	if (key === '') return err(`进程环境缺 EMBED_API_KEY(端点 ${BASE};host 或 .env 提供,密钥不走参数)。向量库(vector-store)不需要凭证,可先建集合。`);
	if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_ITEMS) return err(`texts 需 1..${MAX_ITEMS} 段`);
	const bad = texts.findIndex((t) => typeof t !== 'string' || t.length === 0 || t.length > MAX_CHARS);
	if (bad >= 0) return err(`第 ${bad + 1} 段非法(空或 >${MAX_CHARS} 字符)`);
	try {
		const res = await fetch(`${BASE}/embeddings`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
			body: JSON.stringify({ model: model || MODEL, input: texts }),
			signal: AbortSignal.timeout(120000),
		});
		if (!res.ok) return err(`上游 HTTP ${res.status}:${(await res.text()).slice(0, 200)}`);
		const j = await res.json();
		const vectors = (j.data ?? []).map((d) => d.embedding);
		if (vectors.length !== texts.length) return err(`上游返回 ${vectors.length} 个向量,与输入 ${texts.length} 段不符`);
		return text({ model: j.model ?? model ?? MODEL, dim: vectors[0]?.length ?? 0, count: vectors.length, vectors });
	} catch (e) {
		return err(`调用失败:${String(e && e.message || e).slice(0, 200)}`);
	}
});

await server.connect(new StdioServerTransport());
