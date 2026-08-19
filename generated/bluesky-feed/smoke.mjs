#!/usr/bin/env node
/**
 * 冒烟:listTools → author-feed 读 bsky.app 官方号(有帖、带互动量、有链接)
 * → whats-hot 拿热门(多条、含 likeCount)→ profile 查资料(粉丝数是正数)
 * → 错误路径(不存在的 handle)。
 * 断言压结构与量纲,不压易变值:帖子内容、粉丝数、热门条目每分钟都在变。
 * bsky.app 是官方账号,长期存在,拿它做稳定锚点。
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
check('工具名齐全', JSON.stringify(names) === JSON.stringify(['author-feed', 'profile', 'whats-hot']));
check('描述点明只读免凭证', tools.every((t) => /只读/.test(t.description ?? '')));

const f = json(await call('author-feed', { actor: 'bsky.app', limit: 5 }));
check('读到 bsky.app 的帖', f !== null && (f.posts ?? []).length > 0, `${f?.posts?.length} 条`);
check('每帖带作者与互动量', (f?.posts ?? []).every((p) => typeof p.author === 'string' && ('likeCount' in p)));
check('带原帖链接', (f?.posts ?? []).some((p) => typeof p.url === 'string' && p.url.includes('bsky.app/profile')));
check('裁剪:正文不超 300 字', (f?.posts ?? []).every((p) => (p.text ?? '').length <= 300));
check('带署名', /Bluesky/.test(f?.attribution ?? ''));

const h = json(await call('whats-hot', { limit: 8 }));
check('whats-hot 有热帖', (h?.posts ?? []).length > 0, `${h?.posts?.length} 条`);
check('热帖带 likeCount', (h?.posts ?? []).every((p) => 'likeCount' in p));

const pr = json(await call('profile', { actor: 'bsky.app' }));
check('profile 查到 handle', pr?.handle === 'bsky.app', pr?.handle);
check('粉丝数是正数', typeof pr?.followersCount === 'number' && pr.followersCount > 0, String(pr?.followersCount));
check('带主页链接', typeof pr?.url === 'string' && pr.url.includes('bsky.app/profile/'));

const bad = await call('profile', { actor: 'this-handle-almost-surely-does-not-exist-xyzzy.bsky.social' });
check('不存在的 handle → isError', bad.isError === true, text(bad).slice(0, 80));

await client.close();
console.log(failures === 0 ? '\nbluesky-feed smoke: ALL PASS' : `\nbluesky-feed smoke: ${failures} FAILED`);
process.exit(failures);
