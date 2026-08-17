#!/usr/bin/env node
/**
 * MCP stdio server: 学术文献检索(Crossref 已发表文献 + arXiv 预印本,两个来源一个零件)。
 * 能力点:一轮内检索已发表文献元数据、检索预印本、按 DOI 取权威元数据——
 * agent 核对引用、找原文出处、确认作者/年份/期刊,不用自己拼 API、不用解析原始返回体。
 * 只读:仅 GET 公开检索端点,不调用任何写端点,不做并发扇出。
 * 数据许可:Crossref CC0-1.0 / arXiv terms;polite pool 带 UA 与联系邮箱。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'scholar-search', version: '0.0.1' });

const UA = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
// Crossref polite pool 联系方式:部署者用 CROSSREF_MAILTO 填自己的邮箱。
// 同上,不硬编码私人邮箱;未设置时走匿名池(速率略低,功能不受影响)。
const MAILTO = process.env.CROSSREF_MAILTO || '';
const TIMEOUT_MS = 15000;
const ABSTRACT_CHARS = 300;

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const snippet = (body) => (body ? clip(body, 200) : '(空响应体)');

/** 统一网络出口:超时 + UA;返回 { body, status } 或 { error, status?, body? },绝不抛裸异常。 */
async function httpText(service, url, accept) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept },
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
    return {
      error: `${service} 返回 HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}。响应片段:${snippet(body)}。URL: ${url}`,
      status: res.status,
      body,
    };
  }
  return { status: res.status, body };
}

async function httpJson(service, url) {
  const r = await httpText(service, url, 'application/json');
  if (r.error) return r;
  try {
    return { status: r.status, data: JSON.parse(r.body) };
  } catch (err) {
    return { error: `${service} 返回的不是合法 JSON(${err?.message ?? err})。响应片段:${snippet(r.body)}。URL: ${url}` };
  }
}

// ---------- Crossref 返回体裁剪 ----------

/** Crossref 摘要是 JATS XML,去标签 + 解实体 + 截断,别把整段论文倒回上下文。 */
function stripJats(raw) {
  if (!raw) return '';
  return clip(
    String(raw)
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[n])),
    ABSTRACT_CHARS,
  );
}

function crossrefYear(m) {
  for (const key of ['issued', 'published', 'published-print', 'published-online', 'created']) {
    const y = m?.[key]?.['date-parts']?.[0]?.[0];
    if (Number.isFinite(y)) return String(y);
  }
  return '年份未知';
}

function crossrefAuthors(m, max = 8) {
  const list = Array.isArray(m?.author) ? m.author : [];
  const names = list
    .map((a) => [a?.given, a?.family].filter(Boolean).join(' ') || a?.name || '')
    .filter(Boolean);
  if (!names.length) return '作者未标注';
  return names.length > max ? `${names.slice(0, max).join('; ')} 等 ${names.length} 人` : names.join('; ');
}

function crossrefVenue(m) {
  const container = m?.['container-title']?.[0] || m?.['short-container-title']?.[0] || '';
  const publisher = m?.publisher || '';
  if (container && publisher) return `${clip(container, 120)}(${clip(publisher, 60)})`;
  return clip(container || publisher, 140) || '出处未标注';
}

/** 一条 Crossref 记录 → 固定几行,只留标题/作者/年份/DOI/出处/被引/摘要截断。 */
function formatCrossrefWork(m, index, authorMax = 8) {
  const title = clip(m?.title?.[0] ?? m?.['short-title']?.[0] ?? '', 250) || '(无标题)';
  const doi = m?.DOI ? String(m.DOI) : '';
  const lines = [
    `${index != null ? `${index}. ` : ''}${title}`,
    `   作者: ${crossrefAuthors(m, authorMax)}`,
    `   年份: ${crossrefYear(m)} | 类型: ${m?.type ?? '未知'} | 被引: ${Number.isFinite(m?.['is-referenced-by-count']) ? m['is-referenced-by-count'] : '未知'}`,
    `   出处: ${crossrefVenue(m)}`,
    `   DOI: ${doi || '(无 DOI)'}${doi ? ` | 链接: https://doi.org/${doi}` : ''}`,
  ];
  const abstract = stripJats(m?.abstract);
  if (abstract) lines.push(`   摘要: ${abstract}`);
  return lines.join('\n');
}

