#!/usr/bin/env node
/**
 * vector-store — 本地向量索引(语义检索的存储半边;目录规模化的前置件)。
 *
 * 纯本地、零凭证、零网络:向量进、相似度出。落盘 PART_WORKDIR/vectors/<集合>.json,
 * 跨会话持久。与 embed-text 零件配对使用(那半边负责"文本→向量",带凭证契约);
 * 分开是刻意的:**存储可完整验收,嵌入依赖上游**——把可验的部分留在可验的一侧。
 *
 * 服务脸:页面可直接做语义搜索(拿到向量后搜),搜索结果是小 JSON,确定性流,
 * 不必为一次检索开会话。
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PART_WORKDIR = process.env.PART_WORKDIR || process.cwd();
const VEC_DIR = resolve(PART_WORKDIR, 'vectors');
const TOKEN = randomBytes(16).toString('hex');
const MAX_DIM = 4096;
const MAX_ITEMS = 50_000;
mkdirSync(VEC_DIR, { recursive: true });

const server = new McpServer({ name: 'vector-store', version: '0.0.1' });
const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const err = (msg) => ({ isError: true, content: [{ type: 'text', text: `vector-store: ${msg}` }] });

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const fileOf = (c) => (NAME_RE.test(String(c ?? '')) ? join(VEC_DIR, `${c}.json`) : null);
const load = (c) => { const f = fileOf(c); return f !== null && existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { dim: null, items: [] }; };
const save = (c, data) => writeFileSync(fileOf(c), JSON.stringify(data));

/** 余弦相似度(向量已按需归一化时等价点积;这里不假设归一化)。 */
function cosine(a, b) {
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
	const d = Math.sqrt(na) * Math.sqrt(nb);
	return d === 0 ? 0 : dot / d;
}

