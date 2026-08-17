#!/usr/bin/env node
/**
 * MCP stdio server: deps.dev v3(https://api.deps.dev/v3)适配。
 *
 * 能力点(三个完整动作):
 *   1. package-licence    一个包版本 → 许可证、是否弃用、发布时间、公告 id、来源链接
 *   2. resolved-dependencies  一个包版本 → 解析后的依赖闭包(直接/间接分开计数)
 *   3. list-versions      一个包 → 版本总数、默认(latest)版本、最近若干版
 *
 * **为什么和漏洞查询分开**:治理的两个问题是"有没有漏洞"和"许可证能不能用",
 * 前者问 OSV,后者问 deps.dev。它们是两个上游、两套字段口径,合成一个零件会
 * 让"某个字段来自哪一方"变得不可追溯——供应链清单要的正是这份可追溯。
 *
 * **system 取值大小写:两个上游不一致(实测)**。deps.dev 大小写不敏感,内部
 * 归一成大写(`npm`/`NPM`/`PyPI` 都通,回显 `NPM`/`PYPI`);OSV 严格区分,只认
 * `npm` 小写、`PyPI` 那个确切拼法。**同一份依赖清单喂两边要用两种拼法**,所以
 * 这里的工具描述照实说明,并接受任意大小写后自行归一。
 *
 * **返回体裁剪**:express@4.18.2 的依赖闭包原文 71 节点 / 128 边 ≈ 15KB,
 * lodash 的版本列表 117 项 ≈ 19KB。默认只回聚合与前若干项,要全量得显式索取。
 *
 * 只读:三个端点都是查询,不改客户系统。无凭证——deps.dev 公共接口不需要 key。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVICE = 'deps.dev(api.deps.dev/v3)';
const BASE_URL = 'https://api.deps.dev/v3';
const UA = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const TIMEOUT_MS = 20000;
const MIN_GAP_MS = 120;
const ATTRIBUTION = 'Package metadata from deps.dev (Google); licence fields are mirrored from the upstream registry and are advisory, not a legal determination.';

/** deps.dev 认的包体系。大小写不敏感,这里列的是它回显的规范写法。 */
const SYSTEMS = ['NPM', 'GO', 'MAVEN', 'PYPI', 'CARGO', 'NUGET', 'RUBYGEMS'];
/** 依赖闭包默认最多列这么多节点;超了给聚合 + 截断说明。 */
const MAX_NODES = 60;
/** 版本列表默认回最近这么多个。 */
const MAX_VERSIONS = 15;

const server = new McpServer({ name: 'deps-graph', version: '0.0.1' });

const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });

let lastRequestAt = 0;

/** 传输层失败重试一次并绕开代理(某些网络下代理对特定主机不通)。 */
async function fetchWithProxyFallback(url) {
  const init = { headers: { 'User-Agent': UA, Accept: 'application/json' } };
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const proxied = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (!proxied) throw err;
    const { Agent } = await import('undici');
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), dispatcher: new Agent() });
  }
}

/** GET + JSON。超时 / 非 2xx / 解析失败一律 { error: 文本 },绝不抛裸异常。 */
async function getJson(path, what) {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  let res;
  try {
    res = await fetchWithProxyFallback(`${BASE_URL}${path}`);
  } catch (err) {
    const name = err?.name ?? '';
    if (name === 'TimeoutError' || name === 'AbortError') return { error: `${SERVICE} ${what} 超时:${TIMEOUT_MS}ms 内未返回` };
    return { error: `${SERVICE} ${what} 网络请求失败:${err?.message ?? String(err)}` };
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    if (res.status === 404) {
      return { error: `${SERVICE} 查不到 ${what}(HTTP 404 ${text.slice(0, 80)})。请核对 system / 包名 / 版本号是否都存在——包名要按该体系惯例写(Maven 用 group:artifact,Go 用完整 module path)。` };
    }
    return { error: `${SERVICE} ${what} 失败:HTTP ${res.status} ${text.slice(0, 200)}` };
  }
  try {
    return { value: text === '' ? {} : JSON.parse(text) };
  } catch {
    return { error: `${SERVICE} ${what} 返回的不是合法 JSON:${text.slice(0, 200)}` };
  }
}

/** 归一 system 拼写。deps.dev 自己不挑,但回显是大写,统一按它的规范写法发。 */
function normalizeSystem(system) {
  const up = String(system).trim().toUpperCase();
  return up === 'CRATES.IO' ? 'CARGO' : up;
}

const pkgPath = (system, name) => `/systems/${encodeURIComponent(normalizeSystem(system))}/packages/${encodeURIComponent(name)}`;

