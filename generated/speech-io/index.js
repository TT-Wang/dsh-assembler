#!/usr/bin/env node
/**
 * speech-io — 语音进出(读书助手静默降级实测过的缺口:判断器域整块缺失)。
 *
 * 两个方向,两种凭证形态,一张服务脸:
 *   speak      文本 → mp3 字节。上游 node-edge-tts(微软 Edge 在线 TTS,**无需凭证**)
 *   transcribe 音频 → 文本。上游 OpenAI 兼容 /audio/transcriptions(凭证契约:
 *              未配 SPEECH_API_KEY 时零件照常起、listTools 成功、调用返回可行动错误)
 *
 * **为什么必须有服务脸**:音频是大字节。让模型转述 base64 是物理性错误(读书助手
 * 816s 判负的同一根病)。页面/程序经服务脸直取 mp3、直传录音,字节不过模型;
 * 工具面只交换"路径与文本"。
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { EdgeTTS } from 'node-edge-tts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PART_WORKDIR = process.env.PART_WORKDIR || process.cwd();
const AUDIO_DIR = resolve(PART_WORKDIR, 'audio');
const ASR_BASE = process.env.SPEECH_API_BASE || 'https://api.openai.com/v1';
const ASR_MODEL = process.env.SPEECH_ASR_MODEL || 'whisper-1';
const TOKEN = randomBytes(16).toString('hex');
const MAX_TEXT = 8000;
const MAX_AUDIO = 32 * 1024 * 1024;
mkdirSync(AUDIO_DIR, { recursive: true });

const server = new McpServer({ name: 'speech-io', version: '0.0.1' });
const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const err = (msg) => ({ isError: true, content: [{ type: 'text', text: `speech-io: ${msg}` }] });

function safeAudio(name) {
	const base = basename(String(name ?? ''));
	if (base === '' || base !== String(name) || base.startsWith('.')) return null;
	const t = resolve(AUDIO_DIR, base);
	return t === join(AUDIO_DIR, base) ? t : null;
}

/** 合成(工具面与服务脸共用):文本 → mp3 落盘,返回路径与字节数。 */
async function synth({ text: t, voice, rate, name }) {
	if (typeof t !== 'string' || t.trim() === '') return { error: 'text 不能为空' };
	if (t.length > MAX_TEXT) return { error: `text ${t.length} 字符 > ${MAX_TEXT}(长文请分段)` };
	const outName = name !== undefined && name !== '' ? name : `tts-${Date.now()}.mp3`;
	const target = safeAudio(outName);
	if (target === null) return { error: `非法文件名:${outName}` };
	try {
		const tts = new EdgeTTS({
			voice: typeof voice === 'string' && voice !== '' ? voice : 'zh-CN-XiaoxiaoNeural',
			...(typeof rate === 'string' && rate !== '' ? { rate } : {}),
		});
		await tts.ttsPromise(t, target);
		if (!existsSync(target) || statSync(target).size === 0) return { error: '合成产出空文件(上游异常)' };
		return { name: basename(target), path: target, bytes: statSync(target).size, voice: tts.voice ?? voice ?? 'zh-CN-XiaoxiaoNeural' };
	} catch (e) {
		return { error: `合成失败:${String(e && e.message || e).slice(0, 200)}` };
	}
}

/** 转写(工具面与服务脸共用):音频文件 → 文本。凭证走 env,值不进参数/日志。 */
async function transcribe({ path: p, language }) {
	const key = process.env.SPEECH_API_KEY || '';
	if (key === '') {
		return { error: '进程环境缺 SPEECH_API_KEY(host 或 .env 提供;密钥不走参数)。TTS(speak)不需要凭证,可照常使用。' };
	}
	if (!existsSync(p)) return { error: `音频文件不存在:${p}` };
	const size = statSync(p).size;
	if (size > MAX_AUDIO) return { error: `音频 ${size} 字节 > 32MB` };
	try {
		const form = new FormData();
		form.append('file', new Blob([readFileSync(p)]), basename(p));
		form.append('model', ASR_MODEL);
		if (typeof language === 'string' && language !== '') form.append('language', language);
		const res = await fetch(`${ASR_BASE}/audio/transcriptions`, {
			method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
			signal: AbortSignal.timeout(180000),
		});
		if (!res.ok) return { error: `上游 HTTP ${res.status}:${(await res.text()).slice(0, 200)}` };
		const j = await res.json();
		return { text: String(j.text ?? ''), model: ASR_MODEL, bytes: size };
	} catch (e) {
		return { error: `转写失败:${String(e && e.message || e).slice(0, 200)}` };
	}
}