// ---------- arXiv Atom XML 解析(不引第三方 XML 库) ----------

const XML_ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => XML_ENTITY[n]);
}

/** 取 xml 片段里第一个 <tag ...>…</tag> 的文本(已解实体、已折叠空白)。 */
function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? decodeXml(m[1]).replace(/\s+/g, ' ').trim() : '';
}

/** 取 xml 片段里全部 <tag>…</tag> 的文本。 */
function tagTextAll(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) {
    const v = decodeXml(m[1]).replace(/\s+/g, ' ').trim();
    if (v) out.push(v);
  }
  return out;
}

/** 取全部 <tag attr="…"> 的属性值(如 <category term="cs.CV"/>)。 */
function attrAll(xml, tag, attr) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(decodeXml(m[1]));
  return out;
}

/**
 * 解析策略:先按 <entry> 切分再逐字段提取。
 * feed 头部自己也有 <title>/<id>/<link>,不先切分就会把 feed 标题当成第一篇论文标题。
 */
function parseArxivFeed(xml) {
  const head = xml.split(/<entry\b[^>]*>/)[0] ?? '';
  const total = Number(tagText(head, 'opensearch:totalResults'));
  const entries = xml
    .split(/<entry\b[^>]*>/)
    .slice(1)
    .map((chunk) => chunk.split(/<\/entry>/)[0])
    .map((entry) => {
      const rawId = tagText(entry, 'id');
      const arxivId = rawId.includes('/abs/') ? rawId.split('/abs/').pop() : rawId.split('/').pop();
      return {
        arxivId,
        url: rawId ? rawId.replace(/^http:/, 'https:') : '',
        title: clip(tagText(entry, 'title'), 250),
        authors: tagTextAll(entry, 'name'),
        published: tagText(entry, 'published'),
        updated: tagText(entry, 'updated'),
        summary: clip(tagText(entry, 'summary'), ABSTRACT_CHARS),
        categories: attrAll(entry, 'category', 'term'),
        primaryCategory: attrAll(entry, 'arxiv:primary_category', 'term')[0] ?? '',
      };
    });
  return { total: Number.isFinite(total) ? total : entries.length, entries };
}

function formatArxivEntry(e, index) {
  const authors = e.authors.length > 8
    ? `${e.authors.slice(0, 8).join('; ')} 等 ${e.authors.length} 人`
    : (e.authors.join('; ') || '作者未标注');
  const lines = [
    `${index}. ${e.title || '(无标题)'}`,
    `   作者: ${authors}`,
    `   日期: ${e.published ? e.published.slice(0, 10) : '未知'}${e.updated ? ` | 最后更新: ${e.updated.slice(0, 10)}` : ''}`,
    `   arXiv id: ${e.arxivId || '未知'}${e.url ? ` | 链接: ${e.url}` : ''}`,
    `   分类: ${e.primaryCategory || e.categories[0] || '未标注'}${e.categories.length > 1 ? ` (共 ${e.categories.length} 个)` : ''}`,
  ];
  if (e.summary) lines.push(`   摘要: ${e.summary}`);
  return lines.join('\n');
}

// ---------- 工具 ----------

/** DOI 归一:吃掉 https://doi.org/ 、doi: 前缀与首尾空白。 */
function normalizeDoi(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/[.,;]+$/, '');
}

// arXiv 支持字段前缀查询;用户已写前缀就原样透传,否则包成 all:
const ARXIV_FIELD_PREFIX = /\b(all|ti|au|abs|co|jr|cat|rn|id):/i;

