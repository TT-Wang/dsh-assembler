// file-channel 冒烟:4 工具 + 服务脸(直传/取回/列表)+ 穿越拒绝 + 字节完整。
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${ok ? '' : ' | ' + d}`); if (!ok) failures++; };
const J = (r) => JSON.parse(r.content[0].text);

const wd = mkdtempSync(join(tmpdir(), 'fchan-'));
const transport = new StdioClientTransport({ command: 'node', args: ['index.js'], env: { ...process.env, PART_WORKDIR: wd } });
const client = new Client({ name: 'fchan-smoke', version: '0.0.1' });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check('listTools:4 工具', tools.length === 4 && tools.includes('file-channel-info') && tools.includes('read-text'), tools.join(','));

  const info = J(await client.callTool({ name: 'file-channel-info', arguments: {} }));
  check('服务脸:info 给 url+token+dir', info.url.startsWith('http://127.0.0.1:') && info.token.length === 32 && info.dir.startsWith(wd));
  check('.service.json 落盘含 files 条目', existsSync(join(wd, '.service.json')) && JSON.parse(readFileSync(join(wd, '.service.json'), 'utf8')).files.url === info.url);

  const H = { 'x-service-token': info.token };
  check('错 token 401', (await fetch(`${info.url}/list`, { headers: { 'x-service-token': 'no' } })).status === 401);

  // 真直传:二进制字节完整(不过 base64、不过模型)
  const payload = Buffer.from([...Array(2048).keys()].map((i) => i % 256));
  const up = await (await fetch(`${info.url}/upload/blob.bin`, { method: 'POST', headers: H, body: payload })).json();
  check('直传落盘且字节数对', up.ok === true && up.bytes === 2048);
  const back = Buffer.from(await (await fetch(`${info.url}/file/blob.bin`, { headers: H })).arrayBuffer());
  check('取回字节逐位一致', Buffer.compare(payload, back) === 0);

  const bad = await (await fetch(`${info.url}/upload/${encodeURIComponent('../escape.txt')}`, { method: 'POST', headers: H, body: 'x' })).json();
  check('穿越文件名拒绝', typeof bad.error === 'string' && !existsSync(join(wd, 'escape.txt')));

  await fetch(`${info.url}/upload/note.txt`, { method: 'POST', headers: H, body: '通道文本 CHAN-77' });
  const rt = await client.callTool({ name: 'read-text', arguments: { name: 'note.txt' } });
  check('工具面读回文本(同一目录,两面一致)', rt.content[0].text.includes('CHAN-77'));
  const ls = J(await client.callTool({ name: 'list-files', arguments: {} }));
  check('list 报两个文件', ls.files.length === 2 && ls.files.some((f) => f.name === 'blob.bin'));
  const del = J(await client.callTool({ name: 'delete-file', arguments: { name: 'blob.bin' } }));
  check('删除生效', del.deleted === 'blob.bin' && del.remaining === 1);
} catch (e) {
  console.error('SMOKE CRASHED:', e); failures += 1;
} finally { try { await transport.close(); } catch {} }
console.log(`\n${failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