// ── 服务脸(音频字节的唯一正确通道)──────────────────────────────────────────
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
	const url = new URL(req.url ?? '/', 'http://local');
	const p = url.pathname;

	// GET /speak?text=…&voice=… → 直接回 mp3 字节(页面 <audio> 可直接播)
	if (req.method === 'GET' && p === '/speak') {
		(async () => {
			const out = await synth({ text: url.searchParams.get('text') ?? '', voice: url.searchParams.get('voice') ?? undefined });
			if (out.error !== undefined) return json(400, { error: out.error });
			cors();
			res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': out.bytes, 'x-audio-path': out.path });
			createReadStream(out.path).pipe(res);
		})();
		return;
	}
	// GET /audio/<name> → 取回既有音频
	if (req.method === 'GET' && p.startsWith('/audio/')) {
		const t = safeAudio(decodeURIComponent(p.slice('/audio/'.length)));
		if (t === null || !existsSync(t)) return json(404, { error: '音频不存在' });
		cors();
		res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': statSync(t).size });
		res.end(readFileSync(t));
		return;
	}
	// POST /transcribe/<name> → 直传录音字节,落盘后转写(字节不过模型)
	if (req.method === 'POST' && p.startsWith('/transcribe/')) {
		const t = safeAudio(decodeURIComponent(p.slice('/transcribe/'.length)));
		if (t === null) return json(400, { error: '非法文件名' });
		const chunks = [];
		let bytes = 0;
		req.on('data', (d) => { bytes += d.length; if (bytes > MAX_AUDIO) req.destroy(); else chunks.push(d); });
		req.on('end', async () => {
			writeFileSync(t, Buffer.concat(chunks));
			const out = await transcribe({ path: t, language: url.searchParams.get('language') ?? undefined });
			return out.error !== undefined ? json(400, { ...out, savedTo: t, bytes }) : json(200, { ...out, savedTo: t });
		});
		return;
	}
	return json(404, { error: 'GET /speak?text= · GET /audio/<name> · POST /transcribe/<name>' });
});
face.listen(0, '127.0.0.1');
face.unref();
const port = await new Promise((r) => face.once('listening', () => r(face.address().port)));
const FACE_URL = `http://127.0.0.1:${port}`;

try {
	const svcPath = join(PART_WORKDIR, '.service.json');
	const existing = existsSync(svcPath) ? JSON.parse(readFileSync(svcPath, 'utf8')) : {};
	existing.speech = { url: FACE_URL, token: TOKEN, dir: AUDIO_DIR, pid: process.pid, startedAt: new Date().toISOString() };
	writeFileSync(svcPath, JSON.stringify(existing, null, 2));
} catch { /* 档案写不进不拦工具面 */ }

// ── 工具面 ────────────────────────────────────────────────────────────────────
server.registerTool('speech-info', {
	description: '语音直连端点(服务脸):GET /speak?text=…(回 mp3 字节,页面可直接播)· GET /audio/<name> · POST /transcribe/<name>(直传录音)。**音频字节走这条,不要让模型转述 base64**。同时报告 TTS/ASR 各自的凭证状态。',
	inputSchema: {},
}, async () => text({
	url: FACE_URL, token: TOKEN, dir: AUDIO_DIR,
	tts: { provider: 'edge', credential: 'none' },
	asr: { provider: ASR_BASE, model: ASR_MODEL, credential: process.env.SPEECH_API_KEY ? 'configured' : 'missing:SPEECH_API_KEY' },
	endpoints: ['GET /speak?text=&voice=', 'GET /audio/<name>', 'POST /transcribe/<name>'],
}));

server.registerTool('speak', {
	description: '文本转语音:合成 mp3 落到工作区 audio/,返回路径与字节数(**不返回音频内容**——字节请用服务脸取)。无需凭证。voice 例:zh-CN-XiaoxiaoNeural(女)/zh-CN-YunxiNeural(男)/en-US-AriaNeural。',
	inputSchema: {
		text: z.string().describe('要朗读的文本(≤8000 字符)'),
		voice: z.string().optional().describe('音色,默认 zh-CN-XiaoxiaoNeural'),
		rate: z.string().optional().describe('语速,如 +10% / -20%'),
		name: z.string().optional().describe('输出文件名(默认 tts-<时间戳>.mp3)'),
	},
}, async (a) => {
	const out = await synth(a);
	return out.error !== undefined ? err(out.error) : text(out);
});

server.registerTool('transcribe', {
	description: '语音转文本:读工作区里的音频文件,返回转写文本。凭证走进程环境 SPEECH_API_KEY(OpenAI 兼容 /audio/transcriptions;SPEECH_API_BASE/SPEECH_ASR_MODEL 可换端点与模型)。未配凭证时返回可行动错误,不崩。',
	inputSchema: {
		path: z.string().describe('音频文件绝对路径(可来自 speak 的返回或服务脸直传)'),
		language: z.string().optional().describe('语言提示,如 zh / en'),
	},
}, async (a) => {
	const out = await transcribe(a);
	return out.error !== undefined ? err(out.error) : text(out);
});

server.registerTool('delete-audio', {
	description: '删除工作区 audio/ 下的一个音频文件。',
	inputSchema: { name: z.string() },
}, async ({ name }) => {
	const t = safeAudio(name);
	if (t === null) return err('非法文件名');
	if (!existsSync(t)) return err(`音频不存在:${name}`);
	unlinkSync(t);
	return text({ deleted: basename(t) });
});

await server.connect(new StdioServerTransport());
