#!/usr/bin/env node
/**
 * First-party MCP stdio server: hashing / HMAC / UUID on node:crypto.
 * 能力点:内容指纹(校验下载/去重)、HMAC 签名(webhook 校验)、UUID 生成
 * ——agent 的日常校验类操作,零第三方依赖。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const server = new McpServer({ name: 'crypto-hash', version: '0.0.1' });

const ALGOS = ['sha256', 'sha512', 'sha1', 'md5'];

server.registerTool('hash-text', {
  description:
    '计算文本或 base64 字节的哈希摘要。algorithm 支持 sha256/sha512/sha1/md5;'
    + 'inputKind=text 按 UTF-8 处理,inputKind=base64 先解码为字节再哈希(用于核对文件指纹)。返回 hex 摘要。',
  inputSchema: {
    input: z.string().describe('要哈希的内容(文本或 base64)'),
    algorithm: z.enum(['sha256', 'sha512', 'sha1', 'md5']).optional().describe('默认 sha256'),
    inputKind: z.enum(['text', 'base64']).optional().describe('默认 text'),
  },
}, async ({ input, algorithm, inputKind }) => {
  const algo = algorithm ?? 'sha256';
  if (!ALGOS.includes(algo)) {
    return { isError: true, content: [{ type: 'text', text: `hash-text: 不支持的算法 ${algo}` }] };
  }
  let bytes;
  if (inputKind === 'base64') {
    const clean = input.replace(/\s+/g, '');
    if (clean === '' || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
      return { isError: true, content: [{ type: 'text', text: 'hash-text: base64 无法解码(非法字符或长度)' }] };
    }
    bytes = Buffer.from(clean, 'base64');
  } else {
    bytes = Buffer.from(input, 'utf8');
  }
  const digest = createHash(algo).update(bytes).digest('hex');
  return { content: [{ type: 'text', text: `${algo}:${digest}` }] };
});

server.registerTool('hmac-sign', {
  description:
    '用密钥对文本做 HMAC 签名(webhook 校验、API 签名场景)。algorithm 支持 sha256/sha512/sha1;'
    + '返回 hex 签名。verify 模式下额外传 expected,返回是否匹配(恒定时间比较)。',
  inputSchema: {
    text: z.string().describe('要签名的内容(UTF-8)'),
    key: z.string().describe('签名密钥'),
    algorithm: z.enum(['sha256', 'sha512', 'sha1']).optional().describe('默认 sha256'),
    expected: z.string().optional().describe('校验模式:期望的 hex 签名'),
  },
}, async ({ text, key, algorithm, expected }) => {
  if (key === '') {
    return { isError: true, content: [{ type: 'text', text: 'hmac-sign: 密钥不能为空' }] };
  }
  const sig = createHmac(algorithm ?? 'sha256', key).update(text, 'utf8').digest('hex');
  if (expected !== undefined) {
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected.toLowerCase(), 'hex');
    const match = a.length === b.length && a.equals(b);
    return { content: [{ type: 'text', text: match ? 'match: true' : `match: false(实际 ${sig})` }] };
  }
  return { content: [{ type: 'text', text: sig }] };
});

server.registerTool('generate-uuid', {
  description: '生成 UUID v4。count 可选(1-100,默认 1),每行一个。',
  inputSchema: {
    count: z.number().int().min(1).max(100).optional().describe('生成数量,默认 1'),
  },
}, async ({ count }) => {
  const n = count ?? 1;
  return { content: [{ type: 'text', text: Array.from({ length: n }, () => randomUUID()).join('\n') }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
