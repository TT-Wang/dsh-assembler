#!/usr/bin/env node
/**
 * 冒烟:listTools → Crossref 检索 → arXiv 预印本检索 → DOI 查询 → 错误路径(空查询/非法 DOI/条数越界)。
 * 真实网络调用。检索结果排序天天变,所以只断言**结构**(条数 > 0、每条有标题与标识符、
 * 字段行齐全),绝不断言具体标题、排名或被引数值。
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

// --- Crossref:'transformer' 必然有大量已发表文献 ---
const r1 = await client.callTool({ name: 'search-published', arguments: { query: 'transformer neural network', rows: 3 } });
const t1 = text(r1);
const items1 = t1.split('\n').filter((l) => /^\d+\. /.test(l));
check('search-published 未报错', r1.isError !== true, t1.slice(0, 160));
check('search-published 结果数 > 0', items1.length > 0, `${items1.length} 条`);
check('search-published 每条有非空标题', items1.length > 0 && items1.every((l) => l.replace(/^\d+\. /, '').trim().length > 0));
check('search-published 每条有 DOI 标识符', (t1.match(/^ {3}DOI: 10\./gm) ?? []).length === items1.length, `${(t1.match(/^ {3}DOI: 10\./gm) ?? []).length}/${items1.length}`);
check('search-published 每条有作者行与年份行', (t1.match(/^ {3}作者: /gm) ?? []).length === items1.length && (t1.match(/^ {3}年份: /gm) ?? []).length === items1.length);
check('search-published 标注了 Crossref 来源与命中总数', /Crossref 已发表文献/.test(t1) && /命中总数: \d+/.test(t1));

// --- arXiv:'CRISPR' 必然有预印本(实测 totalResults=110+) ---
const r2 = await client.callTool({ name: 'search-preprints', arguments: { query: 'CRISPR', maxResults: 3 } });
const t2 = text(r2);
const items2 = t2.split('\n').filter((l) => /^\d+\. /.test(l));
check('search-preprints 未报错', r2.isError !== true, t2.slice(0, 160));
check('search-preprints 结果数 > 0', items2.length > 0, `${items2.length} 条`);
check('search-preprints 每条有非空标题', items2.length > 0 && items2.every((l) => l.replace(/^\d+\. /, '').trim().length > 0));
check('search-preprints 每条有 arXiv id 标识符', (t2.match(/^ {3}arXiv id: \S+/gm) ?? []).length === items2.length, `${(t2.match(/^ {3}arXiv id: \S+/gm) ?? []).length}/${items2.length}`);
check('search-preprints 日期形如 YYYY-MM-DD', /^ {3}日期: \d{4}-\d{2}-\d{2}/m.test(t2));
check('XML 解析没把 feed 标题当论文', !/^1\. arXiv Query:/m.test(t2));
check('XML 实体已解码(无残留 &amp;/&lt;)', !/&(amp|lt|gt|quot|apos);/.test(t2));

// --- Crossref 单 DOI:10.1145/3292500.3330701(Optuna, KDD'19)真实存在,实测 HTTP 200 ---
const r3 = await client.callTool({ name: 'doi-lookup', arguments: { doi: '10.1145/3292500.3330701' } });
const t3 = text(r3);
check('doi-lookup 未报错', r3.isError !== true, t3.slice(0, 160));
const titleLine = t3.split('\n')[2] ?? ''; // 第 3 行 = 标题行(第 1 行是表头,第 2 行是空行)
check('doi-lookup 返回标题非空', titleLine.trim().length > 0 && !titleLine.startsWith('   '), JSON.stringify(titleLine).slice(0, 80));
check('doi-lookup 回显该 DOI', t3.includes('10.1145/3292500.3330701'));
check('doi-lookup 有年份与出版方行', /^ {3}年份: \d{4}/m.test(t3) && /^ {3}出版方: /m.test(t3));

// --- DOI 前缀归一:带 https://doi.org/ 也要认 ---
const r4 = await client.callTool({ name: 'doi-lookup', arguments: { doi: 'https://doi.org/10.1145/3292500.3330701' } });
check('doi-lookup 吃掉 doi.org 前缀', r4.isError !== true && text(r4).includes('10.1145/3292500.3330701'), text(r4).slice(0, 120));

// --- 错误路径 ---
const e1 = await client.callTool({ name: 'search-published', arguments: { query: '   ' } });
check('空查询被拒(Crossref)', e1.isError === true && /查询词为空/.test(text(e1)), text(e1));

const e2 = await client.callTool({ name: 'search-preprints', arguments: { query: '' } });
check('空查询被拒(arXiv)', e2.isError === true && /查询词为空/.test(text(e2)), text(e2));

const e3 = await client.callTool({ name: 'search-published', arguments: { query: 'transformer', rows: 99 } });
check('rows 越界被拒', e3.isError === true && /1-20/.test(text(e3)), text(e3));

const e4 = await client.callTool({ name: 'doi-lookup', arguments: { doi: 'not-a-doi' } });
check('非法 DOI 被拒', e4.isError === true && /不是合法 DOI/.test(text(e4)), text(e4));

// --- 查无结果 = 结构化说明,不是错误 ---
const z1 = await client.callTool({ name: 'doi-lookup', arguments: { doi: '10.9999/not-a-real-doi-12345' } });
check('查无此 DOI → 结构化未收录说明(非 isError)', z1.isError !== true && /未收录/.test(text(z1)), text(z1).slice(0, 120));

const z2 = await client.callTool({ name: 'search-preprints', arguments: { query: 'zzqqxxnonexistentterm12345' } });
check('arXiv 零结果 → 结构化说明(非 isError)', z2.isError !== true && /未找到任何预印本/.test(text(z2)), text(z2).slice(0, 120));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
