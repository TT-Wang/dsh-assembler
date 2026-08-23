#!/usr/bin/env node
/**
 * book-intake — first-party MCP stdio server + localhost HTTP upload endpoint.
 *
 * 解决两个目录缺口:
 *   1) 浏览器→工作区文件通道:模板上传契约把整本书 base64 塞进 prompt,要求
 *      LLM 逐字节重发长 base64 到工具参数(实测 2KB 即开始出错)。本零件在
 *      本地起一个 HTTP 上传口,浏览器把文件直接 POST 落盘到工作区 uploads/,
 *      agent 只拿到路径,全程不碰 base64。
 *   2) EPUB 路径式解析:zip 工具只吃 base64 参数,epub 没有路径直读解析器。
 *
 * Safety: 上传落盘与读取都锚定 PART_WORKDIR,路径穿越一律拒绝;HTTP 服务只
 * 绑 127.0.0.1 随机端口,仅供本机浏览器使用,带 CORS(供内联预览页直传)。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, sep, basename } from 'node:path';
import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';

const PART_WORKDIR = process.env.PART_WORKDIR || process.cwd();
const UPLOADS_DIR = resolve(PART_WORKDIR, 'uploads');

function insideRoot(root, target) {
  return target === root || target.startsWith(root + sep);
}

/* ── HTTP 上传口(随机端口,避免多 preset 并发撞口) ────────────────────── */
const uploads = [];
const httpServer = createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Filename',
    });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'OPTIONS') return send(204, { ok: true });
  if (req.method !== 'POST') return send(405, { ok: false, error: 'only POST' });
  if (req.url.split('?')[0] !== '/upload') return send(404, { ok: false, error: 'not found' });
  const q = new URLSearchParams(req.url.split('?')[1] || '');
  const rawName = decodeURIComponent(q.get('filename') || req.headers['x-filename'] || 'book.bin');
  const safeName = basename(rawName).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'book.bin';
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 256 * 1024 * 1024) { req.destroy(); send(413, { ok: false, error: 'too large (>256MB)' }); } chunks.push(c); });
  req.on('end', () => {
    try {
      mkdirSync(UPLOADS_DIR, { recursive: true });
      const target = resolve(UPLOADS_DIR, safeName);
      if (!insideRoot(PART_WORKDIR, target)) return send(400, { ok: false, error: 'bad filename' });
      writeFileSync(target, Buffer.concat(chunks));
      uploads.push({ name: safeName, path: target, bytes: size, at: new Date().toISOString() });
      send(200, { ok: true, path: target, name: safeName, bytes: size });
    } catch (e) {
      send(500, { ok: false, error: String(e && e.message || e) });
    }
  });
});
httpServer.listen(0, '127.0.0.1');
httpServer.unref(); // 质检门契约:stdio 关闭进程必须退场,常驻监听不得钉住进程
const httpPort = await new Promise((r) => httpServer.once('listening', () => r(httpServer.address().port)));

/* ── MCP 工具 ─────────────────────────────────────────────────────────── */
const server = new McpServer({ name: 'book-intake', version: '0.0.1' });

server.registerTool('upload-info', {
  description:
    '返回本会话的文件接收服务信息:浏览器可把书籍文件 POST 到 url(参数 filename 或 X-Filename 头给文件名,'
    + 'body 为文件原始字节),文件会落盘到工作区 uploads/ 目录,返回其路径。'
    + 'agent 拿到路径后即可用 extract-epub / extract-text-file / 其他路径式解析工具处理,全程无需传输 base64。',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: JSON.stringify({
    url: `http://127.0.0.1:${httpPort}/upload?filename=`,
    method: 'POST',
    body: '文件原始字节(直接 fetch body,不要包成 JSON)',
    note: '已上传 {count} 个文件,见 uploads 目录',
    uploads,
  }) }],
}));

