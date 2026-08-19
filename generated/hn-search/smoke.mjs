#!/usr/bin/env node
/**
 * 冒烟:listTools → 搜 "LLM"(有命中、字段齐、体积裁剪)→ date 排序最新在前
 * → top-stories 按 points 降序 → get-item 取详情 → 错误路径(非法 objectID)。
 * 断言压结构与单调关系,不压易变值:HN 每天在变,某关键词的命中数、分数都会变。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const NETWORK_ENV = (() => {
  const e = { ...process.env };
  if ((e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy) && e.NODE_USE_ENV_PROXY === undefined) e.NODE_USE_ENV_PROXY = '1';
  return e;
})();
let failures = 0;
const check = (l, c, x = '') => { console.log(`${c ? '  ✓' : '  ✗ FAIL'} ${l}${x ? ` — ${x}` : ''}`); if (!c) failures += 1; };
const text = (r) => r.content.map((b) => b.text ?? '').join('');
const json = (r) => { try { return JSON.parse(text(r)); } catch { return null; } };

const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname], env: NETWORK_ENV });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);
const call = async (n, a) => { try { return await client.callTool({ name: n, arguments: a }); } catch (e) { return { isError: true, content: [{ type: 'text', text: `callTool 抛出:${e?.message ?? e}` }] }; } };

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check('listTools 三个工具', names.length === 3, names.join(', '));
check('工具名齐全', JSON.stringify(names) === JSON.stringify(['get-item', 'search-stories', 'top-stories']));
check('描述点明只读免凭证', tools.every((t) => /只读/.test(t.description ?? '')));

const s = json(await call('search-stories', { query: 'LLM', limit: 5 }));
check('搜 LLM 有命中', s !== null && (s.stories ?? []).length > 0, `${s?.stories?.length} 条`);
check('每条带标题与分数', (s?.stories ?? []).every((x) => typeof x.title === 'string' && ('points' in x)));
check('带 HN 链接', (s?.stories ?? []).every((x) => typeof x.hnUrl === 'string' && x.hnUrl.includes('ycombinator')));
check('裁剪:无 _highlightResult 残留', !text(await call('search-stories', { query: 'LLM', limit: 1 })).includes('_highlightResult'));
check('单条搜索返回体 < 6KB(原文一条就近 4KB)', JSON.stringify(s).length < 6000, `${JSON.stringify(s).length}B`);
check('带署名', /Hacker News/.test(s?.attribution ?? ''));

const d = json(await call('search-stories', { query: 'AI', sort: 'date', limit: 5 }));
check('date 排序:时间递减', (() => {
  const ts = (d?.stories ?? []).map((x) => Date.parse(x.createdAt ?? 0)).filter((n) => !Number.isNaN(n));
  return ts.length > 1 && ts.every((t, i) => i === 0 || ts[i - 1] >= t);
})(), (d?.stories ?? []).slice(0, 2).map((x) => x.createdAt).join(' , '));

const t = json(await call('top-stories', { query: 'AI', limit: 5 }));
check('top-stories 按 points 降序', (() => {
  const ps = (t?.stories ?? []).map((x) => x.points ?? 0);
  return ps.length > 1 && ps.every((p, i) => i === 0 || ps[i - 1] >= p);
})(), (t?.stories ?? []).map((x) => x.points).join(' ≥ '));

const first = (s?.stories ?? []).find((x) => x.objectID);
const one = json(await call('get-item', { objectID: first?.objectID ?? '1' }));
check('get-item 取到同一 id', String(one?.id) === String(first?.objectID), `${first?.objectID} -> ${one?.id}`);
check('详情带 hnUrl', typeof one?.hnUrl === 'string' && one.hnUrl.includes('item?id='));

const bad = await call('get-item', { objectID: 'not-a-number' });
check('非法 objectID → isError', bad.isError === true);

await client.close();
console.log(failures === 0 ? '\nhn-search smoke: ALL PASS' : `\nhn-search smoke: ${failures} FAILED`);
process.exit(failures);
