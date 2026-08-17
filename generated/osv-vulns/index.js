#!/usr/bin/env node
/**
 * MCP stdio server: OSV.dev(https://api.osv.dev)漏洞查询适配。
 *
 * 能力点(三个完整动作,不是端点的一对一翻译):
 *   1. scan-package        单个包版本 → 命中的漏洞(含修复版本、CVSS、CWE)
 *   2. scan-dependencies   一批包版本 → 逐包命中统计(依赖清单进料的分诊层)
 *   3. get-vulnerability   一个 OSV/GHSA id → 该条漏洞的完整判定材料
 *
 * **为什么是这三个**:治理流程本来就是"先分诊、再深挖、最后给结论"。
 * 上游的 /v1/querybatch 只回 id 不回详情(实测),所以批量天然是分诊层——
 * 拿到 id 之后要严重度还得逐条查。这个不对称是接口的事实,不是本零件的取舍,
 * 因此如实暴露成两个工具,而不是在批量里偷偷扇出上千次请求。
 *
 * **返回体裁剪**:OSV 单条漏洞原文约 4.8KB(details 长文 + affected.versions
 * 可能上千项),一个 lodash 版本就命中 6 条 ≈ 29KB。全塞进上下文会把 agent 的
 * 预算烧在它用不上的字节上,所以这里只留能驱动决策的字段:id / 别名(CVE)/
 * 摘要 / 严重度 / CWE / **修复版本** / 时间戳。要长文的场景走 get-vulnerability。
 *
 * **ecosystem 大小写敏感**(实测):`npm` 小写、`PyPI` 大写 P 大写 I、
 * `crates.io` 带点。写错上游回 {"code":3,"message":"invalid ecosystem"},
 * 本零件把它转成带正确拼写清单的可行动错误。
 *
 * 只读:三个端点都是查询,不改客户系统。无凭证——OSV 公共接口不需要 key。
 * 数据许可按来源不同(OSV- 前缀记录 CC-BY-4.0,GHSA 等随上游),署名随每次返回。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVICE = 'OSV.dev(api.osv.dev)';
const BASE_URL = 'https://api.osv.dev';
const UA = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const TIMEOUT_MS = 20000;
const MIN_GAP_MS = 120;
const ATTRIBUTION = 'Vulnerability data from OSV.dev; per-record licence follows its source database (OSV-prefixed records are CC-BY-4.0).';

/** 上游 querybatch 的硬上限是 1000;这里收到 200,一次调用不该是一场扫描战役。 */
const MAX_BATCH = 200;
/** 分诊之外的裁剪上限:一个包命中超过这个数就截断并如实报告截断。 */
const MAX_VULNS_PER_PACKAGE = 25;

/** OSV 的 ecosystem 取值大小写敏感,这里是治理场景常见的那些(上游全量见其文档)。 */
const ECOSYSTEMS = [
  'npm', 'PyPI', 'Go', 'Maven', 'crates.io', 'RubyGems', 'NuGet',
  'Packagist', 'Hex', 'Pub', 'CRAN', 'SwiftURL', 'Debian', 'Ubuntu', 'Alpine',
];

const server = new McpServer({ name: 'osv-vulns', version: '0.0.1' });

const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });

let lastRequestAt = 0;

/** 传输层失败重试一次并绕开代理(某些网络下代理对特定主机不通)。 */
async function fetchWithProxyFallback(url, init) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const proxied = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (!proxied) throw err;
    const { Agent } = await import('undici');
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), dispatcher: new Agent() });
  }
}

/**
 * 一次请求 + JSON 解析。超时 / 非 2xx / 解析失败一律返回 { error: 文本 },
 * 绝不向上抛裸异常;HTTP 状态码从不重试(只有传输层失败才重试一次)。
 */
