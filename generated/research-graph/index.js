#!/usr/bin/env node
/**
 * MCP stdio server: OpenAlex 学术图谱(论文 / 引用 / 作者)。
 * 能力点:一轮内按主题检索论文并拿到引用量、按 work id 或 DOI 查单篇被引情况、
 * 按作者名查代表作与总引用——agent 判断"这篇有多重要""这个人做什么方向",不用自己翻数据库。
 * 只读:仅 GET 公开检索端点,不调用任何写端点,不做并发扇出(author-works 是两次**顺序**请求)。
 * 数据许可:CC0-1.0;速率 10 req/s,带 mailto 进 polite pool。
 *
 * 返回体裁剪:OpenAlex 单条 work 原始体动辄几十 KB(authorships/abstract_inverted_index/
 * concepts/locations 等),这里一律用 select= 只取需要字段 + 客户端再裁一次(作者上限 6 人、
 * 标题/机构截断),保证单条格式化输出稳定在 1KB 量级。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'research-graph', version: '0.0.1' });

const UA = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const MAILTO = 'tongtao.wang@gmail.com'; // OpenAlex polite pool 联系方式
const TIMEOUT_MS = 15000;
const API = 'https://api.openalex.org';

// 只取用得上的字段,别把整个 work 对象倒回上下文
const WORK_SELECT = 'id,doi,title,publication_year,publication_date,type,cited_by_count,authorships,primary_location';
const AUTHOR_SELECT = 'id,display_name,orcid,works_count,cited_by_count,last_known_institutions,summary_stats';
const MAX_AUTHORS = 6;

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const snippet = (body) => (body ? clip(body, 200) : '(空响应体)');

/** 统一网络出口:超时 + UA;返回 { data, status } 或 { error, status?, body? },绝不抛裸异常。 */
async function openalexGet(path, params) {
  const url = `${API}${path}?${new URLSearchParams({ ...params, mailto: MAILTO })}`;
  const service = `OpenAlex (api.openalex.org${path.split('/').slice(0, 2).join('/')})`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });
  } catch (err) {
    const name = err?.name ?? 'Error';
    // 内置 fetch 把真正的原因藏在 err.cause(ENOTFOUND / ECONNREFUSED / UND_ERR_CONNECT_TIMEOUT…),
    // 只回一句 "fetch failed" 等于没说是哪个服务出了什么问题,必须带出来
    const cause = err?.cause?.code ?? err?.cause?.message ?? '';
    const why = name === 'TimeoutError' || name === 'AbortError'
      ? `请求超过 ${TIMEOUT_MS}ms 未返回(超时)`
      : `网络层失败(${name}: ${err?.message ?? err}${cause ? `,cause: ${cause}` : ''})`;
    return { error: `${service} 请求失败:${why}。URL: ${url}` };
  }
  let body;
  try {
    body = await res.text();
  } catch (err) {
    return { error: `${service} 响应体读取失败(${err?.name ?? 'Error'}: ${err?.message ?? err},可能是 ${TIMEOUT_MS}ms 超时)。URL: ${url}`, status: res.status };
  }
  if (!res.ok) {
    // 实测 OpenAlex 404 返回的是 HTML 错误页而不是 JSON,所以先判状态码再解析
    return {
      error: `${service} 返回 HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}。响应片段:${snippet(body)}。URL: ${url}`,
      status: res.status,
      body,
    };
  }
  try {
    return { status: res.status, data: JSON.parse(body) };
  } catch (err) {
    return { error: `${service} 返回的不是合法 JSON(${err?.message ?? err})。响应片段:${snippet(body)}。URL: ${url}` };
  }
}

// ---------- 裁剪 / 格式化 ----------

const shortId = (url) => String(url ?? '').split('/').pop() || '';
const shortDoi = (doi) => String(doi ?? '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');

function workAuthors(w) {
  const list = Array.isArray(w?.authorships) ? w.authorships : [];
  const names = list.map((a) => a?.author?.display_name).filter(Boolean);
  if (!names.length) return '作者未标注';
  return names.length > MAX_AUTHORS
    ? `${names.slice(0, MAX_AUTHORS).join('; ')} 等 ${names.length} 人`
    : names.join('; ');
}

function workVenue(w) {
  const loc = w?.primary_location;
  const source = loc?.source?.display_name;
  const publisher = loc?.source?.host_organization_name;
  if (source && publisher) return clip(`${source}(${publisher})`, 140);
  return clip(source || publisher, 140) || '出处未标注';
}

