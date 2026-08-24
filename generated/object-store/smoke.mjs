// object-store 冒烟:凭证契约(未配起得来、逐项点名缺什么)+ 工作区锚 + 参数闸。
// 真上传/下载需要一台 S3 兼容服务;交付前按 docs/live-credential-e2e.md 配 env 扣扳机。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${ok ? '' : ' | ' + d}`); if (!ok) failures++; };
const wd = mkdtempSync(join(tmpdir(), 'objs-'));
writeFileSync(join(wd, 'a.txt'), 'x');
const env = { ...process.env, PART_WORKDIR: wd };
delete env.S3_ACCESS_KEY; delete env.S3_SECRET_KEY; delete env.S3_ENDPOINT;
const transport = new StdioClientTransport({ command: 'node', args: ['index.js'], env });
const client = new Client({ name: 'objs-smoke', version: '0.0.1' });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check('凭证契约:未配也能起、5 工具在', tools.length === 5 && tools.includes('s3-presign'), tools.join(','));
  const info = JSON.parse((await client.callTool({ name: 's3-info', arguments: {} })).content[0].text);
  check('自述:端点/凭证状态,不回显密钥', info.credential.startsWith('missing:') && info.endpoint === null && info.workdirAnchor === wd);
  const up = await client.callTool({ name: 's3-upload', arguments: { bucket: 'b', objectName: 'o', path: 'a.txt' } });
  check('未配凭证 → 可行动错误(逐项点名 + 指路 file-channel)', up.isError === true
    && ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'].every((k) => up.content[0].text.includes(k))
    && up.content[0].text.includes('file-channel'), up.content[0].text.slice(0, 130));
  // 半配置(只给端点)也必须拒,不许"半瞎跑"
  const t2 = new StdioClientTransport({ command: 'node', args: ['index.js'], env: { ...env, S3_ENDPOINT: 'https://s3.example.com' } });
  const c2 = new Client({ name: 'objs-half', version: '0.0.1' }); await c2.connect(t2);
  const half = await c2.callTool({ name: 's3-list', arguments: { bucket: 'b' } });
  check('半配置(缺密钥)仍拒,且只点名缺的那两项', half.isError === true && half.content[0].text.includes('S3_ACCESS_KEY') && !half.content[0].text.includes('缺 S3_ENDPOINT'));
  // 工作区锚:即便凭证齐,越界路径也必须先被拦(用假凭证探锚)
  const t3 = new StdioClientTransport({ command: 'node', args: ['index.js'], env: { ...env, S3_ENDPOINT: 'https://s3.example.com', S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk' } });
  const c3 = new Client({ name: 'objs-anchor', version: '0.0.1' }); await c3.connect(t3);
  const esc = await c3.callTool({ name: 's3-upload', arguments: { bucket: 'b', objectName: 'o', path: '../../etc/passwd' } });
  check('工作区锚:越界路径拒(先于任何网络调用)', esc.isError === true && esc.content[0].text.includes('越出工作区锚'));
  await t2.close(); await t3.close();
} catch (e) { console.error('SMOKE CRASHED:', e); failures += 1; }
finally { try { await transport.close(); } catch {} }
console.log(`\n${failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