async function request(path, body, what) {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  const init = body === undefined
    ? { method: 'GET', headers: { 'User-Agent': UA, Accept: 'application/json' } }
    : { method: 'POST', headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) };

  let res;
  try {
    res = await fetchWithProxyFallback(`${BASE_URL}${path}`, init);
  } catch (err) {
    const name = err?.name ?? '';
    if (name === 'TimeoutError' || name === 'AbortError') return { error: `${SERVICE} ${what} 超时:${TIMEOUT_MS}ms 内未返回` };
    return { error: `${SERVICE} ${what} 网络请求失败:${err?.message ?? String(err)}` };
  }

  const text = await res.text().catch(() => '');
  let parsed;
  try {
    parsed = text === '' ? {} : JSON.parse(text);
  } catch {
    return { error: `${SERVICE} ${what} 返回的不是合法 JSON(HTTP ${res.status}):${text.slice(0, 200)}` };
  }

  if (!res.ok) {
    // 上游用 { code, message } 报错;ecosystem 拼错是最常见的一种,单独给指路。
    const message = String(parsed?.message ?? text.slice(0, 200));
    if (/invalid ecosystem/i.test(message)) {
      return { error: `${SERVICE} 拒绝了 ecosystem 取值(大小写敏感)。合法拼写例如:${ECOSYSTEMS.join('、')}。上游原文:${message}` };
    }
    return { error: `${SERVICE} ${what} 失败:HTTP ${res.status} ${message}` };
  }
  return { value: parsed };
}

/**
 * 从 affected[].ranges[].events[] 里抠出可执行的升级目标。
 * SEMVER/ECOSYSTEM 型区间的 `fixed` 才是"升到哪个版本就没事了";GIT 型给的是
 * commit 哈希,对依赖治理没有直接用处,所以只在没有别的可说时才带上并标明。
 */
function fixVersions(affected) {
  const semverFixed = new Set();
  const gitFixed = new Set();
  const lastAffected = new Set();
  for (const a of Array.isArray(affected) ? affected : []) {
    for (const r of Array.isArray(a.ranges) ? a.ranges : []) {
      for (const e of Array.isArray(r.events) ? r.events : []) {
        if (e.fixed !== undefined) (r.type === 'GIT' ? gitFixed : semverFixed).add(String(e.fixed));
        if (e.last_affected !== undefined) lastAffected.add(String(e.last_affected));
      }
    }
  }
  if (semverFixed.size > 0) return { fixedIn: [...semverFixed] };
  if (lastAffected.size > 0) return { fixedIn: [], lastAffected: [...lastAffected] };
  if (gitFixed.size > 0) return { fixedIn: [], fixedCommits: [...gitFixed].slice(0, 3) };
  return { fixedIn: [] };
}

/** 一条漏洞 → 驱动决策所需的最小字段集(原文约 4.8KB,这里约 0.3KB)。 */
function digest(v) {
  const dbs = v.database_specific ?? {};
  const cvss = (Array.isArray(v.severity) ? v.severity : []).find((s) => typeof s?.score === 'string');
  return {
    id: v.id,
    aliases: (v.aliases ?? []).slice(0, 6),
    summary: String(v.summary ?? '').replace(/\s+/g, ' ').slice(0, 200),
    qualitativeSeverity: dbs.severity ?? null,
    cvss: cvss?.score ?? null,
    cvssType: cvss?.type ?? null,
    cwe: (dbs.cwe_ids ?? []).slice(0, 6),
    ...fixVersions(v.affected),
    published: v.published ?? null,
    modified: v.modified ?? null,
    ...(v.withdrawn === undefined ? {} : { withdrawn: v.withdrawn }),
  };
}

const packageShape = {
  ecosystem: z.string().describe(`OSV ecosystem，大小写敏感。例如：${ECOSYSTEMS.slice(0, 7).join('、')}`),
  name: z.string().describe('包名，按该 ecosystem 的惯例书写（Maven 用 group:artifact，Go 用 module path）'),
  version: z.string().describe('具体版本号，例如 4.17.15'),
};

