#!/usr/bin/env node
/**
 * 冒烟:listTools → 许可证查询(lodash 是 MIT)→ system 大小写不敏感(npm/NPM/PyPI 都通)
 * → 依赖闭包直接/间接分开且不把自己算成自己的依赖 → directOnly 过滤
 * → 版本列表(默认版本唯一、最近版在前)→ 404 路径给出可行动指路。
 *
 * 断言压"结构 + 语义 + 单调关系",不压易变值:版本数、依赖条数、latest 版本号
 * 都会随上游变。压死的只有 lodash 的许可证 MIT——那是历史事实。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
const json = (r) => { try { return JSON.parse(text(r)); } catch { return null; } };

const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname], env: NETWORK_ENV });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const call = async (name, args) => {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `callTool 抛出:${e?.message ?? String(e)}` }] };
  }
};

// ── listTools ──────────────────────────────────────────────────────────────
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check('listTools 三个工具', names.length === 3, names.join(', '));
check('工具名齐全', JSON.stringify(names) === JSON.stringify(['list-versions', 'package-licence', 'resolved-dependencies']), names.join(', '));
check('描述里点明只读免凭证', tools.every((t) => /只读/.test(t.description ?? '')));
check('许可证工具明说不是法律结论',
  /不是法律结论/.test(tools.find((t) => t.name === 'package-licence')?.description ?? ''));

// ── package-licence ────────────────────────────────────────────────────────
const lic = json(await call('package-licence', { system: 'npm', name: 'lodash', version: '4.17.15' }));
check('lodash 的许可证是 MIT', JSON.stringify(lic?.licenses) === JSON.stringify(['MIT']), JSON.stringify(lic?.licenses));
check('回显规范化后的 system(NPM)', lic?.package?.system === 'NPM', lic?.package?.system);
check('带发布时间', typeof lic?.publishedAt === 'string' && lic.publishedAt.length > 4, lic?.publishedAt);
check('带上游公告 id(4.17.15 有已知漏洞)', Array.isArray(lic?.advisoryIds) && lic.advisoryIds.length > 0, `${lic?.advisoryIds?.length} 条`);
check('公告只给 id 不夹带详情', (lic?.advisoryIds ?? []).every((x) => typeof x === 'string'));
check('带来源链接', typeof lic?.origin === 'string' && lic.origin.includes('npmjs.org'), lic?.origin);
check('带数据署名并声明是参考信息', /advisory, not a legal determination/.test(lic?.attribution ?? ''));

// system 大小写:deps.dev 不挑,本零件统一归一(与 OSV 的严格拼写形成对照)
const upper = json(await call('package-licence', { system: 'NPM', name: 'lodash', version: '4.17.15' }));
check('system 大写也通,结果一致', JSON.stringify(upper?.licenses) === JSON.stringify(lic?.licenses));
const py = json(await call('package-licence', { system: 'PyPI', name: 'requests', version: '2.19.0' }));
check('PyPI 归一成 PYPI 且查得到', py?.package?.system === 'PYPI' && (py?.licenses ?? []).length >= 0, py?.package?.system);
const crates = json(await call('package-licence', { system: 'crates.io', name: 'serde', version: '1.0.100' }));
check('crates.io 被当作 CARGO', crates?.package?.system === 'CARGO', crates?.package?.system);

// ── resolved-dependencies ──────────────────────────────────────────────────
const graph = json(await call('resolved-dependencies', { system: 'npm', name: 'express', version: '4.18.2' }));
check('express 有直接依赖', graph?.directCount > 0, `direct=${graph?.directCount}`);
check('express 有间接依赖(闭包比直接依赖大)', graph?.indirectCount > 0 && graph.totalCount > graph.directCount,
  `direct=${graph?.directCount} indirect=${graph?.indirectCount} total=${graph?.totalCount}`);
check('计数自洽:direct + indirect = total', graph?.directCount + graph?.indirectCount === graph?.totalCount);
check('不把自己算成自己的依赖',
  !(graph?.dependencies ?? []).some((d) => d.name === 'express' && d.version === '4.18.2')
  && !(graph?.dependencies ?? []).some((d) => d.relation === 'SELF'));
check('每个节点带 relation', (graph?.dependencies ?? []).every((d) => typeof d.relation === 'string' && d.relation.length > 0));
check('裁剪生效:列出的不超过 60 个', (graph?.dependencies ?? []).length <= 60, `${graph?.dependencies?.length} 个`);
const gbytes = JSON.stringify(graph).length;
check('闭包返回体 < 8KB(上游原文约 15KB)', gbytes < 8000, `${gbytes}B`);

const directOnly = json(await call('resolved-dependencies', { system: 'npm', name: 'express', version: '4.18.2', directOnly: true }));
check('directOnly 只回直接依赖', (directOnly?.dependencies ?? []).every((d) => d.relation === 'DIRECT'));
check('directOnly 条数等于 directCount(未截断时)',
  directOnly?.truncated !== undefined || directOnly?.dependencies?.length === directOnly?.directCount,
  `${directOnly?.dependencies?.length} vs ${directOnly?.directCount}`);
check('directOnly 不改变闭包统计口径', directOnly?.totalCount === graph?.totalCount);

// ── list-versions ──────────────────────────────────────────────────────────
const vers = json(await call('list-versions', { system: 'npm', name: 'lodash' }));
check('版本数是正数', vers?.versionCount > 0, `${vers?.versionCount} 个`);
check('有唯一默认版本', vers?.defaultVersion !== null && typeof vers?.defaultVersion?.version === 'string', vers?.defaultVersion?.version);
check('默认版本标着 isDefault', vers?.defaultVersion?.isDefault === true);
check('最近版本最多 15 个', (vers?.recentVersions ?? []).length <= 15, `${vers?.recentVersions?.length} 个`);
check('最近版在前(时间递减)', (() => {
  const ts = (vers?.recentVersions ?? []).map((v) => Date.parse(v.publishedAt ?? 0)).filter((n) => !Number.isNaN(n));
  return ts.every((t, i) => i === 0 || ts[i - 1] >= t);
})(), (vers?.recentVersions ?? []).slice(0, 3).map((v) => v.version).join(' > '));
// 专盯字符串序陷阱:上游的 versions 数组按版本字符串排,"4.9.0" 落在 "4.17.21"
// 之后,取数组尾部会拿到 2016 年的版本还叫它"最近"。第一版就是这么错的。
check('"最近"真的是最近(不是字符串序的尾巴)',
  Date.parse(vers?.recentVersions?.[0]?.publishedAt ?? 0) > Date.parse('2020-01-01'),
  `${vers?.recentVersions?.[0]?.version} @ ${vers?.recentVersions?.[0]?.publishedAt}`);
const vbytes = JSON.stringify(vers).length;
check('版本列表返回体 < 6KB(上游原文约 19KB)', vbytes < 6000, `${vbytes}B`);

// ── 错误路径 ───────────────────────────────────────────────────────────────
const noSuch = await call('package-licence', { system: 'npm', name: 'dsh-assembler-no-such-package-xyzzy', version: '1.0.0' });
check('查不到的包 → isError', noSuch.isError === true);
check('404 时指路怎么核对', /核对/.test(text(noSuch)) && /Maven/.test(text(noSuch)), text(noSuch).slice(0, 110));

const badSystem = await call('list-versions', { system: 'NOT-A-SYSTEM', name: 'lodash' });
check('不存在的 system → isError', badSystem.isError === true, text(badSystem).slice(0, 90));

await client.close();
console.log(failures === 0 ? '\ndeps-graph smoke: ALL PASS' : `\ndeps-graph smoke: ${failures} FAILED`);
process.exit(failures);
