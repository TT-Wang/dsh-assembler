/**
 * mcp-apns-push — iPhone 原生推送发送器(真 APNs 直连 + Bark 中转双通道)
 *
 * 凭证一律从进程环境变量读取,绝不接受参数传密钥:
 *   APNS_TEAM_ID / APNS_KEY_ID / APNS_AUTH_KEY(.p8 PEM 内容) / APNS_BUNDLE_ID / APNS_DEVICE_TOKEN
 *   BARK_KEY / BARK_SERVER(可选,默认 https://api.day.app)
 *
 * APNs 通道:node:http2 直连 api.push.apple.com,ES256 JWT 签名(带 50 分钟缓存),
 *   回执如实返回:200 = Apple 已接收下发;4xx/410 = Apple 给出的 reason。
 * Bark 通道:POST {base}/push,经 Bark iOS App 走 APNs 送达锁屏。
 * 绝不假装投递成功——所有结果原样返回。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import crypto from 'node:crypto';
import http2 from 'node:http2';

const APNS_HOST = 'https://api.push.apple.com:443';

/* ---------- ES256 JWT with 50-min cache (Apple rate-limits token creation) ---------- */
let jwtCache = null;

function signApnsJwt(teamId, keyId, p8Pem) {
  const iat = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: teamId, iat })).toString('base64url');
  const sign = crypto.createSign('sha256');
  sign.update(`${header}.${claims}`);
  sign.end();
  const sig = sign.sign(p8Pem).toString('base64url');
  return { jwt: `${header}.${claims}.${sig}`, iat };
}

function getJwt(teamId, keyId, p8Pem) {
  if (jwtCache && Date.now() / 1000 - jwtCache.iat < 50 * 60) return jwtCache.jwt;
  jwtCache = signApnsJwt(teamId, keyId, p8Pem);
  return jwtCache.jwt;
}

/* ---------- APNs HTTP/2 send ---------- */
function apnsSend({ token, bundleId, jwt, payload, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(APNS_HOST);
    let settled = false;
    const done = (err, res) => {
      if (settled) return;
      settled = true;
      try { client.close(); } catch {}
      err ? reject(err) : resolve(res);
    };
    const timer = setTimeout(() => {
      try { client.close(); } catch {}
      done(new Error(`APNs request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    client.on('error', (e) => { clearTimeout(timer); done(e); });
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${encodeURIComponent(token)}`,
      'apns-topic': bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': '0',
      'authorization': `bearer ${jwt}`,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
    });
    let raw = '';
    let status = null;
    req.on('response', (headers) => { status = headers[':status']; });
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch {}
      done(null, { status, body: parsed, raw: raw.slice(0, 500) });
    });
    req.on('error', (e) => { clearTimeout(timer); done(e); });
    req.end(payload);
  });
}

