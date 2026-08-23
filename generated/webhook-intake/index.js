#!/usr/bin/env node
/**
 * webhook-intake — trigger 类零件(n8n 课:无人值守 agent 的入口件)。
 *
 * 本机起一个 HTTP 接收口(127.0.0.1 随机端口):外部系统 POST /hook/<name>
 * 即落一条事件进工作区 webhooks/events.jsonl;agent 用 webhook-poll 拉取新
 * 事件处理。这是"事件驱动泛化 agent"的最小闭环:接收不经模型(字节直落盘),
 * 处理才用模型。
 *
 * Safety:只绑 127.0.0.1;事件体上限 256KB;落盘锚定 PART_WORKDIR,路径只有
 * 追加一个固定文件,无穿越面。质检门契约:stdio 关闭进程退场(listener unref)。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PART_WORKDIR = process.env.PART_WORKDIR || process.cwd();
const DIR = resolve(PART_WORKDIR, 'webhooks');
const FILE = resolve(DIR, 'events.jsonl');
const MAX_BODY = 256 * 1024;
let nextId = 1;
try {
  if (existsSync(FILE)) {
    const lines = readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean);
    const last = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
    if (last && Number.isFinite(last.id)) nextId = last.id + 1;
  }
} catch { /* 损坏的账本从 1 重计,旧行仍在文件里可人工查 */ }

const httpServer = createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'OPTIONS') return send(204, {});
  const m = /^\/hook\/([A-Za-z0-9_-]{1,64})$/.exec(req.url ? req.url.split('?')[0] : '');
  if (req.method !== 'POST' || m === null) return send(404, { ok: false, error: 'POST /hook/<name>' });
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (size > MAX_BODY) return send(413, { ok: false, error: 'body too large' });
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = raw;
    try { body = JSON.parse(raw); } catch { /* 非 JSON 原文入档 */ }
    const event = { id: nextId++, hook: m[1], at: new Date().toISOString(), body };
    try {
      mkdirSync(DIR, { recursive: true });
      appendFileSync(FILE, JSON.stringify(event) + '\n');
    } catch (e) {
      return send(500, { ok: false, error: String(e && e.message || e) });
    }
    send(200, { ok: true, id: event.id });
  });
});
httpServer.listen(0, '127.0.0.1');
httpServer.unref(); // 质检门契约:stdio 关闭进程必须退场,常驻监听不得钉住进程
let httpPort = 0;
httpServer.on('listening', () => { httpPort = httpServer.address().port; });

const server = new McpServer({ name: 'webhook-intake', version: '0.0.1' });

server.registerTool('webhook-info', {
  description:
    '返回本会话的 webhook 接收服务信息:外部系统把事件 POST 到 url + <钩子名>'
    + '(body 为 JSON 或任意文本,≤256KB),事件带自增 id 落盘工作区 webhooks/events.jsonl。'
    + 'agent 之后用 webhook-poll 拉取处理——接收不经模型,处理才用模型。',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: JSON.stringify({
    url: `http://127.0.0.1:${httpPort}/hook/`,
    method: 'POST',
    note: '事件文件:webhooks/events.jsonl;用 webhook-poll {afterId} 增量拉取',
  }) }],
}));

server.registerTool('webhook-poll', {
  description: '增量拉取已接收的 webhook 事件:返回 id > afterId 的事件(默认从头,limit 默认 20,最大 100)。',
  inputSchema: {
    afterId: z.number().optional().describe('只取 id 大于此值的事件;缺省 0'),
    limit: z.number().optional().describe('最多返回条数,默认 20'),
  },
}, async ({ afterId, limit }) => {
  const after = Number.isFinite(afterId) ? afterId : 0;
  const cap = Math.max(1, Math.min(100, Number.isFinite(limit) ? limit : 20));
  let events = [];
  try {
    if (existsSync(FILE)) {
      events = readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e !== null && e.id > after)
        .slice(0, cap);
    }
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `webhook-poll: ${String(e && e.message || e)}` }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ count: events.length, lastId: events.length > 0 ? events[events.length - 1].id : after, events }) }] };
});

server.registerTool('webhook-clear', {
  description: '清空已接收的事件账本(处理完毕归档后使用;清空不可逆)。',
  inputSchema: {},
}, async () => {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE, '');
    nextId = 1;
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `webhook-clear: ${String(e && e.message || e)}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
