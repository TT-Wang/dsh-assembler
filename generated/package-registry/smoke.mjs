#!/usr/bin/env node
/**
 * 冒烟(需真实网络):listTools → npm 查包 → PyPI 查包(并证明巨型响应被裁剪)→
 * 最近版本列表 → 批量许可证核查 → 不存在的包(未找到,非错误)→ 非法 registry(isError)。
 *
 * 抗数据漂移:版本号、发布时间、依赖数量天天变,一律只断言**结构与量纲**
 * (字段存在、版本形如 x.y.z、时间是 ISO、条数对得上),不断言具体数值。
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
const bytes = (r) => Buffer.byteLength(text(r), 'utf8');
const json = (r) => { try { return JSON.parse(text(r)); } catch { return null; } };
const SEMVERISH = /^\d+\.\d+\.\d+/;
const ISO = /^\d{4}-\d{2}-\d{2}T/;
const call = async (name, args) => {
  try { return await client.callTool({ name, arguments: args }); }
  catch (err) { return { isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] }; }
};

const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname], env: NETWORK_ENV });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
check('listTools 返回 3 个工具', tools.tools.length === 3, tools.tools.map((t) => t.name).join(','));

// ── npm:package-info ───────────────────────────────────────────────────────
const r1 = await call('package-info', { registry: 'npm', package: 'diff' });
const d1 = json(r1);
check('npm package-info 返回 JSON', d1 !== null, text(r1).slice(0, 120));
check('npm name 正确', d1?.name === 'diff', String(d1?.name));
check('npm version 形如 x.y.z', SEMVERISH.test(d1?.version ?? ''), String(d1?.version));
check('npm license 非空', typeof d1?.license === 'string' && d1.license.length > 0, String(d1?.license));
check('npm 统一形状字段齐备',
  ['registry', 'name', 'version', 'license', 'summary', 'homepage', 'repository', 'dependencyCount'].every((k) => k in (d1 ?? {})),
  Object.keys(d1 ?? {}).join(','));
check('npm dependencyCount 是非负整数', Number.isInteger(d1?.dependencyCount) && d1.dependencyCount >= 0, String(d1?.dependencyCount));
check('npm 返回体 < 3KB', bytes(r1) < 3072, `${bytes(r1)} B`);

// ── PyPI:package-info(上游 ~190KB,这里必须是裁剪后的小体) ───────────────
const r2 = await call('package-info', { registry: 'pypi', package: 'requests' });
const d2 = json(r2);
check('pypi package-info 返回 JSON', d2 !== null, text(r2).slice(0, 120));
check('pypi name 正确', String(d2?.name).toLowerCase() === 'requests', String(d2?.name));
check('pypi version 形如 x.y.z', SEMVERISH.test(d2?.version ?? ''), String(d2?.version));
check('pypi 有许可证信息(license 字段非空)', typeof d2?.license === 'string' && d2.license.length > 0, String(d2?.license));
check('pypi 与 npm 是同一形状', JSON.stringify(Object.keys(d2 ?? {}).sort()) === JSON.stringify(Object.keys(d1 ?? {}).sort()),
  Object.keys(d2 ?? {}).join(','));
check('pypi 巨型响应已裁剪:返回体 < 3KB', bytes(r2) < 3072, `${bytes(r2)} B(上游 ~190KB)`);
check('pypi releases/description 未回流上下文', !text(r2).includes('"releases"') && !text(r2).includes('"description"'));

// ── package-versions ───────────────────────────────────────────────────────
const r3 = await call('package-versions', { registry: 'npm', package: 'diff', limit: 5 });
const d3 = json(r3);
check('npm versions 返回 5 条', Array.isArray(d3?.versions) && d3.versions.length === 5, String(d3?.versions?.length));
check('npm versions 每条含版本号与 ISO 发布时间',
  (d3?.versions ?? []).every((v) => SEMVERISH.test(v.version) && ISO.test(v.publishedAt)),
  JSON.stringify(d3?.versions?.[0] ?? {}));
check('npm versions 按时间倒序',
  (d3?.versions ?? []).every((v, i, a) => i === 0 || a[i - 1].publishedAt >= v.publishedAt));
check('npm totalVersions 是正整数', Number.isInteger(d3?.totalVersions) && d3.totalVersions > 0, String(d3?.totalVersions));
check('npm versions 返回体 < 3KB', bytes(r3) < 3072, `${bytes(r3)} B`);

const r4 = await call('package-versions', { registry: 'pypi', package: 'requests', limit: 3 });
const d4 = json(r4);
check('pypi versions 返回 3 条', Array.isArray(d4?.versions) && d4.versions.length === 3, String(d4?.versions?.length));
check('pypi versions 每条含 ISO 发布时间', (d4?.versions ?? []).every((v) => ISO.test(v.publishedAt)),
  JSON.stringify(d4?.versions?.[0] ?? {}));
check('pypi versions 返回体 < 3KB', bytes(r4) < 3072, `${bytes(r4)} B`);

// ── check-license:批量核查 ────────────────────────────────────────────────
const r5 = await call('check-license', { registry: 'npm', packages: ['diff', 'zod'] });
const d5 = json(r5);
check('check-license 返回 2 条', Array.isArray(d5?.results) && d5.results.length === 2, String(d5?.results?.length));
check('check-license 每条都有 license 字段', (d5?.results ?? []).every((x) => 'license' in x),
  JSON.stringify(d5?.results?.[0] ?? {}));
check('check-license 两个包都查到了非空 license',
  (d5?.results ?? []).every((x) => x.found === true && typeof x.license === 'string' && x.license.length > 0),
  (d5?.results ?? []).map((x) => `${x.name}=${x.license}`).join(' '));
check('check-license 返回体 < 3KB', bytes(r5) < 3072, `${bytes(r5)} B`);

// ── 错误路径 ───────────────────────────────────────────────────────────────
const r6 = await call('package-info', { registry: 'npm', package: 'dsh-assembler-no-such-package-zzz9' });
const d6 = json(r6);
check('不存在的包返回结构化未找到(不是 isError)', d6?.found === false && r6.isError !== true, text(r6).slice(0, 120));

const r7 = await call('package-info', { registry: 'cargo', package: 'serde' });
check('非法 registry 被拒(isError)', r7.isError === true || /registry 非法/.test(text(r7)), text(r7).slice(0, 120));

const r8 = await call('check-license', { registry: 'npm', packages: Array.from({ length: 11 }, (_, i) => `p${i}`) });
check('check-license 超过 10 个包被拒', r8.isError === true || /最多核查/.test(text(r8)), text(r8).slice(0, 120));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
