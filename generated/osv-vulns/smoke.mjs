#!/usr/bin/env node
/**
 * 冒烟:listTools → 单包扫描(已知有漏洞的 lodash@4.17.15,断言能给出修复版本)
 * → 干净版本返回 vulnCount:0 而非报错 → 批量分诊按输入顺序位置对齐
 * → 单条漏洞取详情 → ecosystem 拼错时给出带正确拼写的可行动错误
 * → 超批量上限时本地拦下(不打上游)。
 *
 * 断言压"结构 + 语义 + 量纲",不压具体条数:漏洞库每天在变,lodash 4.17.15
 * 今天命中 6 条明天可能 7 条。唯一压死的具体值是 4.17.21——那是 lodash 的
 * 历史修复版本,已经写进档案不会再改。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// 网络零件冒烟:必须把代理环境显式传给零件子进程(SDK 默认只透传 env 白名单)。
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
check('工具名齐全', JSON.stringify(names) === JSON.stringify(['get-vulnerability', 'scan-dependencies', 'scan-package']), names.join(', '));
check('描述里点明只读免凭证', tools.every((t) => /只读/.test(t.description ?? '')));

// ── scan-package:已知有漏洞的版本 ──────────────────────────────────────────
const lodash = json(await call('scan-package', { ecosystem: 'npm', name: 'lodash', version: '4.17.15' }));
check('lodash@4.17.15 有命中', lodash !== null && lodash.vulnCount > 0, `vulnCount=${lodash?.vulnCount}`);
check('回显被查的包坐标', lodash?.package?.name === 'lodash' && lodash?.package?.version === '4.17.15');
const withFix = (lodash?.vulns ?? []).filter((v) => (v.fixedIn ?? []).length > 0);
check('至少一条给出了修复版本', withFix.length > 0, `${withFix.length}/${lodash?.vulns?.length} 条带 fixedIn`);
check('修复版本里包含 4.17.21(lodash 的历史修复版本)',
  withFix.some((v) => v.fixedIn.includes('4.17.21')),
  withFix.map((v) => v.fixedIn.join('/')).join(' | '));
const anyVuln = (lodash?.vulns ?? [])[0];
check('每条带 id', typeof anyVuln?.id === 'string' && anyVuln.id.length > 3, anyVuln?.id);
check('严重度有一种说法(定性或 CVSS)',
  (lodash?.vulns ?? []).every((v) => v.qualitativeSeverity !== null || v.cvss !== null));
check('裁剪生效:摘要不超 200 字', (lodash?.vulns ?? []).every((v) => (v.summary ?? '').length <= 200));
check('裁剪生效:没有把 details 长文塞进来', (lodash?.vulns ?? []).every((v) => v.details === undefined));
check('带数据署名', /OSV\.dev/.test(lodash?.attribution ?? ''));
// 裁剪的量纲:一个包的整个返回体应当远小于上游原文(实测原文 ≈29KB)。
const bytes = JSON.stringify(lodash).length;
check('单包返回体 < 8KB(上游原文约 29KB)', bytes < 8000, `${bytes}B`);

// ── scan-package:零命中 ────────────────────────────────────────────────────
// 用"库里没有这个包"而不是"这个版本目前干净"来压零命中:后者是活靶子。
// 第一版这里压的是 lodash@4.17.21,当年它正是修复版本;后来又有三条公告
// 覆盖到它(修复版本已经推到 4.17.23 / 4.18.0),断言随之变红——压易变值的
// 代价,连同一个文件开头写着"不压易变值"的自己一起打脸。
const clean = json(await call('scan-package', { ecosystem: 'npm', name: 'dsh-assembler-no-such-package-xyzzy', version: '1.0.0' }));
check('零命中返回 vulnCount:0 而不是报错', clean !== null && clean.vulnCount === 0, `vulnCount=${clean?.vulnCount}`);
check('零命中 vulns 是空数组(上游给的是 {},没有 vulns 键)', Array.isArray(clean?.vulns) && clean.vulns.length === 0);
// 契约属性,永远成立:未截断时计数必须等于条数。
check('vulnCount 与 vulns 长度自洽(未截断时)',
  lodash?.truncated !== undefined || lodash?.vulnCount === lodash?.vulns?.length,
  `${lodash?.vulnCount} vs ${lodash?.vulns?.length}`);

// ── scan-dependencies:位置对齐是关键契约 ───────────────────────────────────
// 第一个位置刻意放零命中的包:上游对它返回空对象 {} 而不是缺位,
// 错位或把 {} 当异常处理都会在这里露出来。
const batch = json(await call('scan-dependencies', {
  packages: [
    { ecosystem: 'npm', name: 'dsh-assembler-no-such-package-xyzzy', version: '1.0.0' }, // 零命中
    { ecosystem: 'npm', name: 'lodash', version: '4.17.15' },   // 有漏洞(2021 年代公告,稳定)
    { ecosystem: 'PyPI', name: 'requests', version: '2.19.0' }, // 有漏洞,另一个 ecosystem
  ],
}));
check('批量扫了 3 个', batch?.scanned === 3);
check('结果条数与输入一致', (batch?.results ?? []).length === 3);
check('位置对齐:第 1 个零命中(上游给空对象)', batch?.results?.[0]?.vulnCount === 0, JSON.stringify(batch?.results?.[0]?.vulnIds));
check('位置对齐:第 2 个(4.17.15)有命中', batch?.results?.[1]?.vulnCount > 0);
check('位置对齐:第 3 个(PyPI requests)有命中', batch?.results?.[2]?.vulnCount > 0);
check('每行回显包坐标', batch?.results?.[1]?.name === 'lodash' && batch?.results?.[1]?.ecosystem === 'npm');
check('统计口径自洽',
  batch?.packagesWithFindings === (batch?.results ?? []).filter((r) => r.vulnCount > 0).length
  && batch?.totalFindings === (batch?.results ?? []).reduce((n, r) => n + r.vulnCount, 0));
check('分诊层如实说明只有 id', /只有 id/.test(batch?.note ?? ''));
check('分诊不夹带详情(行里没有 summary/cvss)',
  (batch?.results ?? []).every((r) => r.summary === undefined && r.cvss === undefined));

// ── get-vulnerability ──────────────────────────────────────────────────────
const pickedId = batch?.results?.[1]?.vulnIds?.[0];
const one = json(await call('get-vulnerability', { id: pickedId }));
check('按 id 取到同一条', one?.id === pickedId, `${pickedId} -> ${one?.id}`);
check('带受影响包清单', Array.isArray(one?.affectedPackages) && one.affectedPackages.length > 0);
check('参考链接最多 5 条', (one?.references ?? []).length <= 5);
check('默认不附长文 details', one?.details === undefined);
const withDetails = json(await call('get-vulnerability', { id: pickedId, includeDetails: true }));
check('显式索取时才给 details', typeof withDetails?.details === 'string' && withDetails.details.length > 0);

// ── 错误路径 ───────────────────────────────────────────────────────────────
const badEco = await call('scan-package', { ecosystem: 'pypi', name: 'requests', version: '2.19.0' });
check('ecosystem 拼错 → isError', badEco.isError === true);
check('拼错时给出正确拼写指路', /PyPI/.test(text(badEco)) && /大小写敏感/.test(text(badEco)), text(badEco).slice(0, 120));

const missing = await call('get-vulnerability', { id: 'GHSA-0000-0000-0000' });
check('不存在的 id → isError(不是假装查到)', missing.isError === true, text(missing).slice(0, 100));

const tooMany = await call('scan-dependencies', {
  packages: Array.from({ length: 201 }, (_, i) => ({ ecosystem: 'npm', name: `p${i}`, version: '1.0.0' })),
});
check('超上限本地拦下', tooMany.isError === true);
check('拦下时说清上限与做法', /201/.test(text(tooMany)) && /分批/.test(text(tooMany)));

await client.close();
console.log(failures === 0 ? '\nosv-vulns smoke: ALL PASS' : `\nosv-vulns smoke: ${failures} FAILED`);
process.exit(failures);