function validVector(v) {
	return Array.isArray(v) && v.length > 0 && v.length <= MAX_DIM && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/** 检索(工具面与服务脸共用):向量 → topK 命中(不返回原向量,返回体裁剪铁律)。 */
function search(collection, vector, topK, minScore) {
	if (fileOf(collection) === null) return { error: `非法集合名:${collection}` };
	if (!validVector(vector)) return { error: `vector 必须是 1..${MAX_DIM} 维的有限数值数组` };
	const data = load(collection);
	if (data.items.length === 0) return { collection, hits: [], note: '集合为空' };
	if (data.dim !== null && data.dim !== vector.length) return { error: `维度不匹配:集合是 ${data.dim} 维,查询是 ${vector.length} 维` };
	const k = Math.max(1, Math.min(100, Number.isFinite(topK) ? topK : 5));
	const floor = Number.isFinite(minScore) ? minScore : -1;
	const hits = data.items
		.map((it) => ({ id: it.id, score: Number(cosine(vector, it.vector).toFixed(6)), text: it.text ?? null, meta: it.meta ?? null }))
		.filter((h) => h.score >= floor)
		.sort((a, b) => b.score - a.score)
		.slice(0, k);
	return { collection, hits, searched: data.items.length };
}

// ── 服务脸(页面直接语义搜索:确定性流,不开会话)──────────────────────────
const face = createServer((req, res) => {
	const cors = () => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Service-Token');
	};
	const json = (code, obj) => { cors(); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
	if (req.method === 'OPTIONS') { cors(); res.writeHead(204); res.end(); return; }
	// 鉴权:头 X-Service-Token 或查询串 ?token=(二者等价)。查询串是必要的——
	// <audio src>/<img src>/下载链接无法带自定义头,只认 URL;字节类服务脸若只收头,
	// 页面就永远取不到字节(实测:B3 语音便签墙因取不到脸整题颗粒无收)。
	const presented = req.headers['x-service-token'] ?? (() => { try { return new URL(req.url ?? '/', 'http://local').searchParams.get('token'); } catch { return null; } })();
	if (presented !== TOKEN) return json(401, { error: 'bad or missing service token(头 X-Service-Token 或 ?token= 均可)' });
	const p = (req.url ?? '/').split('?')[0];
	if (req.method === 'GET' && p === '/collections') {
		return json(200, {
			collections: readdirSync(VEC_DIR).filter((f) => f.endsWith('.json')).map((f) => {
				const d = JSON.parse(readFileSync(join(VEC_DIR, f), 'utf8'));
				return { name: f.replace(/\.json$/, ''), items: d.items.length, dim: d.dim };
			}),
		});
	}
	if (req.method === 'POST' && p === '/search') {
		let body = '';
		req.on('data', (d) => { body += d; if (body.length > 4 * 1024 * 1024) req.destroy(); });
		req.on('end', () => {
			try {
				const a = JSON.parse(body || '{}');
				const out = search(a.collection, a.vector, a.topK, a.minScore);
				return out.error !== undefined ? json(400, out) : json(200, out);
			} catch (e) { return json(400, { error: String(e && e.message || e).slice(0, 200) }); }
		});
		return;
	}
	return json(404, { error: 'GET /collections · POST /search {collection, vector, topK?, minScore?}' });
});
face.listen(0, '127.0.0.1');
face.unref();
const port = await new Promise((r) => face.once('listening', () => r(face.address().port)));
const FACE_URL = `http://127.0.0.1:${port}`;
try {
	const svcPath = join(PART_WORKDIR, '.service.json');
	const existing = existsSync(svcPath) ? JSON.parse(readFileSync(svcPath, 'utf8')) : {};
	existing.vectors = { url: FACE_URL, token: TOKEN, dir: VEC_DIR, pid: process.pid, startedAt: new Date().toISOString() };
	writeFileSync(svcPath, JSON.stringify(existing, null, 2));
} catch { /* 档案写不进不拦工具面 */ }

// ── 工具面 ────────────────────────────────────────────────────────────────────
server.registerTool('vector-info', {
	description: '向量库直连端点(服务脸)与各集合概况。页面可经 POST /search 直接做语义检索(拿到查询向量后),不必开会话。',
	inputSchema: {},
}, async () => text({
	url: FACE_URL, token: TOKEN, dir: VEC_DIR,
	collections: readdirSync(VEC_DIR).filter((f) => f.endsWith('.json')).map((f) => {
		const d = JSON.parse(readFileSync(join(VEC_DIR, f), 'utf8'));
		return { name: f.replace(/\.json$/, ''), items: d.items.length, dim: d.dim };
	}),
	endpoints: ['GET /collections', 'POST /search'],
}));

server.registerTool('vector-add', {
	description: '把若干条(id + 向量 + 可选原文/元数据)写入集合;同 id 覆盖(幂等重灌)。向量由 embed-text 零件或任何嵌入服务产出——本零件不负责生成向量。',
	inputSchema: {
		collection: z.string().describe('集合名(字母数字/._-)'),
		items: z.array(z.object({
			id: z.string(),
			vector: z.array(z.number()),
			text: z.string().optional(),
			meta: z.record(z.any()).optional(),
		})).describe('待写入条目(单次 ≤1000 条)'),
	},
}, async ({ collection, items }) => {
	if (fileOf(collection) === null) return err(`非法集合名:${collection}`);
	if (!Array.isArray(items) || items.length === 0 || items.length > 1000) return err('items 需 1..1000 条');
	const data = load(collection);
	for (const it of items) {
		if (!validVector(it.vector)) return err(`条目 ${it.id} 的 vector 非法(1..${MAX_DIM} 维有限数值)`);
		if (data.dim === null) data.dim = it.vector.length;
		if (it.vector.length !== data.dim) return err(`维度不一致:集合是 ${data.dim} 维,条目 ${it.id} 是 ${it.vector.length} 维`);
	}
	const byId = new Map(data.items.map((x) => [x.id, x]));
	for (const it of items) byId.set(String(it.id), { id: String(it.id), vector: it.vector, ...(it.text !== undefined ? { text: it.text } : {}), ...(it.meta !== undefined ? { meta: it.meta } : {}) });
	data.items = [...byId.values()];
	if (data.items.length > MAX_ITEMS) return err(`集合超过 ${MAX_ITEMS} 条上限——本零件是轻量本地索引,更大规模请上专用向量库`);
	save(collection, data);
	return text({ collection, added: items.length, total: data.items.length, dim: data.dim });
});

server.registerTool('vector-search', {
	description: '按查询向量做余弦相似检索,返回 topK 命中(id/score/原文/元数据;不回原向量)。维度不匹配会明确报错而不是给出无意义的分数。',
	inputSchema: {
		collection: z.string(),
		vector: z.array(z.number()).describe('查询向量(维度须与集合一致)'),
		topK: z.number().optional().describe('返回条数,默认 5,上限 100'),
		minScore: z.number().optional().describe('相似度下限(-1..1),低于它的命中丢弃'),
	},
}, async ({ collection, vector, topK, minScore }) => {
	const out = search(collection, vector, topK, minScore);
	return out.error !== undefined ? err(out.error) : text(out);
});

server.registerTool('vector-delete', {
	description: '按 id 删除条目,或整集合删除(dropCollection=true)。',
	inputSchema: {
		collection: z.string(),
		ids: z.array(z.string()).optional(),
		dropCollection: z.boolean().optional(),
	},
}, async ({ collection, ids, dropCollection }) => {
	const f = fileOf(collection);
	if (f === null) return err(`非法集合名:${collection}`);
	if (dropCollection === true) {
		if (existsSync(f)) rmSync(f);
		return text({ dropped: collection });
	}
	if (!Array.isArray(ids) || ids.length === 0) return err('给 ids 或 dropCollection:true');
	const data = load(collection);
	const before = data.items.length;
	const drop = new Set(ids.map(String));
	data.items = data.items.filter((x) => !drop.has(x.id));
	save(collection, data);
	return text({ collection, deleted: before - data.items.length, total: data.items.length });
});

await server.connect(new StdioServerTransport());