server.registerTool('search-published', {
  description:
    '检索**已发表**文献(Crossref,覆盖期刊论文/会议论文/书章节等有 DOI 的正式出版物)。'
    + '输入自然语言查询词与可选返回条数;返回裁剪后的列表:标题、作者、年份、类型、被引次数、'
    + '出处(期刊/会议 + 出版方)、DOI 与 doi.org 链接、摘要前 300 字(若该记录有摘要)。'
    + '查询词为空或条数越界返回错误;检索不到结果返回结构化的"零结果"说明而不是报错。',
  inputSchema: {
    query: z.string().describe('检索词(必填,非空),如 "attention is all you need" 或 "CRISPR gene editing"'),
    rows: z.number().int().optional().describe('返回条数,1-20,默认 5'),
  },
}, async ({ query, rows }) => {
  const q = String(query ?? '').trim();
  if (!q) return fail('search-published: 查询词为空,请给出非空检索词');
  const n = rows ?? 5;
  if (!Number.isInteger(n) || n < 1 || n > 20) return fail(`search-published: rows 必须是 1-20 的整数,收到 ${JSON.stringify(rows)}`);

  const url = `https://api.crossref.org/works?${new URLSearchParams({
    query: q,
    rows: String(n),
    mailto: MAILTO,
    select: 'DOI,title,author,issued,container-title,short-container-title,type,publisher,URL,is-referenced-by-count,abstract',
  })}`;
  const r = await httpJson('Crossref (api.crossref.org/works)', url);
  if (r.error) return fail(`search-published 失败:${r.error}`);

  const message = r.data?.message;
  const items = Array.isArray(message?.items) ? message.items : [];
  if (!items.length) {
    return ok(`Crossref 检索 "${q}":未找到任何已发表文献(total-results=${message?.['total-results'] ?? 0})。可换更宽的关键词,或改用 search-preprints 查 arXiv 预印本。`);
  }
  const header = `Crossref 已发表文献 | 查询: "${q}" | 命中总数: ${message?.['total-results'] ?? '未知'} | 本次返回: ${items.length} 条`;
  return ok([header, '', ...items.map((m, i) => formatCrossrefWork(m, i + 1))].join('\n'));
});

server.registerTool('search-preprints', {
  description:
    '检索 **arXiv 预印本**(物理/数学/CS/生物等,含尚未正式发表的最新工作)。'
    + '输入查询词与可选返回条数;返回裁剪后的列表:标题、作者、提交日期、arXiv id 与链接、主分类、摘要前 300 字。'
    + '查询词默认按全字段(all:)匹配;若查询词自带 arXiv 字段前缀(ti:/au:/abs:/cat: 等)则原样透传。'
    + '查询词为空或条数越界返回错误;检索不到结果返回结构化的"零结果"说明。',
  inputSchema: {
    query: z.string().describe('检索词(必填,非空),如 "transformer" 或字段式 "au:Hinton AND cat:cs.LG"'),
    maxResults: z.number().int().optional().describe('返回条数,1-20,默认 5'),
  },
}, async ({ query, maxResults }) => {
  const q = String(query ?? '').trim();
  if (!q) return fail('search-preprints: 查询词为空,请给出非空检索词');
  const n = maxResults ?? 5;
  if (!Number.isInteger(n) || n < 1 || n > 20) return fail(`search-preprints: maxResults 必须是 1-20 的整数,收到 ${JSON.stringify(maxResults)}`);

  const searchQuery = ARXIV_FIELD_PREFIX.test(q) ? q : `all:${q}`;
  const url = `https://export.arxiv.org/api/query?${new URLSearchParams({
    search_query: searchQuery,
    start: '0',
    max_results: String(n),
    sortBy: 'relevance',
    sortOrder: 'descending',
  })}`;
  // arXiv 返回的是 Atom XML 而不是 JSON,单独走文本通道
  const r = await httpText('arXiv (export.arxiv.org/api/query)', url, 'application/atom+xml');
  if (r.error) return fail(`search-preprints 失败:${r.error}`);
  if (!/<feed[\s>]/.test(r.body)) {
    return fail(`search-preprints 失败:arXiv 返回的不是 Atom feed(解析失败)。响应片段:${snippet(r.body)}`);
  }

  let parsed;
  try {
    parsed = parseArxivFeed(r.body);
  } catch (err) {
    return fail(`search-preprints 失败:arXiv Atom XML 解析出错(${err?.message ?? err})。响应片段:${snippet(r.body)}`);
  }
  if (!parsed.entries.length) {
    return ok(`arXiv 检索 "${searchQuery}":未找到任何预印本(totalResults=${parsed.total})。可换更宽的关键词,或改用 search-published 查已发表文献。`);
  }
  const header = `arXiv 预印本 | 查询: "${searchQuery}" | 命中总数: ${parsed.total} | 本次返回: ${parsed.entries.length} 条`;
  return ok([header, '', ...parsed.entries.map((e, i) => formatArxivEntry(e, i + 1))].join('\n'));
});

