#!/usr/bin/env node
/**
 * MCP stdio server: npm + PyPI 包元数据(供应链尽调)。
 * 能力点:两个生态**一个接口**——查一个包的名称/最新版本/许可证/简介/主页/仓库/依赖数量、
 * 看最近几版的发布节奏、批量核查一串包的许可证合规,一轮内完成。
 *
 * 服务:https://registry.npmjs.org(条款 https://docs.npmjs.com/policies/terms)
 *      https://pypi.org(PyPI JSON API,PSF 条款)
 * 速率限制:合理使用,建议 <5 req/s —— 零件内置串行节流(见 THROTTLE_MS),不做并发扇出。
 * 只读:仅 GET 公开元数据端点,不调用任何发布/删除/写端点。
 *
 * 返回体裁剪:上游响应极大(registry.npmjs.org/{pkg} ≈150KB,含全部历史版本正文;
 * pypi.org/pypi/{pkg}/json ≈190KB,含 releases 全量文件清单与超长 description)。
 * 本零件只把上游当数据源,**永不把原始 JSON 倒回模型上下文**:npm 的 versions/readme、
 * PyPI 的 releases/urls/description 一律就地丢弃,只留下下面这几个定长字段。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const UA = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const TIMEOUT_MS = 15000;
const THROTTLE_MS = 250; // 两次外发请求的最小间隔 → ≤4 req/s,守住上游的合理使用红线
const REGISTRIES = ['npm', 'pypi'];
const MAX_NAMES = 10; // check-license 单次最多核查的包数
const MAX_LIMIT = 20; // package-versions 单次最多返回的版本数
const MAX_SUMMARY = 240;
const MAX_LICENSE = 80;
const MAX_URL = 200;

const server = new McpServer({ name: 'package-registry', version: '0.0.1' });

// ── 网络层:节流 + 超时 + 结构化错误 ────────────────────────────────────────
let lastRequestAt = 0;
async function throttle() {
  const wait = lastRequestAt + THROTTLE_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

const isTimeout = (err) =>
  err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.cause?.name === 'TimeoutError';

/**
 * 取 JSON。返回 { ok: true, data } 或 { ok: false, kind, message }。
 * kind: 'notfound'(404,业务上是正常结果)| 'timeout' | 'http' | 'network' | 'parse'。
 * 任何情况都不抛裸异常,且 message 必须说清「哪个服务出了什么问题」。
 */
async function fetchJson(url, service) {
  await throttle();
  let res;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });
  } catch (err) {
    return isTimeout(err)
      ? { ok: false, kind: 'timeout', message: `${service} 请求超时(${TIMEOUT_MS / 1000}s 内未返回):${url}` }
      : { ok: false, kind: 'network', message: `${service} 网络请求失败:${err?.message ?? String(err)}(${url})` };
  }
  if (res.status === 404) return { ok: false, kind: 'notfound', message: `${service} 未收录该包(HTTP 404)` };
  if (!res.ok) {
    const hint = res.status === 429 ? ',已触发上游限流,请降低调用频率后重试' : '';
    return { ok: false, kind: 'http', message: `${service} 返回 HTTP ${res.status} ${res.statusText}${hint}(${url})` };
  }
  try {
    return { ok: true, data: await res.json() };
  } catch (err) {
    return isTimeout(err)
      ? { ok: false, kind: 'timeout', message: `${service} 响应体读取超时(${TIMEOUT_MS / 1000}s):${url}` }
      : { ok: false, kind: 'parse', message: `${service} 响应不是合法 JSON(HTTP ${res.status}):${err?.message ?? String(err)}` };
  }
}

// ── 返回封装 ────────────────────────────────────────────────────────────────
const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });

// ── 输入校验(手动校验,失败走 isError 而不是协议级异常,便于模型自纠) ──────
function checkRegistry(registry) {
  if (typeof registry !== 'string' || !REGISTRIES.includes(registry)) {
    return `registry 非法:只接受 ${REGISTRIES.join(' | ')},收到 ${JSON.stringify(registry)}`;
  }
  return null;
}
function checkName(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) return 'package 不能为空';
  if (n.length > 214) return `package 名过长(${n.length} > 214)`;
  if (/\s/.test(n)) return `package 名不能含空白字符:${JSON.stringify(name)}`;
  return null;
}

// ── 字段裁剪工具 ────────────────────────────────────────────────────────────
const clip = (value, max) => {
  const s = typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};
const cleanRepo = (url) =>
  clip(String(url ?? '').replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, ''), MAX_URL);
const encodeName = (name) => encodeURIComponent(name).replace(/^%40/, '@'); // @scope/pkg → @scope%2Fpkg

/** npm 的 license 可能是字符串、{type,url}、或老包的 licenses 数组。 */
function npmLicense(doc) {
  const raw = doc.license ?? doc.licenses;
  if (typeof raw === 'string') return clip(raw, MAX_LICENSE);
  if (Array.isArray(raw)) {
    return clip(raw.map((x) => (typeof x === 'string' ? x : x?.type ?? x?.name)).filter(Boolean).join(' OR '), MAX_LICENSE);
  }
  if (raw && typeof raw === 'object') return clip(raw.type ?? raw.name ?? '', MAX_LICENSE);
  return '';
}

