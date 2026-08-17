#!/usr/bin/env node
/**
 * 冒烟:listTools → 主题检索 → 单篇被引 → 作者代表作 → 裁剪证明(单条 < 2KB)→ 错误路径。
 * 真实网络调用。OpenAlex 排序与被引数每天都在变,所以只断言**结构与量纲**
 * (results 非空、每条有标题与年份、cited_by_count 是非负整数、单条返回体字节数上限),
 * 绝不断言具体排名、具体标题或具体引用数。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// 网络零件冒烟:必须把代理环境显式传给零件子进程。MCP SDK 的
// StdioClientTransport 默认只透传白名单 env(HOME/PATH/USER…),
// HTTPS_PROXY / NODE_USE_ENV_PROXY 都不在其中——不传的话零件在代理网络下
// 只会报 "fetch failed",看起来像零件坏了,其实是网络路径断了。
const NETWORK_ENV = (() => {
  const e = { ...process.env };
  if ((e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy) && e.NODE_USE_ENV_PROXY === undefined) {
    e.NODE_USE_ENV_PROXY = '1';
  }
  return e;
})();


let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};
const text = (r) => r.content.map((b) => b.text ?? '').join('');

const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname], env: NETWORK_ENV });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
check('listTools 返回 3 个工具', tools.tools.length === 3, tools.tools.map((t) => t.name).join(','));

// --- 主题检索:'protein folding' 是稳定存在、命中量极大的主题 ---
const r1 = await client.callTool({ name: 'search-works', arguments: { query: 'protein folding', perPage: 3 } });
const t1 = text(r1);
const titles = t1.split('\n').filter((l) => /^\d+\. /.test(l));
const yearLines = t1.match(/^ {3}年份: (\d{4}|年份未知) \| 类型: .+ \| 被引: (\d+)$/gm) ?? [];
check('search-works 未报错', r1.isError !== true, t1.slice(0, 160));
check('search-works results 非空', titles.length > 0, `${titles.length} 条`);
check('search-works 每条有非空标题', titles.length > 0 && titles.every((l) => l.replace(/^\d+\. /, '').trim().length > 0));
check('search-works 每条有年份行与被引', yearLines.length === titles.length, `${yearLines.length}/${titles.length}`);
check('search-works 每条年份是 4 位数', yearLines.every((l) => /年份: \d{4} /.test(l)), yearLines[0]);
const citeCounts = [...t1.matchAll(/\| 被引: (\d+)$/gm)].map((m) => Number(m[1]));
check('cited_by_count 是非负整数', citeCounts.length === titles.length && citeCounts.every((c) => Number.isInteger(c) && c >= 0), citeCounts.join(','));
check('search-works 每条有 OpenAlex work id', (t1.match(/^ {3}OpenAlex: W\d+/gm) ?? []).length === titles.length);

// --- 裁剪证明:单条返回体必须 < 2KB(不裁剪的话 OpenAlex 单条原始 JSON 就有几十 KB) ---
const r2 = await client.callTool({ name: 'search-works', arguments: { query: 'protein folding', perPage: 1 } });
const t2 = text(r2);
const bytes = Buffer.byteLength(t2, 'utf8');
check('单条返回体 < 2KB(证明确实裁剪了)', r2.isError !== true && bytes < 2048, `${bytes} bytes`);
check('单条返回体仍含标题/作者/被引', /^1\. \S/m.test(t2) && /^ {3}作者: /m.test(t2) && /\| 被引: \d+$/m.test(t2));
check('未把 abstract_inverted_index / concepts 等原始字段倒回来', !/abstract_inverted_index|"concepts"|raw_affiliation_strings/.test(t2));

// --- 按被引排序 ---
const r3 = await client.callTool({ name: 'search-works', arguments: { query: 'protein folding', perPage: 3, sortByCitations: true } });
const t3 = text(r3);
const sorted = [...t3.matchAll(/\| 被引: (\d+)$/gm)].map((m) => Number(m[1]));
check('按被引降序时结果单调不增', r3.isError !== true && sorted.length > 1 && sorted.every((c, i) => i === 0 || sorted[i - 1] >= c), sorted.join(' >= '));

// --- 单篇被引:10.1145/3292500.3330701(Optuna)实测存在,W2949676527 ---
const r4 = await client.callTool({ name: 'work-citations', arguments: { work: '10.1145/3292500.3330701' } });
const t4 = text(r4);
check('work-citations(DOI) 未报错', r4.isError !== true, t4.slice(0, 160));
check('work-citations 返回标题非空', (t4.split('\n')[2] ?? '').trim().length > 0, JSON.stringify(t4.split('\n')[2] ?? '').slice(0, 80));
check('work-citations 被引次数是非负整数', /^ {3}被引次数: (\d+) \|/m.test(t4), (t4.match(/^ {3}被引次数: .*/m) ?? [])[0]);
check('work-citations 有开放获取字段', /^ {3}开放获取: (是|否|未知)/m.test(t4));

const r5 = await client.callTool({ name: 'work-citations', arguments: { work: 'W2949676527' } });
check('work-citations(work id) 也能查', text(r5).includes('W2949676527') && r5.isError !== true, text(r5).split('\n')[0]);

// --- 作者代表作 ---
const r6 = await client.callTool({ name: 'author-works', arguments: { name: 'Yoshua Bengio', topWorks: 3 } });
const t6 = text(r6);
check('author-works 未报错', r6.isError !== true, t6.slice(0, 160));
check('author-works 返回作者 id 与总被引', /^姓名: .+ \(A\d+\)$/m.test(t6) && /总被引: \d+/.test(t6), (t6.match(/^姓名: .*/m) ?? [])[0]);
check('author-works 列出代表作且每条有被引', (t6.match(/^\d+\. \S/gm) ?? []).length > 0 && (t6.match(/\| 被引: \d+$/gm) ?? []).length > 0);

// --- 错误路径 ---
const e1 = await client.callTool({ name: 'search-works', arguments: { query: '   ' } });
check('空查询被拒(search-works)', e1.isError === true && /查询词为空/.test(text(e1)), text(e1));

const e2 = await client.callTool({ name: 'author-works', arguments: { name: '' } });
check('空作者名被拒', e2.isError === true && /作者名为空/.test(text(e2)), text(e2));

const e3 = await client.callTool({ name: 'search-works', arguments: { query: 'protein', perPage: 99 } });
check('perPage 越界被拒', e3.isError === true && /1-20/.test(text(e3)), text(e3));

const e4 = await client.callTool({ name: 'work-citations', arguments: { work: 'not-an-id' } });
check('非法定位符被拒', e4.isError === true && /既不是 OpenAlex work id/.test(text(e4)), text(e4));

// --- 查无结果 = 结构化说明,不是错误(实测 OpenAlex 404 返回 HTML 错误页,必须被识别成"未收录") ---
const z1 = await client.callTool({ name: 'work-citations', arguments: { work: '10.9999/not-a-real-doi-12345' } });
check('查无此文 → 结构化未收录说明(非 isError)', z1.isError !== true && /未收录/.test(text(z1)), text(z1).slice(0, 140));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