/** 一条 work → 固定 4~5 行;整块稳定在 1KB 以内(标题 300 / 作者 6 人 / 出处 140)。 */
function formatWork(w, index) {
  const doi = shortDoi(w?.doi);
  const year = Number.isFinite(w?.publication_year) ? w.publication_year : '年份未知';
  const cited = Number.isFinite(w?.cited_by_count) ? w.cited_by_count : 0;
  const lines = [
    `${index != null ? `${index}. ` : ''}${clip(w?.title ?? w?.display_name, 300) || '(无标题)'}`,
    `   作者: ${workAuthors(w)}`,
    `   年份: ${year} | 类型: ${w?.type ?? '未知'} | 被引: ${cited}`,
    `   出处: ${workVenue(w)}`,
    `   OpenAlex: ${shortId(w?.id) || '未知'}${doi ? ` | DOI: ${doi}` : ''}`,
  ];
  return lines.join('\n');
}

/** work 定位符归一:接受 W123…、完整 OpenAlex URL、裸 DOI、doi.org 链接。 */
function normalizeWorkLocator(raw) {
  const s = String(raw ?? '').trim().replace(/[.,;]+$/, '');
  if (!s) return { error: '定位符为空' };
  const openalexId = s.match(/^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i);
  if (openalexId) return { path: `/works/${openalexId[1].toUpperCase()}`, shown: openalexId[1].toUpperCase(), kind: 'OpenAlex work id' };
  const doi = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  if (/^10\.\d{4,9}\/\S+$/.test(doi)) {
    return { path: `/works/https://doi.org/${doi}`, shown: doi, kind: 'DOI' };
  }
  return { error: `"${s}" 既不是 OpenAlex work id(形如 W2949676527)也不是 DOI(形如 10.1145/3292500.3330701)` };
}

// ---------- 工具 ----------

server.registerTool('search-works', {
  description:
    '按主题检索 OpenAlex 论文,**结果带引用量**,可用来判断某个方向的代表作与热度。'
    + '输入查询词与可选条数;返回裁剪后的列表:标题、作者(最多 6 人)、年份、类型、被引次数、'
    + '出处(期刊/会议 + 出版方)、OpenAlex work id 与 DOI。原始返回体极大,已用 select= 限定字段 + 客户端二次裁剪。'
    + '查询词为空或条数越界返回错误;检索不到返回结构化"零结果"说明。',
  inputSchema: {
    query: z.string().describe('检索词(必填,非空),如 "attention is all you need" 或 "protein folding"'),
    perPage: z.number().int().optional().describe('返回条数,1-20,默认 5'),
    sortByCitations: z.boolean().optional().describe('true 时按被引次数从高到低排序(默认按相关度)'),
  },
}, async ({ query, perPage, sortByCitations }) => {
  const q = String(query ?? '').trim();
  if (!q) return fail('search-works: 查询词为空,请给出非空检索词');
  const n = perPage ?? 5;
  if (!Number.isInteger(n) || n < 1 || n > 20) return fail(`search-works: perPage 必须是 1-20 的整数,收到 ${JSON.stringify(perPage)}`);

  const params = { search: q, 'per-page': String(n), select: WORK_SELECT };
  if (sortByCitations) params.sort = 'cited_by_count:desc';
  const r = await openalexGet('/works', params);
  if (r.error) return fail(`search-works 失败:${r.error}`);

  const results = Array.isArray(r.data?.results) ? r.data.results : [];
  if (!results.length) {
    return ok(`OpenAlex 检索 "${q}":未找到任何论文(meta.count=${r.data?.meta?.count ?? 0})。可换更宽的关键词再试。`);
  }
  const header = `OpenAlex 论文 | 查询: "${q}" | 命中总数: ${r.data?.meta?.count ?? '未知'} | 本次返回: ${results.length} 条${sortByCitations ? ' | 按被引降序' : ''}`;
  return ok([header, '', ...results.map((w, i) => formatWork(w, i + 1))].join('\n'));
});