/**
 * PyPI 的 license 字段是个坑:新包用 license_expression(SPDX),老包 license 里可能塞了
 * **整篇许可证正文**(几 KB)。所以:SPDX → 短字符串 → classifiers,长正文一律不外泄。
 */
function pypiLicense(info) {
  const expr = (info.license_expression ?? '').trim();
  if (expr) return clip(expr, MAX_LICENSE);
  const raw = (info.license ?? '').trim();
  if (raw && raw.length <= MAX_LICENSE && !raw.includes('\n')) return raw;
  const fromClassifiers = (info.classifiers ?? [])
    .filter((c) => typeof c === 'string' && c.startsWith('License ::'))
    .map((c) => c.split('::').pop().trim());
  if (fromClassifiers.length) return clip(fromClassifiers.join(' / '), MAX_LICENSE);
  return raw ? `(license 字段是 ${raw.length} 字符的许可证正文,已省略)` : '';
}

const pickUrl = (urls, keys) => {
  for (const k of keys) {
    const hit = Object.entries(urls ?? {}).find(([name]) => name.toLowerCase() === k);
    if (hit?.[1]) return hit[1];
  }
  return '';
};

// ── 统一形状:两个生态一个 shape ────────────────────────────────────────────
async function packageInfo(registry, name) {
  if (registry === 'npm') {
    // /{pkg}/latest 只有最新版的 package.json(~2KB),比全量 packument(~150KB)省得多。
    const r = await fetchJson(`https://registry.npmjs.org/${encodeName(name)}/latest`, 'npm registry');
    if (!r.ok) return r;
    const d = r.data;
    const repo = cleanRepo(typeof d.repository === 'string' ? d.repository : d.repository?.url);
    return {
      ok: true,
      shape: {
        registry: 'npm',
        found: true,
        name: clip(d.name ?? name, 214),
        version: clip(d.version ?? '', 64),
        license: npmLicense(d),
        summary: clip(d.description ?? '', MAX_SUMMARY),
        homepage: clip(d.homepage ?? repo, MAX_URL),
        repository: repo,
        dependencyCount: Object.keys(d.dependencies ?? {}).length,
        deprecated: d.deprecated ? clip(d.deprecated, MAX_SUMMARY) : null,
      },
    };
  }
  const r = await fetchJson(`https://pypi.org/pypi/${encodeName(name)}/json`, 'PyPI');
  if (!r.ok) return r;
  const info = r.data?.info ?? {}; // releases / urls / description 就地丢弃,不进返回体
  const repo = cleanRepo(pickUrl(info.project_urls, ['source', 'repository', 'source code', 'code', 'github']));
  return {
    ok: true,
    shape: {
      registry: 'pypi',
      found: true,
      name: clip(info.name ?? name, 214),
      version: clip(info.version ?? '', 64),
      license: pypiLicense(info),
      summary: clip(info.summary ?? '', MAX_SUMMARY),
      homepage: clip(info.home_page || pickUrl(info.project_urls, ['homepage', 'home']) || info.package_url || '', MAX_URL),
      repository: repo,
      dependencyCount: (info.requires_dist ?? []).length,
      deprecated: info.yanked ? clip(info.yanked_reason ?? 'yanked', MAX_SUMMARY) : null,
    },
  };
}

const notFoundShape = (registry, name, message) => ({
  registry,
  found: false,
  name,
  note: message,
  hint: registry === 'npm' ? 'npm 包名区分大小写与 scope,确认拼写或是否为私有包' : 'PyPI 包名不区分大小写但需拼写正确,确认是否为发行名而非导入名',
});

// ── 工具一:package-info ────────────────────────────────────────────────────
server.registerTool('package-info', {
  description:
    '查一个包在 npm 或 PyPI 上的公开元数据,两个生态返回**同一形状**:'
    + 'name / version(最新版)/ license / summary / homepage / repository / dependencyCount / deprecated。'
    + '用于依赖尽调、许可证核对、确认包是否还在维护。包不存在时返回 found:false 的结构化说明(不是错误)。',
  inputSchema: {
    registry: z.string().describe('包生态:npm 或 pypi'),
    package: z.string().describe('包名,如 npm 的 "diff"/"@scope/pkg",PyPI 的 "requests"'),
  },
}, async ({ registry, package: name }) => {
  const bad = checkRegistry(registry) ?? checkName(name);
  if (bad) return fail(`package-info 参数错误:${bad}`);
  const pkg = name.trim();
  const r = await packageInfo(registry, pkg);
  if (r.ok) return ok(r.shape);
  if (r.kind === 'notfound') return ok(notFoundShape(registry, pkg, r.message));
  return fail(`package-info 失败:${r.message}`);
});

