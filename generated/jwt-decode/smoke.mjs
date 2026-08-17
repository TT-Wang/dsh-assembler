#!/usr/bin/env node
/** 冒烟:listTools → SignJWT 自签 HS256 token → 解码看 payload/过期状态 → 正确密钥验签 → 错误密钥 valid:false → 非法 token 被拒。 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SignJWT } from 'jose';

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};
const text = (r) => (r.content ?? []).map((b) => b.text ?? '').join('');

const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname] });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
check('listTools 返回 2 个工具', tools.tools.length === 2, tools.tools.map((t) => t.name).join(','));

// 自造一个 HS256 token:payload {sub:'smoke'},exp 在未来
const secret = new TextEncoder().encode('test-secret');
const token = await new SignJWT({ sub: 'smoke' })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('2h')
  .sign(secret);

const r1 = await client.callTool({ name: 'decode-jwt', arguments: { token } });
check('decode 出 sub=smoke', /"sub":\s*"smoke"/.test(text(r1)), text(r1).slice(0, 80));
check('decode 出 alg=HS256 header', /"alg":\s*"HS256"/.test(text(r1)));
check('过期状态说未过期', text(r1).includes('未过期'));
check('说明了未验证签名', text(r1).includes('未验证签名'));

const r2 = await client.callTool({ name: 'verify-jwt-hs256', arguments: { token, secret: 'test-secret' } });
check('正确密钥 valid:true', /"valid":\s*true/.test(text(r2)), text(r2).slice(0, 80));
check('验签结果带回 payload.sub', /"sub":\s*"smoke"/.test(text(r2)));

const r3 = await client.callTool({ name: 'verify-jwt-hs256', arguments: { token, secret: 'wrong-secret' } });
check('错误密钥 valid:false(非 isError)', r3.isError !== true && /"valid":\s*false/.test(text(r3)), text(r3).slice(0, 80));

const r4 = await client.callTool({ name: 'decode-jwt', arguments: { token: 'not.a.jwt' } });
check('非法 token 被拒', r4.isError === true, text(r4).slice(0, 80));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