server.registerTool(
  'package-licence',
  {
    description: '查一个包版本的许可证与元数据：licences、是否已弃用（及原因）、发布时间、上游公告 id、主页/仓库链接。许可证字段来自上游注册表的镜像，是**参考信息不是法律结论**。只读，不需要凭证。',
    inputSchema: {
      system: z.string().describe(`包体系，大小写不敏感。规范写法：${SYSTEMS.join('、')}（crates.io 会被当作 CARGO）`),
      name: z.string().describe('包名（Maven 用 group:artifact，Go 用完整 module path）'),
      version: z.string().describe('具体版本号'),
    },
  },
  async ({ system, name, version }) => {
    const what = `${normalizeSystem(system)}/${name}@${version}`;
    const res = await getJson(`${pkgPath(system, name)}/versions/${encodeURIComponent(version)}`, what);
    if (res.error !== undefined) return fail(res.error);
    const v = res.value ?? {};
    const linkOf = (label) => (v.links ?? []).find((l) => l.label === label)?.url ?? null;
    return ok({
      package: { system: v.versionKey?.system ?? normalizeSystem(system), name: v.versionKey?.name ?? name, version: v.versionKey?.version ?? version },
      licenses: v.licenses ?? [],
      isDefaultVersion: v.isDefault ?? null,
      isDeprecated: v.isDeprecated ?? null,
      ...(v.isDeprecated === true ? { deprecatedReason: String(v.deprecatedReason ?? '').slice(0, 300) } : {}),
      publishedAt: v.publishedAt ?? null,
      advisoryIds: (v.advisoryKeys ?? []).map((a) => a.id),
      homepage: linkOf('HOMEPAGE'),
      sourceRepo: linkOf('SOURCE_REPO'),
      origin: linkOf('ORIGIN'),
      attribution: ATTRIBUTION,
    });
  },
);

server.registerTool(
  'resolved-dependencies',
  {
    description: `解析一个包版本的依赖闭包：直接依赖与间接依赖分别计数，并列出节点（默认最多 ${MAX_NODES} 个）。这是把"一条直接依赖"展开成"实际装进产物的那一堆"的动作——治理要管的是后者。只读，不需要凭证。`,
    inputSchema: {
      system: z.string().describe(`包体系，大小写不敏感：${SYSTEMS.join('、')}`),
      name: z.string().describe('包名'),
      version: z.string().describe('具体版本号'),
      directOnly: z.boolean().optional().describe('只列直接依赖（默认 false，列整个闭包的前若干个）'),
    },
  },
  async ({ system, name, version, directOnly }) => {
    const what = `${normalizeSystem(system)}/${name}@${version} 的依赖闭包`;
    const res = await getJson(`${pkgPath(system, name)}/versions/${encodeURIComponent(version)}:dependencies`, what);
    if (res.error !== undefined) return fail(res.error);
    const nodes = Array.isArray(res.value?.nodes) ? res.value.nodes : [];
    // 上游把被查的包本身也放在 nodes[0](relation SELF),它不是自己的依赖。
    const deps = nodes.filter((n) => n.relation !== 'SELF');
    const direct = deps.filter((n) => n.relation === 'DIRECT');
    const picked = (directOnly === true ? direct : deps).slice(0, MAX_NODES);
    const total = directOnly === true ? direct.length : deps.length;
    return ok({
      root: { system: normalizeSystem(system), name, version },
      directCount: direct.length,
      indirectCount: deps.length - direct.length,
      totalCount: deps.length,
      ...(res.value?.error ? { upstreamNote: String(res.value.error).slice(0, 200) } : {}),
      dependencies: picked.map((n) => ({
        system: n.versionKey?.system ?? null,
        name: n.versionKey?.name ?? null,
        version: n.versionKey?.version ?? null,
        relation: n.relation ?? null,
        ...(n.bundled === true ? { bundled: true } : {}),
        ...((n.errors ?? []).length > 0 ? { errors: n.errors.slice(0, 2) } : {}),
      })),
      ...(total > picked.length ? { truncated: `仅列出 ${picked.length} 个，共 ${total} 个；要全量请分批或改用 directOnly` } : {}),
      attribution: ATTRIBUTION,
    });
  },
);

server.registerTool(
  'list-versions',
  {
    description: `列一个包有哪些版本：总数、默认（latest）版本、最近 ${MAX_VERSIONS} 个版本及其发布时间与弃用状态。用来确认"该升到哪个版本"那个版本真的存在且没被弃用。只读，不需要凭证。`,
    inputSchema: {
      system: z.string().describe(`包体系，大小写不敏感：${SYSTEMS.join('、')}`),
      name: z.string().describe('包名'),
    },
  },
  async ({ system, name }) => {
    const what = `${normalizeSystem(system)}/${name} 的版本列表`;
    const res = await getJson(pkgPath(system, name), what);
    if (res.error !== undefined) return fail(res.error);
    const versions = Array.isArray(res.value?.versions) ? res.value.versions : [];
    const row = (v) => ({
      version: v.versionKey?.version ?? null,
      publishedAt: v.publishedAt ?? null,
      isDefault: v.isDefault ?? false,
      ...(v.isDeprecated === true ? { isDeprecated: true, deprecatedReason: String(v.deprecatedReason ?? '').slice(0, 160) } : {}),
    });
    // 上游的顺序**不是**时间序,是版本字符串序——所以 "4.9.0" 排在 "4.17.21"
    // 后面,取数组尾部会拿到 2016 年的版本还管它叫"最近"。按 publishedAt 自己
    // 排,缺时间戳的排到最后(有总比没有强,但不能顶掉有时间的)。
    const stamped = versions.map((v) => {
      const t = Date.parse(v.publishedAt ?? '');
      return { v, t: Number.isNaN(t) ? -Infinity : t };
    });
    const recent = stamped
      .sort((a, b) => b.t - a.t)
      .slice(0, MAX_VERSIONS)
      .map((x) => row(x.v));
    const dflt = versions.find((v) => v.isDefault === true);
    return ok({
      package: { system: normalizeSystem(system), name },
      versionCount: versions.length,
      defaultVersion: dflt === undefined ? null : row(dflt),
      recentVersions: recent,
      ...(versions.length > recent.length ? { truncated: `仅列出最近 ${recent.length} 个，共 ${versions.length} 个` } : {}),
      attribution: ATTRIBUTION,
    });
  },
);

await server.connect(new StdioServerTransport());