server.registerTool('doi-lookup', {
  description:
    '按 DOI 取 Crossref 权威元数据(核对引用、补全书目信息的首选)。'
    + '输入 DOI(可带 https://doi.org/ 或 doi: 前缀,会自动归一);'
    + '返回标题、全部作者、年份、类型、被引次数、出处(期刊/会议 + 出版方)、页码、ISSN/ISBN、'
    + '参考文献数与摘要前 300 字。DOI 格式非法返回错误;Crossref 查无此 DOI 返回结构化的"未收录"说明。',
  inputSchema: {
    doi: z.string().describe('DOI(必填),如 10.1145/3292500.3330701 或 https://doi.org/10.1145/3292500.3330701'),
  },
}, async ({ doi }) => {
  const clean = normalizeDoi(doi);
  if (!clean) return fail('doi-lookup: DOI 为空,请给出形如 10.1145/3292500.3330701 的 DOI');
  if (!/^10\.\d{4,9}\/\S+$/.test(clean)) {
    return fail(`doi-lookup: "${clean}" 不是合法 DOI(应形如 10.<注册号>/<后缀>,如 10.1145/3292500.3330701)`);
  }

  const url = `https://api.crossref.org/works/${clean.split('/').map(encodeURIComponent).join('/')}?${new URLSearchParams({ mailto: MAILTO })}`;
  const r = await httpJson('Crossref (api.crossref.org/works/{doi})', url);
  if (r.error) {
    if (r.status === 404) {
      return ok(`Crossref 未收录 DOI ${clean}(HTTP 404)。可能是 DOI 拼写有误、由 DataCite 等其他注册机构登记,或是 arXiv 预印本(改用 search-preprints)。`);
    }
    return fail(`doi-lookup 失败:${r.error}`);
  }

  const m = r.data?.message;
  if (!m) return fail(`doi-lookup 失败:Crossref 返回结构异常(缺 message 字段)。响应片段:${snippet(JSON.stringify(r.data))}`);

  const lines = [
    `DOI ${clean} 的 Crossref 元数据`,
    '',
    formatCrossrefWork(m, null, 30),
    `   出版方: ${m.publisher ?? '未标注'}${m.page ? ` | 页码: ${m.page}` : ''}`,
    `   参考文献数: ${Number.isFinite(m['reference-count']) ? m['reference-count'] : '未知'}`,
  ];
  const issn = Array.isArray(m.ISSN) ? m.ISSN.slice(0, 3).join(', ') : '';
  const isbn = Array.isArray(m.ISBN) ? m.ISBN.slice(0, 3).join(', ') : '';
  if (issn) lines.push(`   ISSN: ${issn}`);
  if (isbn) lines.push(`   ISBN: ${isbn}`);
  return ok(lines.join('\n'));
});

const transport = new StdioServerTransport();
await server.connect(transport);