server.registerTool('extract-epub', {
  description:
    '解析工作区内(或 uploads/ 下)的 EPUB 电子书文件:读 container.xml → content.opf 的 spine 顺序,'
    + '逐个提取 xhtml 章节为纯文本(标题取 h1/h2/h3,正文保留段落)。返回 {title, language, chapters:[{index,title,content}]}。'
    + '无 container.xml 的松散 zip 按条目名顺序取所有 xhtml/html 文件。',
  inputSchema: {
    path: z.string().describe('相对工作区的 epub 路径,如 uploads/xxx.epub'),
  },
}, async ({ path }) => {
  try {
    const target = resolve(PART_WORKDIR, path);
    if (!insideRoot(PART_WORKDIR, target)) return { isError: true, content: [{ type: 'text', text: `extract-epub: path escapes the workspace: ${path}` }] };
    if (!existsSync(target)) return { isError: true, content: [{ type: 'text', text: `extract-epub: file not found: ${path}` }] };
    const zip = new AdmZip(target);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    const byName = Object.fromEntries(entries.map((e) => [e.entryName, e]));
    const textOf = (name) => (byName[name] ? byName[name].getData().toString('utf8') : null);

    let opfPath = null;
    let title = '';
    let language = '';
    const container = textOf('META-INF/container.xml');
    if (container) {
      const $c = cheerio.load(container, { xmlMode: true });
      opfPath = $c('rootfile').attr('full-path') || null;
    }
    let spine = [];
    if (opfPath) {
      const opf = textOf(opfPath);
      if (opf) {
        const $o = cheerio.load(opf, { xmlMode: true });
        title = $o('dc\\:title').first().text().trim() || $o('title').first().text().trim();
        language = $o('dc\\:language').first().text().trim() || '';
        const manifest = {};
        $o('manifest > item').each((_, el) => {
          const $el = $o(el);
          manifest[$el.attr('id')] = $el.attr('href');
        });
        $o('spine > itemref').each((_, el) => {
          const ref = $o(el).attr('idref');
          const href = manifest[ref];
          if (href) spine.push(href);
        });
      }
    }
    if (spine.length === 0) {
      // 松散 zip:按名取所有 xhtml/html
      spine = entries.map((e) => e.entryName).filter((n) => /\.x?html?$/i.test(n)).sort();
    }
    const chapters = [];
    spine.forEach((href, i) => {
      const full = opfPath && !href.includes('/') ? (dirname(opfPath) + '/' + href).replace(/^\.\//, '') : href;
      const src = byName[full] ? byName[full].getData().toString('utf8')
        : byName[href] ? byName[href].getData().toString('utf8') : null;
      if (!src) return;
      const $ = cheerio.load(src, { xmlMode: true });
      const chapTitle = $('h1,h2,h3').first().text().trim() || `第 ${i + 1} 章`;
      const body = $('body').length ? $('body') : $.root();
      const paras = [];
      body.find('p,h1,h2,h3,h4,li,blockquote,div').each((_, el) => {
        const t = $(el).text().replace(/\s+/g, ' ').trim();
        if (t) paras.push(t);
      });
      if (paras.length === 0) paras.push(body.text().replace(/\s+/g, ' ').trim());
      chapters.push({ index: i, title: chapTitle, content: paras.join('\n\n') });
    });
    return { content: [{ type: 'text', text: JSON.stringify({ title, language, chapters }) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `extract-epub: ${String(e && e.message || e)}` }] };
  }
});

server.registerTool('extract-text-file', {
  description:
    '读取工作区内文本文件(书籍正文 txt/md 等),按指定编码解码为 UTF-8 返回。'
    + 'encoding 常用值:utf-8 / gbk / big5 / shift_jis(中文旧书常见 gbk/big5)。',
  inputSchema: {
    path: z.string().describe('相对工作区的文本文件路径,如 uploads/xxx.txt'),
    encoding: z.string().default('utf-8').describe('源文件编码,默认 utf-8'),
  },
}, async ({ path, encoding }) => {
  try {
    const target = resolve(PART_WORKDIR, path);
    if (!insideRoot(PART_WORKDIR, target)) return { isError: true, content: [{ type: 'text', text: `extract-text-file: path escapes the workspace: ${path}` }] };
    if (!existsSync(target)) return { isError: true, content: [{ type: 'text', text: `extract-text-file: file not found: ${path}` }] };
    const buf = readFileSync(target);
    const text = iconv.encodingExists(encoding) ? iconv.decode(buf, encoding) : buf.toString('utf8');
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `extract-text-file: ${String(e && e.message || e)}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
