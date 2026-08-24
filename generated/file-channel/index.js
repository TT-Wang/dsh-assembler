#!/usr/bin/env node
/**
 * file-channel — 公共文件通道(零件分类法欠账②:17 件字节口零件共享一张脸)。
 *
 * 病根:解析/生成类零件(pdf-extract/docx-generate/zip-archive/excel…)的工具面
 * 本来就是"路径进路径出",字节从不过模型;页面缺的只是"把文件放进工作区/取出来"
 * 那一小段。book-intake 为读书助手证明了直传通道可行(base64 过模型必坏,
 * 18s vs 物理不可行),这里把它泛化成通用件:一张脸治全体。
 *
 * 面:
 *   工具面  file-channel-info(发现端点)· list-files · read-text · delete-file
 *   服务脸  POST /upload/<name>(原始字节)· GET /file/<name> · GET /list
 * 安全:一切路径锚定 PART_WORKDIR/files,穿越拒绝;127.0.0.1 随机口 + 随机 token;
 * 单文件 ≤64MB;服务脸 unref(stdio 关闭即退场)。
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PART_WORKDIR = process.env.PART_WORKDIR || process.cwd();
const FILES_DIR = resolve(PART_WORKDIR, 'files');
const MAX_BYTES = 64 * 1024 * 1024;
const TOKEN = randomBytes(16).toString('hex');
mkdirSync(FILES_DIR, { recursive: true });

const server = new McpServer({ name: 'file-channel', version: '0.0.1' });
const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const err = (msg) => ({ isError: true, content: [{ type: 'text', text: `file-channel: ${msg}` }] });

/** 锚定解析:只允许 FILES_DIR 下的裸文件名(穿越/子目录一律拒)。 */
function safeTarget(name) {
	const base = basename(String(name ?? ''));
	if (base === '' || base === '.' || base === '..' || base !== String(name)) return null;
	const target = resolve(FILES_DIR, base);
	if (target !== join(FILES_DIR, base)) return null;
	return target;
}

function listing() {
	return readdirSync(FILES_DIR, { withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => {
			const st = statSync(join(FILES_DIR, e.name));
			return { name: e.name, bytes: st.size, modifiedAt: st.mtime.toISOString() };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

// ── 服务脸 ────────────────────────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
	const cors = () => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Service-Token');
	};
	const json = (code, obj) => { cors(); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
	if (req.method === 'OPTIONS') { cors(); res.writeHead(204); res.end(); return; }
	if (req.headers['x-service-token'] !== TOKEN) return json(401, { error: 'bad or missing X-Service-Token' });
	const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);

	if (req.method === 'GET' && pathname === '/list') return json(200, { files: listing(), dir: FILES_DIR });

	if (req.method === 'POST' && pathname.startsWith('/upload/')) {
		const target = safeTarget(pathname.slice('/upload/'.length));
		if (target === null) return json(400, { error: '非法文件名(只收锚定目录下的裸文件名)' });
		let bytes = 0;
		const out = createWriteStream(target);
		req.on('data', (d) => {
			bytes += d.length;
			if (bytes > MAX_BYTES) { req.destroy(); out.destroy(); try { rmSync(target, { force: true }); } catch {} }
		});
		req.pipe(out);
		out.on('finish', () => json(200, { ok: true, name: basename(target), path: target, bytes }));
		out.on('error', (e) => json(500, { error: String(e.message) }));
		return;
	}

	if (req.method === 'GET' && pathname.startsWith('/file/')) {
		const target = safeTarget(pathname.slice('/file/'.length));
		if (target === null || !existsSync(target)) return json(404, { error: '文件不存在' });
		cors();
		res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': statSync(target).size });
		res.end(readFileSync(target));
		return;
	}
	return json(404, { error: 'GET /list · POST /upload/<name> · GET /file/<name>' });
});
httpServer.listen(0, '127.0.0.1');
httpServer.unref(); // 质检门契约:stdio 关闭进程必须退场
const port = await new Promise((r) => httpServer.once('listening', () => r(httpServer.address().port)));
const FACE_URL = `http://127.0.0.1:${port}`;

try {
	const svcPath = join(PART_WORKDIR, '.service.json');
	const existing = existsSync(svcPath) ? JSON.parse(readFileSync(svcPath, 'utf8')) : {};
	existing.files = { url: FACE_URL, token: TOKEN, dir: FILES_DIR, pid: process.pid, startedAt: new Date().toISOString() };
	writeFileSync(svcPath, JSON.stringify(existing, null, 2));
} catch { /* 档案写不进不拦工具面 */ }

// ── 工具面 ────────────────────────────────────────────────────────────────────
server.registerTool('file-channel-info', {
	description: '公共文件通道:返回直连端点(服务脸)与落盘目录。页面/程序经 POST /upload/<name> 直传字节、GET /file/<name> 取回、GET /list 列目录——**大文件不经模型**。落盘路径可直接交给解析/生成类零件(它们都是路径进路径出)。',
	inputSchema: {},
}, async () => text({ url: FACE_URL, token: TOKEN, dir: FILES_DIR, endpoints: ['POST /upload/<name>', 'GET /file/<name>', 'GET /list'] }));

server.registerTool('list-files', {
	description: '列出通道目录里的文件(名字/字节数/修改时间)。把某个文件交给解析零件时,用返回的 path。',
	inputSchema: {},
}, async () => text({ dir: FILES_DIR, files: listing() }));

server.registerTool('read-text', {
	description: '按名读取通道里的文本文件(≤1MB;二进制/超大文件请把 path 交给对应解析零件,不要过模型)。',
	inputSchema: { name: z.string().describe('文件名(通道目录下的裸文件名)') },
}, async ({ name }) => {
	const target = safeTarget(name);
	if (target === null) return err('非法文件名');
	if (!existsSync(target)) return err(`文件不存在:${name}`);
	const size = statSync(target).size;
	if (size > 1024 * 1024) return err(`文件 ${size} 字节 > 1MB:把路径 ${target} 交给解析零件,别过模型`);
	return { content: [{ type: 'text', text: readFileSync(target, 'utf8') }] };
});

server.registerTool('delete-file', {
	description: '删除通道里的一个文件(仅限通道目录内)。',
	inputSchema: { name: z.string() },
}, async ({ name }) => {
	const target = safeTarget(name);
	if (target === null) return err('非法文件名');
	if (!existsSync(target)) return err(`文件不存在:${name}`);
	rmSync(target, { force: true });
	return text({ deleted: basename(target), remaining: listing().length });
});

await server.connect(new StdioServerTransport());
