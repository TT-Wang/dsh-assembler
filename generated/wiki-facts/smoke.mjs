#!/usr/bin/env node
/**
 * 冒烟:listTools → Wikipedia 英文摘要 → Wikipedia 中文站 → Wikidata 实体搜索 → Wikidata 属性事实
 *       → 错误路径(非法语言码/非法 QID/空词条)→ 不存在的词条(结构化未找到,非错误)。
 * 真实网络调用。词条正文会被随时编辑,所以断言**结构与稳定语义**(字段行齐全、QID 形状、
 * 摘要里必然出现的关键词),不断言字数、修订号、人口数值这类会漂移的数字。
 *
 * 注:需经代理才能访问 Wikimedia 的网络环境下,node 的内置 fetch **默认不读** HTTP(S)_PROXY,
 * 会报 TypeError: fetch failed / cause: UND_ERR_CONNECT_TIMEOUT(curl 却是通的)。
 * 此时用 NODE_USE_ENV_PROXY=1 node smoke.mjs 运行。
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

// --- Wikipedia 英文:Beijing 的摘要必然提到 China / capital ---
const r1 = await client.callTool({ name: 'page-summary', arguments: { title: 'Beijing' } });
const t1 = text(r1);
check('page-summary(en) 未报错', r1.isError !== true, t1.slice(0, 160));
check('page-summary(en) 摘要含 China 或 capital', /China|capital/i.test(t1), t1.split('\n').pop()?.slice(0, 100));
check('page-summary(en) 有标题/描述/链接三行', /^Wikipedia\(en\) 词条: /m.test(t1) && /^描述: /m.test(t1) && /^链接: https:\/\/en\.wikipedia\.org\//m.test(t1));
check('page-summary(en) 带出 Wikidata QID', /Wikidata: Q\d+/.test(t1), (t1.match(/Wikidata: \S+/) ?? [])[0]);
check('page-summary(en) 摘要行非空', /\n摘要: \S/.test(t1));

// --- Wikipedia 中文站:查 '北京' 必须返回中文 ---
const r2 = await client.callTool({ name: 'page-summary', arguments: { title: '北京', lang: 'zh' } });
const t2 = text(r2);
check('page-summary(zh) 未报错', r2.isError !== true, t2.slice(0, 160));
check('page-summary(zh) 命中中文站', /^Wikipedia\(zh\) 词条: /m.test(t2) && /zh\.wikipedia\.org/.test(t2));
const zhExtract = (t2.match(/\n摘要: ([\s\S]+)$/) ?? [])[1] ?? '';
check('page-summary(zh) 摘要含中日韩汉字', /[一-鿿]/.test(zhExtract), zhExtract.slice(0, 40));

// --- Wikidata 实体搜索:DeepSeek 必然有 Q 开头实体 ---
const r3 = await client.callTool({ name: 'search-entity', arguments: { query: 'DeepSeek', limit: 3 } });
const t3 = text(r3);
const qids = t3.match(/\bQ\d+\b/g) ?? [];
check('search-entity 未报错', r3.isError !== true, t3.slice(0, 160));
check('search-entity 返回 Q 开头的 id', qids.length > 0 && /^Q\d+$/.test(qids[0]), qids.slice(0, 3).join(','));
check('search-entity 每条候选有描述行', (t3.match(/^ {3}描述: /gm) ?? []).length === (t3.match(/^\d+\. /gm) ?? []).length);

// --- Wikidata 属性事实:Q956 = 北京,必有 P31(instance of)与 P17(country) ---
const r4 = await client.callTool({ name: 'entity-facts', arguments: { qid: 'Q956' } });
const t4 = text(r4);
check('entity-facts 未报错', r4.isError !== true, t4.slice(0, 160));
check('entity-facts 回显 QID 与标签', /^Wikidata 实体 Q956: \S/m.test(t4), t4.split('\n')[0]);
check('entity-facts 含 P31 属性行', /^ {2}P31 \(/m.test(t4), (t4.match(/^ {2}P31 .*/m) ?? [])[0]);
check('entity-facts 含 P17 属性行', /^ {2}P17 \(/m.test(t4), (t4.match(/^ {2}P17 .*/m) ?? [])[0]);
check('entity-facts 把值 QID 解析成了标签', /^ {2}P\d+ \([^)]+\): [^(\n]+\(Q\d+\)/m.test(t4), (t4.match(/^ {2}P31 .*/m) ?? [])[0]);
const trimMatch = t4.match(/原始属性总数: (\d+),下列为裁剪后的关键属性 (\d+) 个/);
check('entity-facts 声明了裁剪(原始属性总数 > 保留数)',
  trimMatch != null && Number(trimMatch[1]) > Number(trimMatch[2]),
  (t4.match(/原始属性总数: .*/) ?? [])[0]);

// --- 中文标签 ---
const r5 = await client.callTool({ name: 'entity-facts', arguments: { qid: 'Q956', language: 'zh' } });
check('entity-facts(zh) 返回中文标签', r5.isError !== true && /[一-鿿]/.test(text(r5)), text(r5).split('\n')[0]);

// --- 词条不存在:404 是正常情况,不是错误 ---
const z1 = await client.callTool({ name: 'page-summary', arguments: { title: 'Zzqqxx_Not_A_Real_Page_12345' } });
check('不存在的词条 → 结构化未找到说明(非 isError)', z1.isError !== true && /未找到词条/.test(text(z1)), text(z1).slice(0, 120));

const z2 = await client.callTool({ name: 'entity-facts', arguments: { qid: 'Q999999999999' } });
check('不存在的 QID → 结构化未找到说明(非 isError)', z2.isError !== true && /未找到实体/.test(text(z2)), text(z2).slice(0, 120));

// --- 错误路径 ---
const e1 = await client.callTool({ name: 'page-summary', arguments: { title: 'Beijing', lang: 'en_US' } });
check('非法语言码被拒(page-summary)', e1.isError === true && /不是合法维基语言码/.test(text(e1)), text(e1));

const e2 = await client.callTool({ name: 'search-entity', arguments: { query: 'Beijing', language: 'Not A Lang!' } });
check('非法语言码被拒(search-entity)', e2.isError === true && /不是合法语言码/.test(text(e2)), text(e2));

const e3 = await client.callTool({ name: 'page-summary', arguments: { title: '  ' } });
check('空词条名被拒', e3.isError === true && /词条名为空/.test(text(e3)), text(e3));

const e4 = await client.callTool({ name: 'entity-facts', arguments: { qid: 'P31' } });
check('非法 QID 被拒', e4.isError === true && /不是合法 QID/.test(text(e4)), text(e4));

const e5 = await client.callTool({ name: 'search-entity', arguments: { query: 'Beijing', limit: 50 } });
check('limit 越界被拒', e5.isError === true && /1-10/.test(text(e5)), text(e5));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