// ── 工具二:package-versions ────────────────────────────────────────────────
server.registerTool('package-versions', {
  description:
    '列出一个包最近发布的 N 个版本及其发布时间(按时间倒序),用于判断维护活跃度、'
    + '定位某次改动落在哪个版本、核对版本节奏。返回 latest、总版本数与 versions 数组。'
    + `limit 默认 10,上限 ${MAX_LIMIT}。`,
  inputSchema: {
    registry: z.string().describe('包生态:npm 或 pypi'),
    package: z.string().describe('包名'),
    limit: z.number().int().optional().describe(`返回最近几个版本,默认 10,上限 ${MAX_LIMIT}`),
  },
}, async ({ registry, package: name, limit }) => {
  const bad = checkRegistry(registry) ?? checkName(name);
  if (bad) return fail(`package-versions 参数错误:${bad}`);
  const pkg = name.trim();
  const n = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 10, 1), MAX_LIMIT);

  let latest = '';
  let entries = []; // [version, ISO 时间]

  if (registry === 'npm') {
    // 全量 packument 很大;只读 dist-tags 与 time,versions/readme 全部丢弃。
    const r = await fetchJson(`https://registry.npmjs.org/${encodeName(pkg)}`, 'npm registry');
    if (!r.ok) {
      return r.kind === 'notfound' ? ok(notFoundShape(registry, pkg, r.message)) : fail(`package-versions 失败:${r.message}`);
    }
    latest = r.data?.['dist-tags']?.latest ?? '';
    entries = Object.entries(r.data?.time ?? {}).filter(([v]) => v !== 'created' && v !== 'modified');
  } else {
    const r = await fetchJson(`https://pypi.org/pypi/${encodeName(pkg)}/json`, 'PyPI');
    if (!r.ok) {
      return r.kind === 'notfound' ? ok(notFoundShape(registry, pkg, r.message)) : fail(`package-versions 失败:${r.message}`);
    }
    latest = r.data?.info?.version ?? '';
    // releases 是整个响应里最大的一块;这里只从中提炼「版本 → 最早上传时间」,随后整块丢弃。
    entries = Object.entries(r.data?.releases ?? {})
      .map(([v, files]) => {
        const times = (files ?? []).map((f) => f?.upload_time_iso_8601 ?? f?.upload_time).filter(Boolean).sort();
        return [v, times[0] ?? ''];
      })
      .filter(([, t]) => t);
  }

  const sorted = entries.sort((a, b) => String(b[1]).localeCompare(String(a[1])));
  return ok({
    registry,
    found: true,
    name: pkg,
    latest: clip(latest, 64),
    totalVersions: entries.length,
    versions: sorted.slice(0, n).map(([version, publishedAt]) => ({ version: clip(version, 64), publishedAt })),
  });
});

// ── 工具三:check-license ───────────────────────────────────────────────────
server.registerTool('check-license', {
  description:
    `批量核查一串包的许可证(同一生态,单次最多 ${MAX_NAMES} 个),供应链合规逐条过账用。`
    + '每条返回 name / found / version / license。请求**串行**发出并自带节流,不并发扇出;'
    + '未收录的包记 found:false 并继续核查其余包,不中断整批。',
  inputSchema: {
    registry: z.string().describe('包生态:npm 或 pypi'),
    packages: z.array(z.string()).describe(`包名列表,最多 ${MAX_NAMES} 个`),
  },
}, async ({ registry, packages }) => {
  const badRegistry = checkRegistry(registry);
  if (badRegistry) return fail(`check-license 参数错误:${badRegistry}`);
  if (!Array.isArray(packages) || packages.length === 0) return fail('check-license 参数错误:packages 至少要有 1 个包名');
  if (packages.length > MAX_NAMES) {
    return fail(`check-license 参数错误:单次最多核查 ${MAX_NAMES} 个包(收到 ${packages.length} 个),请分批调用`);
  }
  for (const p of packages) {
    const bad = checkName(p);
    if (bad) return fail(`check-license 参数错误:${bad}`);
  }

  const results = [];
  for (const raw of packages) { // 串行:上游速率限制优先于本零件的延迟
    const pkg = raw.trim();
    const r = await packageInfo(registry, pkg);
    if (r.ok) {
      results.push({ name: r.shape.name, found: true, version: r.shape.version, license: r.shape.license, deprecated: r.shape.deprecated });
    } else if (r.kind === 'notfound') {
      results.push({ name: pkg, found: false, version: null, license: null, note: r.message });
    } else {
      // 单个包的网络故障不该毁掉整批;记下来,让模型看得见哪几条没查成。
      results.push({ name: pkg, found: null, version: null, license: null, note: r.message });
    }
  }

  const distinct = [...new Set(results.map((x) => x.license).filter(Boolean))].sort();
  return ok({
    registry,
    checked: results.length,
    unresolved: results.filter((x) => x.found !== true).length,
    distinctLicenses: distinct,
    results,
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
