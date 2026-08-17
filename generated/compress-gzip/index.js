#!/usr/bin/env node
/**
 * First-party MCP stdio server: gzip / brotli compression on node:zlib.
 * 能力点:压缩/解压 base64 字节——配合 http-request(gzip 响应体)、
 * binary-write(压缩后落盘)、text-encoding(先转码再压缩)组合使用。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { gzipSync, gunzipSync, brotliCompressSync, brotliDecompressSync } from 'node:zlib';

const server = new McpServer({ name: 'compress-gzip', version: '0.0.1' });

const decodeB64 = (input) => {
  const clean = input.replace(/\s+/g, '');
  if (clean === '' || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  return Buffer.from(clean, 'base64');
};

server.registerTool('compress', {
  description:
    '压缩内容返回 base64 字节。algorithm:gzip 或 brotli;inputKind=text 按 UTF-8 处理,'
    + 'inputKind=base64 先解码为字节再压缩。返回 base64 与压缩前后字节数。',
  inputSchema: {
    input: z.string().describe('要压缩的内容(文本或 base64)'),
    algorithm: z.enum(['gzip', 'brotli']).optional().describe('默认 gzip'),
    inputKind: z.enum(['text', 'base64']).optional().describe('默认 text'),
  },
}, async ({ input, algorithm, inputKind }) => {
  let bytes;
  if (inputKind === 'base64') {
    bytes = decodeB64(input);
    if (bytes === null) return { isError: true, content: [{ type: 'text', text: 'compress: base64 无法解码(非法字符或长度)' }] };
  } else {
    bytes = Buffer.from(input, 'utf8');
  }
  const out = (algorithm ?? 'gzip') === 'brotli' ? brotliCompressSync(bytes) : gzipSync(bytes);
  return { content: [{ type: 'text', text: `${bytes.length} → ${out.length} bytes\n${out.toString('base64')}` }] };
});

server.registerTool('decompress', {
  description:
    '解压 base64 字节。algorithm:gzip 或 brotli;outputKind=text 按 UTF-8 解释输出,'
    + 'outputKind=base64 返回原始字节的 base64(内容是二进制时用)。数据损坏或算法不匹配报错。',
  inputSchema: {
    input: z.string().describe('压缩数据的 base64'),
    algorithm: z.enum(['gzip', 'brotli']).optional().describe('默认 gzip'),
    outputKind: z.enum(['text', 'base64']).optional().describe('默认 text'),
  },
}, async ({ input, algorithm, outputKind }) => {
  const bytes = decodeB64(input);
  if (bytes === null) return { isError: true, content: [{ type: 'text', text: 'decompress: base64 无法解码(非法字符或长度)' }] };
  let out;
  try {
    out = (algorithm ?? 'gzip') === 'brotli' ? brotliDecompressSync(bytes) : gunzipSync(bytes);
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: `decompress: 解压失败(数据损坏或算法不匹配):${error.message}` }] };
  }
  return { content: [{ type: 'text', text: outputKind === 'base64' ? out.toString('base64') : out.toString('utf8') }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