server.registerTool(
  'scan-package',
  {
    description: '查一个包的某个具体版本命中哪些已知漏洞，返回每条漏洞的严重度、CWE 与**应升到的修复版本**。只读，不需要凭证。',
    inputSchema: packageShape,
  },
  async ({ ecosystem, name, version }) => {
    const res = await request('/v1/query', { package: { name, ecosystem }, version }, `查询 ${ecosystem}/${name}@${version}`);
    if (res.error !== undefined) return fail(res.error);
    const all = Array.isArray(res.value?.vulns) ? res.value.vulns : [];
    const shown = all.slice(0, MAX_VULNS_PER_PACKAGE);
    return ok({
      package: { ecosystem, name, version },
      vulnCount: all.length,
      ...(all.length > shown.length ? { truncated: `仅列出前 ${shown.length} 条，共 ${all.length} 条` } : {}),
      vulns: shown.map(digest),
      attribution: ATTRIBUTION,
    });
  },
);

server.registerTool(
  'scan-dependencies',
  {
    description: `一次过一批包版本做分诊：逐包给出命中漏洞的条数与 id 列表。上游批量端点只回 id 不回详情，所以这里是**分诊层**——要某条漏洞的严重度和修复版本，再用 get-vulnerability 或对该包单独 scan-package。单次最多 ${MAX_BATCH} 个包。只读，不需要凭证。`,
    inputSchema: {
      packages: z.array(z.object(packageShape)).min(1).describe('要分诊的包版本清单'),
    },
  },
  async ({ packages }) => {
    if (packages.length > MAX_BATCH) {
      return fail(`一次最多分诊 ${MAX_BATCH} 个包，收到 ${packages.length} 个。请分批调用（上游硬上限是 1000，这里刻意收紧以免一次调用变成一场扫描战役）。`);
    }
    const queries = packages.map((p) => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version }));
    const res = await request('/v1/querybatch', { queries }, `批量分诊 ${packages.length} 个包`);
    if (res.error !== undefined) return fail(res.error);
    // 上游按输入顺序位置对齐返回;没命中的位置是空对象而不是缺位。
    const results = Array.isArray(res.value?.results) ? res.value.results : [];
    const rows = packages.map((p, i) => {
      const ids = (results[i]?.vulns ?? []).map((v) => v.id);
      return { ...p, vulnCount: ids.length, vulnIds: ids };
    });
    return ok({
      scanned: packages.length,
      packagesWithFindings: rows.filter((r) => r.vulnCount > 0).length,
      totalFindings: rows.reduce((n, r) => n + r.vulnCount, 0),
      results: rows,
      note: '这是分诊结果，只有 id。严重度与修复版本请对命中的包调 scan-package，或对单条 id 调 get-vulnerability。',
      attribution: ATTRIBUTION,
    });
  },
);

server.registerTool(
  'get-vulnerability',
  {
    description: '按 OSV / GHSA / CVE-别名 id 取一条漏洞的完整判定材料：严重度、CWE、受影响范围、修复版本与参考链接。只读，不需要凭证。',
    inputSchema: {
      id: z.string().describe('漏洞 id，例如 GHSA-29mw-wpgm-hmr9 或 OSV-2020-111'),
      includeDetails: z.boolean().optional().describe('是否附上上游的长篇 details 正文（默认不附，正文可达数千字）'),
    },
  },
  async ({ id, includeDetails }) => {
    const res = await request(`/v1/vulns/${encodeURIComponent(id)}`, undefined, `取漏洞 ${id}`);
    if (res.error !== undefined) return fail(res.error);
    const v = res.value ?? {};
    if (v.id === undefined) return fail(`${SERVICE} 没有返回 id 为 ${id} 的漏洞记录(响应里没有 id 字段)。`);
    const affectedPackages = (Array.isArray(v.affected) ? v.affected : []).map((a) => ({
      ecosystem: a.package?.ecosystem ?? null,
      name: a.package?.name ?? null,
      ...fixVersions([a]),
    }));
    return ok({
      ...digest(v),
      affectedPackages: affectedPackages.slice(0, 20),
      ...(affectedPackages.length > 20 ? { affectedPackagesTruncated: `共 ${affectedPackages.length} 个受影响包，仅列前 20 个` } : {}),
      references: (v.references ?? []).slice(0, 5).map((r) => ({ type: r.type, url: r.url })),
      ...(includeDetails === true ? { details: String(v.details ?? '').slice(0, 6000) } : {}),
      attribution: ATTRIBUTION,
    });
  },
);

await server.connect(new StdioServerTransport());
