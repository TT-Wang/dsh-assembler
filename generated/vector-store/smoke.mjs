// vector-store 冒烟:4 工具 · 语义相似真序 · 幂等覆盖 · 维度不匹配报错 · 持久化 · 服务脸。
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${ok ? '' : ' | ' + d}`); if (!ok) failures++; };
const J = (r) => JSON.parse(r.content[0].text);
const wd = mkdtempSync(join(tmpdir(), 'vec-'));
const mk = () => new StdioClientTransport({ command: 'node', args: ['index.js'], env: { ...process.env, PART_WORKDIR: wd } });

let transport = mk();
const client = new Client({ name: 'vec-smoke', version: '0.0.1' });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check('listTools:4 工具', tools.length === 4 && tools.includes('vector-search'), tools.join(','));

  const add = J(await client.callTool({ name: 'vector-add', arguments: { collection: 'docs', items: [
    { id: 'a', vector: [1, 0, 0], text: '苹果 水果' },
    { id: 'b', vector: [0, 1, 0], text: '汽车 交通' },
    { id: 'c', vector: [0.9, 0.1, 0], text: '梨 水果' },
  ] } }));
  check('写入 3 条并记住维度', add.total === 3 && add.dim === 3);

  const s = J(await client.callTool({ name: 'vector-search', arguments: { collection: 'docs', vector: [1, 0.05, 0], topK: 2 } }));
  check('检索:相似度真排序(a/c 在前,b 落选)', s.hits.length === 2 && ['a', 'c'].includes(s.hits[0].id) && !s.hits.some((h) => h.id === 'b'), JSON.stringify(s.hits));
  check('检索:回原文不回原向量(返回体裁剪)', s.hits[0].text !== undefined && s.hits[0].vector === undefined);

  const dim = await client.callTool({ name: 'vector-search', arguments: { collection: 'docs', vector: [1, 0] } });
  check('维度不匹配 → 明确报错(不给无意义分数)', dim.isError === true && dim.content[0].text.includes('维度'));

  const up = J(await client.callTool({ name: 'vector-add', arguments: { collection: 'docs', items: [{ id: 'a', vector: [0, 0, 1], text: '苹果改了' }] } }));
  check('同 id 覆盖(幂等重灌不涨条数)', up.total === 3);

  const minS = J(await client.callTool({ name: 'vector-search', arguments: { collection: 'docs', vector: [0, 1, 0], minScore: 0.9 } }));
  check('minScore 过滤生效', minS.hits.length === 1 && minS.hits[0].id === 'b');

  const bad = await client.callTool({ name: 'vector-add', arguments: { collection: '../escape', items: [{ id: 'x', vector: [1] }] } });
  check('非法集合名拒绝(路径穿越)', bad.isError === true && !existsSync(join(wd, 'escape.json')));

  // 服务脸
  const info = J(await client.callTool({ name: 'vector-info', arguments: {} }));
  check('服务脸:info 报端点与集合概况', info.url.startsWith('http://127.0.0.1:') && info.collections.some((c) => c.name === 'docs' && c.items === 3));
  check('服务脸:错 token 401', (await fetch(`${info.url}/collections`, { headers: { 'x-service-token': 'no' } })).status === 401);
  const H = { 'content-type': 'application/json', 'x-service-token': info.token };
  const fs1 = await (await fetch(`${info.url}/search`, { method: 'POST', headers: H, body: JSON.stringify({ collection: 'docs', vector: [0, 1, 0], topK: 1 }) })).json();
  check('服务脸:直接检索与工具面同结果(页面零模型语义搜索)', fs1.hits?.[0]?.id === 'b');
  const fs2 = await (await fetch(`${info.url}/search`, { method: 'POST', headers: H, body: JSON.stringify({ collection: 'docs', vector: [1, 2] }) })).json();
  check('服务脸:维度错也明确报错', String(fs2.error ?? '').includes('维度'));
  await transport.close();
} catch (e) { console.error('SMOKE CRASHED:', e); failures += 1; }

// 持久化:换一个进程,数据还在(跨会话状态)
try {
  transport = mk();
  const c2 = new Client({ name: 'vec-smoke2', version: '0.0.1' });
  await c2.connect(transport);
  const s2 = J(await c2.callTool({ name: 'vector-search', arguments: { collection: 'docs', vector: [0, 1, 0], topK: 1 } }));
  check('持久化:重启进程后数据仍在', s2.hits[0].id === 'b' && s2.searched === 3);
  await transport.close();
} catch (e) { console.error('PERSIST CRASHED:', e); failures += 1; }

console.log(`\n${failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