server.registerTool('work-citations', {
  description:
    '查单篇论文的被引情况与关键元数据。输入 OpenAlex work id(形如 W2949676527)**或** DOI'
    + '(裸 DOI 或 https://doi.org/… 均可);返回标题、作者、年份、类型、被引次数、出处、'
    + '开放获取状态,以及"谁引用了它"的 OpenAlex 检索链接。'
    + '定位符格式非法返回错误;OpenAlex 查无此文返回结构化"未收录"说明。',
  inputSchema: {
    work: z.string().describe('OpenAlex work id 或 DOI(必填),如 W2949676527 或 10.1145/3292500.3330701'),
  },
}, async ({ work }) => {
  const loc = normalizeWorkLocator(work);
  if (loc.error) return fail(`work-citations: ${loc.error}`);

  const r = await openalexGet(loc.path, { select: `${WORK_SELECT},open_access,referenced_works_count` });
  if (r.error) {
    if (r.status === 404) {
      return ok(`OpenAlex 未收录该${loc.kind}:${loc.shown}(HTTP 404)。可能是拼写有误,或该文献尚未进入 OpenAlex 索引。`);
    }
    return fail(`work-citations 失败:${r.error}`);
  }

  const w = r.data;
  if (!w?.id) return fail(`work-citations 失败:OpenAlex 返回结构异常(缺 id 字段)。响应片段:${snippet(JSON.stringify(w))}`);

  const cited = Number.isFinite(w.cited_by_count) ? w.cited_by_count : 0;
  const lines = [
    `OpenAlex 单篇被引查询 | 输入: ${loc.shown}(${loc.kind})`,
    '',
    formatWork(w, null),
    `   被引次数: ${cited} | 参考文献数: ${Number.isFinite(w.referenced_works_count) ? w.referenced_works_count : '未知'}`,
    `   开放获取: ${w.open_access?.is_oa === true ? `是(${w.open_access?.oa_status ?? '状态未知'})` : w.open_access?.is_oa === false ? '否' : '未知'}`,
  ];
  const wid = shortId(w.id);
  if (wid) lines.push(`   引用它的文献(API): ${API}/works?filter=cites:${wid}`);
  return ok(lines.join('\n'));
});

server.registerTool('author-works', {
  description:
    '按作者名查该作者的画像与代表作:先在 OpenAlex 作者库里匹配到最相关的作者(返回 ORCID、'
    + '总论文数、总被引、h-index、最近所属机构),再取该作者被引最高的若干篇论文。'
    + '两次请求是**顺序**执行的,不做并发扇出。'
    + '作者名为空或条数越界返回错误;匹配不到作者返回结构化"未找到"说明。'
    + '注意同名作者可能被拆成多个 OpenAlex 实体,返回体会给出匹配到的作者 id 供人工核对。',
  inputSchema: {
    name: z.string().describe('作者姓名(必填,非空),如 "Yoshua Bengio"'),
    topWorks: z.number().int().optional().describe('返回代表作数量,1-10,默认 5'),
  },
}, async ({ name, topWorks }) => {
  const q = String(name ?? '').trim();
  if (!q) return fail('author-works: 作者名为空,请给出非空作者名');
  const n = topWorks ?? 5;
  if (!Number.isInteger(n) || n < 1 || n > 10) return fail(`author-works: topWorks 必须是 1-10 的整数,收到 ${JSON.stringify(topWorks)}`);

  // 第一步:定位作者
  const ra = await openalexGet('/authors', { search: q, 'per-page': '1', select: AUTHOR_SELECT });
  if (ra.error) return fail(`author-works 失败(作者检索阶段):${ra.error}`);
  const author = Array.isArray(ra.data?.results) ? ra.data.results[0] : null;
  if (!author?.id) {
    return ok(`OpenAlex 未匹配到作者 "${q}"(meta.count=${ra.data?.meta?.count ?? 0})。可换用全名、英文拼写或直接用 search-works 按主题检索。`);
  }
  const authorId = shortId(author.id);
  const institutions = (Array.isArray(author.last_known_institutions) ? author.last_known_institutions : [])
    .map((i) => i?.display_name).filter(Boolean).slice(0, 2).join('; ');

  // 第二步(顺序,不并发):取该作者被引最高的代表作
  const rw = await openalexGet('/works', {
    filter: `author.id:${authorId}`,
    sort: 'cited_by_count:desc',
    'per-page': String(n),
    select: WORK_SELECT,
  });
  if (rw.error) return fail(`author-works 失败(代表作检索阶段,作者已定位为 ${authorId}):${rw.error}`);
  const works = Array.isArray(rw.data?.results) ? rw.data.results : [];

  const head = [
    `OpenAlex 作者 | 查询: "${q}" | 匹配到候选 ${ra.data?.meta?.count ?? '未知'} 个,取相关度最高的一个`,
    '',
    `姓名: ${author.display_name ?? q} (${authorId})`,
    `论文总数: ${Number.isFinite(author.works_count) ? author.works_count : '未知'} | 总被引: ${Number.isFinite(author.cited_by_count) ? author.cited_by_count : '未知'} | h-index: ${author.summary_stats?.h_index ?? '未知'}`,
    `最近所属机构: ${clip(institutions, 160) || '未标注'}${author.orcid ? ` | ORCID: ${shortId(author.orcid)}` : ''}`,
    `主页: https://openalex.org/${authorId}`,
    '',
  ];
  if (!works.length) {
    return ok([...head, `该作者名下暂无可列出的论文(OpenAlex works 过滤 author.id:${authorId} 返回 0 条)。`].join('\n'));
  }
  return ok([...head, `被引最高的 ${works.length} 篇:`, '', ...works.map((w, i) => formatWork(w, i + 1))].join('\n'));
});

const transport = new StdioServerTransport();
await server.connect(transport);
