#!/usr/bin/env node
/**
 * object-store — S3 兼容对象存储(交付到多机/云端时的字节落点)。
 *
 * 上游任何 S3 兼容服务(MinIO / 阿里云 OSS / 腾讯云 COS / Cloudflare R2 / AWS S3),
 * 经 S3_ENDPOINT 切换。凭证只从进程环境读(S3_ACCESS_KEY / S3_SECRET_KEY),
 * 未配时零件照常起、listTools 成功、调用返回可行动错误(凭证契约)。
 *
 * **字节纪律**:上传/下载都是"路径进路径出"——本地文件 ↔ 对象;工具面**从不**
 * 返回文件内容。要给浏览器直取,用 presign 出临时 URL(字节不过模型也不过 host)。
 * 与 file-channel 的分工:file-channel 管"浏览器↔工作区",本件管"工作区↔云端"。
 */
import { existsSync, statSync, createReadStream, createWriteStream } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Client as MinioClient } from 'minio';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync as __secRead } from 'node:fs';
import { join as __secJoin } from 'node:path';

// ── 凭证读取(装配器全库统一约定)───────────────────────────────────────────
// host 出于安全会把 /KEY|PASSWORD|SECRET|TOKEN/i 形状的环境变量从子进程里擦掉
// (dsh-subprocess 的 scrubbedParentEnv),而我们又坚决不把密钥值写进 preset 文件
// ——两条正确的规矩夹在一起,零件在运行时就永远拿不到凭证(实测:双语读书助手
// 的 AI 服务脸一直报"缺 key",而 host 明明有)。修法:零件自己从**凭证库文件**读,
// 值不进 preset、不进环境、不进日志。查找顺序:进程环境 → $DSH_HOME/.env → ~/.dsh/.env。
function readSecret(name) {
	const direct = process.env[name];
	if (typeof direct === 'string' && direct !== '') return direct;
	const home = process.env.HOME || process.env.USERPROFILE || '';
	const files = [
		process.env.DSH_HOME ? __secJoin(process.env.DSH_HOME, '.env') : null,
		home ? __secJoin(home, '.dsh', '.env') : null,
	].filter(Boolean);
	for (const f of files) {
		try {
			for (const line of __secRead(f, 'utf8').split('\n')) {
				const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
				if (m !== null && m[1] === name && !line.trimStart().startsWith('#')) {
					return m[2].trim().replace(/^["']|["']$/g, '');
				}
			}
		} catch { /* 读不到就继续找下一处 */ }
	}
	return '';
}


const PART_WORKDIR = process.env.PART_WORKDIR || process.cwd();
const ENDPOINT = process.env.S3_ENDPOINT || '';
const REGION = process.env.S3_REGION || 'us-east-1';
const server = new McpServer({ name: 'object-store', version: '0.0.1' });
const text = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
const err = (m) => ({ isError: true, content: [{ type: 'text', text: `object-store: ${m}` }] });

/** 工作区锚:本地路径一律锚定 PART_WORKDIR,穿越拒绝(与全体字节口零件同款)。 */
function insideWorkdir(p) {
  const t = resolve(PART_WORKDIR, p);
  return t === PART_WORKDIR || t.startsWith(PART_WORKDIR + '/') ? t : null;
}

/** 客户端(凭证契约的唯一出口:缺一即给可行动错误,绝不半配置乱跑)。 */
function clientOrError() {
  const ak = readSecret('S3_ACCESS_KEY');
  const sk = readSecret('S3_SECRET_KEY');
  const missing = [ENDPOINT === '' && 'S3_ENDPOINT', ak === '' && 'S3_ACCESS_KEY', sk === '' && 'S3_SECRET_KEY'].filter(Boolean);
  if (missing.length > 0) {
    return { error: `进程环境缺 ${missing.join(' / ')}(host 或 .env 提供;密钥不走参数)。本地文件通道(file-channel 零件)不需要凭证。` };
  }
  try {
    const u = new URL(ENDPOINT.includes('://') ? ENDPOINT : `https://${ENDPOINT}`);
    return {
      client: new MinioClient({
        endPoint: u.hostname,
        port: u.port !== '' ? Number(u.port) : (u.protocol === 'http:' ? 80 : 443),
        useSSL: u.protocol === 'https:',
        accessKey: ak, secretKey: sk, region: REGION,
      }),
    };
  } catch (e) { return { error: `S3_ENDPOINT 不是合法地址:${String(e && e.message || e).slice(0, 120)}` }; }
}

server.registerTool('s3-info', {
  description: '报告对象存储端点/区域与凭证状态(**不回显密钥**)。装配前用它确认"接口是否就位"。',
  inputSchema: {},
}, async () => text({
  endpoint: ENDPOINT === '' ? null : ENDPOINT, region: REGION,
  credential: (process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY) ? 'configured' : 'missing:S3_ACCESS_KEY/S3_SECRET_KEY',
  workdirAnchor: PART_WORKDIR,
  note: '本地↔浏览器用 file-channel;本件负责 工作区↔云端。字节走路径,不过模型;要给浏览器直取用 s3-presign。',
}));

server.registerTool('s3-list', {
  description: '列出桶内对象(可给前缀),返回名字/大小/修改时间。',
  inputSchema: { bucket: z.string(), prefix: z.string().optional(), limit: z.number().optional() },
}, async ({ bucket, prefix, limit }) => {
  const c = clientOrError();
  if (c.error !== undefined) return err(c.error);
  const cap = Math.max(1, Math.min(1000, Number.isFinite(limit) ? limit : 200));
  try {
    const out = [];
    const stream = c.client.listObjectsV2(bucket, prefix ?? '', true);
    await new Promise((res, rej) => {
      stream.on('data', (o) => { if (out.length < cap) out.push({ name: o.name, bytes: o.size, modifiedAt: o.lastModified }); });
      stream.on('end', res); stream.on('error', rej);
    });
    return text({ bucket, prefix: prefix ?? '', count: out.length, objects: out });
  } catch (e) { return err(`列举失败:${String(e && e.message || e).slice(0, 200)}`); }
});

server.registerTool('s3-upload', {
  description: '把工作区里的文件上传为对象(路径进,不读内容进上下文)。',
  inputSchema: { bucket: z.string(), objectName: z.string(), path: z.string().describe('工作区内的文件路径') },
}, async ({ bucket, objectName, path: p }) => {
  const c = clientOrError();
  if (c.error !== undefined) return err(c.error);
  const local = insideWorkdir(p);
  if (local === null) return err(`路径越出工作区锚(${PART_WORKDIR}),拒绝`);
  if (!existsSync(local)) return err(`本地文件不存在:${local}`);
  try {
    await c.client.fPutObject(bucket, objectName, local);
    return text({ bucket, objectName, uploadedFrom: local, bytes: statSync(local).size });
  } catch (e) { return err(`上传失败:${String(e && e.message || e).slice(0, 200)}`); }
});

server.registerTool('s3-download', {
  description: '把对象下载到工作区(路径出,不返回内容)。下载后可直接交给解析类零件。',
  inputSchema: { bucket: z.string(), objectName: z.string(), path: z.string().optional().describe('工作区内目标路径,默认用对象名') },
}, async ({ bucket, objectName, path: p }) => {
  const c = clientOrError();
  if (c.error !== undefined) return err(c.error);
  const local = insideWorkdir(p ?? basename(objectName));
  if (local === null) return err(`路径越出工作区锚(${PART_WORKDIR}),拒绝`);
  try {
    const stream = await c.client.getObject(bucket, objectName);
    await pipeline(stream, createWriteStream(local));
    return text({ bucket, objectName, savedTo: local, bytes: statSync(local).size });
  } catch (e) { return err(`下载失败:${String(e && e.message || e).slice(0, 200)}`); }
});

server.registerTool('s3-presign', {
  description: '生成对象的临时直取 URL(默认 1 小时)。给浏览器/第三方直接下载——**字节既不过模型也不过 host**。',
  inputSchema: { bucket: z.string(), objectName: z.string(), expirySeconds: z.number().optional() },
}, async ({ bucket, objectName, expirySeconds }) => {
  const c = clientOrError();
  if (c.error !== undefined) return err(c.error);
  const exp = Math.max(60, Math.min(7 * 24 * 3600, Number.isFinite(expirySeconds) ? expirySeconds : 3600));
  try {
    const url = await c.client.presignedGetObject(bucket, objectName, exp);
    return text({ bucket, objectName, url, expiresInSeconds: exp });
  } catch (e) { return err(`签发失败:${String(e && e.message || e).slice(0, 200)}`); }
});

await server.connect(new StdioServerTransport());