/* ---------- Bark relay send ---------- */
async function barkSend({ key, title, body, sound, group, url, server, timeoutMs }) {
  const base = (server || 'https://api.day.app').replace(/\/+$/, '');
  const payload = { device_key: key, title, body, sound: sound || 'default' };
  if (group) payload.group = group;
  if (url) payload.url = url;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${base}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    let parsed = null;
    try { parsed = await resp.json(); } catch {}
    return { status: resp.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- config introspection (names only, never values) ---------- */
function envVal(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : '';
}

function configStatus() {
  const apnsMissing = [];
  for (const k of ['APNS_TEAM_ID', 'APNS_KEY_ID', 'APNS_AUTH_KEY', 'APNS_BUNDLE_ID', 'APNS_DEVICE_TOKEN']) {
    if (!envVal(k)) apnsMissing.push(k);
  }
  const barkMissing = envVal('BARK_KEY') ? [] : ['BARK_KEY'];
  return {
    apns: { configured: apnsMissing.length === 0, missing: apnsMissing },
    bark: { configured: barkMissing.length === 0, missing: barkMissing },
  };
}

/* ---------- tools ---------- */
const TOOLS = [
  {
    name: 'push-send',
    description:
      'Send an iPhone push notification. channel=apns sends directly to Apple Push Notification service ' +
      '(HTTP/2 + ES256 JWT; requires APNS_TEAM_ID, APNS_KEY_ID, APNS_AUTH_KEY, APNS_BUNDLE_ID, APNS_DEVICE_TOKEN env). ' +
      'channel=bark relays through the Bark iOS app (APNs delivery, requires BARK_KEY env). ' +
      'auto prefers apns when configured, else bark. Returns Apple/Bark response verbatim — never fabricates delivery.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Notification title (short).' },
        body: { type: 'string', description: 'Notification body.' },
        channel: { type: 'string', enum: ['auto', 'apns', 'bark'], default: 'auto', description: 'Delivery channel.' },
        sound: { type: 'string', default: 'default', description: 'Alert sound name.' },
        badge: { type: 'integer', description: 'App badge number (APNs only).' },
        group: { type: 'string', description: 'Bark grouping key.' },
        url: { type: 'string', description: 'URL opened on tap (Bark only).' },
        timeout_ms: { type: 'integer', default: 10000, description: 'Network timeout in ms (max 30000).' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'push-config-status',
    description:
      'Report whether the APNs / Bark push channels are configured. Lists ONLY the names of missing environment ' +
      'variables (never their values). Use before sending when delivery matters.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function handleCallTool(name, args) {
  if (name === 'push-config-status') {
    const st = configStatus();
    const defaultChannel = st.apns.configured ? 'apns' : st.bark.configured ? 'bark' : 'none';
    return { content: [{ type: 'text', text: JSON.stringify({ ...st, defaultChannel }, null, 2) }] };
  }

  if (name === 'push-send') {
    const title = String(args.title ?? '').trim();
    const body = String(args.body ?? '').trim();
    if (!title || !body) {
      return { isError: true, content: [{ type: 'text', text: 'title and body are required' }] };
    }
    const channel = args.channel || 'auto';
    const timeoutMs = Math.min(Number(args.timeout_ms) || 10000, 30000);
    const st = configStatus();

    if (channel === 'apns' && !st.apns.configured) {
      return { isError: true, content: [{ type: 'text', text: `APNs channel not configured. Set env vars: ${st.apns.missing.join(', ')}` }] };
    }
    if (channel === 'bark' && !st.bark.configured) {
      return { isError: true, content: [{ type: 'text', text: 'Bark channel not configured. Set env var: BARK_KEY' }] };
    }
    if (channel === 'auto' && !st.apns.configured && !st.bark.configured) {
      return { isError: true, content: [{ type: 'text', text: `No push channel configured. APNs missing: ${st.apns.missing.join(', ')}; Bark missing: ${st.bark.missing.join(', ')}` }] };
    }
    const useApns = channel === 'apns' || (channel === 'auto' && st.apns.configured);

    try {
      if (useApns) {
        const jwt = getJwt(envVal('APNS_TEAM_ID'), envVal('APNS_KEY_ID'), envVal('APNS_AUTH_KEY'));
        const aps = { alert: { title, body }, sound: args.sound || 'default' };
        if (args.badge != null) aps.badge = Number(args.badge);
        const payload = JSON.stringify({ aps });
        const res = await apnsSend({
          token: envVal('APNS_DEVICE_TOKEN'),
          bundleId: envVal('APNS_BUNDLE_ID'),
          jwt,
          payload,
          timeoutMs,
        });
        const delivered = res.status === 200;
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: delivered, channel: 'apns', apnsStatus: res.status, reason: (res.body && res.body.reason) || null, raw: res.raw }, null, 2) }],
        };
      }
      const res = await barkSend({
        key: envVal('BARK_KEY'),
        title,
        body,
        sound: args.sound,
        group: args.group,
        url: args.url,
        server: envVal('BARK_SERVER'),
        timeoutMs,
      });
      const delivered = res.body && res.body.code === 200;
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: delivered, channel: 'bark', httpStatus: res.status, code: (res.body && res.body.code) || null, message: (res.body && res.body.message) || null, raw: JSON.stringify(res.body).slice(0, 500) }, null, 2) }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `push-send failed: ${e && e.message ? e.message : String(e)}` }] };
    }
  }

  return { isError: true, content: [{ type: 'text', text: `unknown tool: ${name}` }] };
}

/* ---------- server ---------- */
const server = new Server({ name: 'mcp-apns-push', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => handleCallTool(req.params.name, req.params.arguments || {}));

const transport = new StdioServerTransport();
await server.connect(transport);

process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
