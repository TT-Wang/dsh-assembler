#!/usr/bin/env node
/**
 * MCP stdio server: JWT 解码/验签工具,基于 jose@6。
 * 能力点:不验签快速解码看内容、HS256 共享密钥验签——agent 排查登录态、
 * 检查 token 过期、核对签名,一轮内完成。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';

const server = new McpServer({ name: 'jwt-decode', version: '0.0.1' });

const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });
const ok = (text) => ({ content: [{ type: 'text', text }] });

/** 把 exp/iat/nbf 对照当前时间翻译成人话。 */
const describeTimeClaims = (payload) => {
  const now = Math.floor(Date.now() / 1000);
  const rel = (s) => {
    const d = Math.abs(now - s);
    if (d >= 86400) return `${Math.round(d / 86400)} 天`;
    if (d >= 3600) return `${Math.round(d / 3600)} 小时`;
    if (d >= 60) return `${Math.round(d / 60)} 分钟`;
    return `${d} 秒`;
  };
  const iso = (s) => new Date(s * 1000).toISOString();
  const lines = [];
  if (typeof payload.exp === 'number') {
    lines.push(payload.exp > now
      ? `exp=${iso(payload.exp)}:未过期,距过期还有 ${rel(payload.exp)}`
      : `exp=${iso(payload.exp)}:已过期 ${rel(payload.exp)}`);
  } else {
    lines.push('exp 缺失:token 不声明过期时间');
  }
  if (typeof payload.iat === 'number') {
    lines.push(payload.iat <= now
      ? `iat=${iso(payload.iat)}:签发于 ${rel(payload.iat)} 前`
      : `iat=${iso(payload.iat)}:签发时间在未来(签发方时钟可疑)`);
  }
  if (typeof payload.nbf === 'number') {
    lines.push(payload.nbf <= now
      ? `nbf=${iso(payload.nbf)}:已生效`
      : `nbf=${iso(payload.nbf)}:尚未生效,还要等 ${rel(payload.nbf)}`);
  }
  return lines.join('\n');
};

server.registerTool('decode-jwt', {
  description:
    '解码 JWT 字符串,返回 header 与 payload 的 JSON,并把 exp/iat/nbf 对照当前时间'
    + '给出人话说明(是否过期/是否生效)。**只解码不验签**:未验证签名,内容可被伪造,'
    + '不可信作授权依据;要验签用 verify-jwt-hs256。格式非法(不是三段 base64url 的 JWS)返回错误。',
  inputSchema: {
    token: z.string().describe('JWT 字符串(compact JWS 三段式,形如 xxx.yyy.zzz)'),
  },
}, async ({ token }) => {
  let header;
  let payload;
  try {
    header = decodeProtectedHeader(token);
    payload = decodeJwt(token);
  } catch (err) {
    return fail(`decode-jwt: token 格式非法,无法解码:${err?.message ?? err}`);
  }
  const text = [
    `header: ${JSON.stringify(header, null, 2)}`,
    `payload: ${JSON.stringify(payload, null, 2)}`,
    '时间状态:',
    describeTimeClaims(payload),
    '注意:以上内容仅解码得出,未验证签名,不可信作授权依据。',
  ].join('\n');
  return ok(text);
});

server.registerTool('verify-jwt-hs256', {
  description:
    '用共享密钥(HS256 对称算法)验证 JWT 签名,返回验签结果与 payload 的 JSON。'
    + '签名不匹配/已过期等验证失败返回结构化 { valid: false, reason } 而不是错误;'
    + 'alg 不是 HS256 的 token 会说明不支持;token 本身格式非法才返回错误。仅支持 HS256。',
  inputSchema: {
    token: z.string().describe('JWT 字符串(compact JWS 三段式)'),
    secret: z.string().describe('HS256 共享密钥(UTF-8 文本)'),
  },
}, async ({ token, secret }) => {
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch (err) {
    return fail(`verify-jwt-hs256: token 格式非法,无法解析:${err?.message ?? err}`);
  }
  if (header.alg !== 'HS256') {
    return ok(JSON.stringify({
      valid: false,
      reason: `不支持的算法:该 token 的 alg=${header.alg ?? '(缺失)'},本工具仅支持 HS256 对称密钥验签`,
    }, null, 2));
  }
  try {
    const { payload, protectedHeader } = await jwtVerify(
      token,
      new TextEncoder().encode(secret),
      { algorithms: ['HS256'] },
    );
    return ok(JSON.stringify({ valid: true, protectedHeader, payload }, null, 2));
  } catch (err) {
    if (err?.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
      return ok(JSON.stringify({ valid: false, reason: '签名不匹配:密钥不对或 token 被篡改' }, null, 2));
    }
    if (err?.code === 'ERR_JWT_EXPIRED' || err?.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      return ok(JSON.stringify({ valid: false, reason: `签名验证之外的声明校验失败:${err.message}` }, null, 2));
    }
    return fail(`verify-jwt-hs256: 无法验证该 token:${err?.message ?? err}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
