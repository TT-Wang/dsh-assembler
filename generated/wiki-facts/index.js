#!/usr/bin/env node
/**
 * MCP stdio server: 维基事实查询(Wikipedia 摘要 + Wikidata 结构化实体,两个来源一个零件)。
 * 能力点:一轮内拿词条摘要、按关键词做实体消歧(拿 QID)、按 QID 取结构化属性事实——
 * agent 核对"这是什么/属于哪国/何时成立",不用抓整页 HTML。
 * 只读:仅 GET 公开读端点(REST summary / action=wbsearchentities / action=wbgetentities),
 * 不调用任何写端点,不做并发扇出。
 * 数据许可:CC-BY-SA-4.0;Wikimedia 要求带明确 User-Agent。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'wiki-facts', version: '0.0.1' });

const UA = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const TIMEOUT_MS = 15000;
const EXTRACT_CHARS = 900;

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const snippet = (body) => (body ? clip(body, 200) : '(空响应体)');

/** 统一网络出口:超时 + UA;返回 { data, status } 或 { error, status?, body? },绝不抛裸异常。 */
async function httpJson(service, url) {
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
    // 只回一句 "fetch failed" 等于没说是哪个服务出了什么问题,必须带出来。
    // 注:node 的 fetch 默认**不读** HTTP(S)_PROXY 环境变量,需代理才能出网的环境要设 NODE_USE_ENV_PROXY=1。
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
  try {
    return { status: res.status, data: JSON.parse(body) };
  } catch (err) {
    return { error: `${service} 返回的不是合法 JSON(${err?.message ?? err})。响应片段:${snippet(body)}。URL: ${url}` };
  }
}

/** MediaWiki action API 会用 HTTP 200 携带 { error: {...} },必须单独判。 */
function mediawikiError(data) {
  const e = data?.error;
  if (!e) return null;
  return `${e.code ?? 'unknown'}: ${clip(e.info ?? '(无描述)', 200)}`;
}

// 语言码:ISO-639 风格(可带地区/变体后缀),用来挡住 "en_US"、"english!!" 这类非法值,
// 同时也防止把任意字符串拼进主机名去打未知站点。
const LANG_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;

// ---------- Wikipedia ----------

server.registerTool('page-summary', {
  description:
    '取 Wikipedia 词条摘要(REST /page/summary)。输入词条名与语言码(en/zh/ja/de… 默认 en);'
    + '返回标题、一句话描述、正文摘要(截断)、词条类型、对应 Wikidata QID、桌面版链接与配图地址。'
    + '语言码非法返回错误;词条不存在(HTTP 404)是正常情况,返回结构化的"未找到"说明并给出改用 search-entity 消歧的建议。',
  inputSchema: {
    title: z.string().describe('词条名(必填),如 Beijing / 北京 / Model_Context_Protocol,空格会自动转下划线'),
    lang: z.string().optional().describe('维基语言码,默认 en;常用 en(英文)/zh(中文)/ja/de/fr'),
  },
}, async ({ title, lang }) => {
  const name = String(title ?? '').trim();
  if (!name) return fail('page-summary: 词条名为空,请给出非空词条名');
  const code = String(lang ?? 'en').trim().toLowerCase();
  if (!LANG_RE.test(code)) {
    return fail(`page-summary: "${lang}" 不是合法维基语言码(应为 ISO-639 风格小写码,如 en / zh / zh-hans / ja),已拒绝请求`);
  }

  const path = encodeURIComponent(name.replace(/\s+/g, '_'));
  const url = `https://${code}.wikipedia.org/api/rest_v1/page/summary/${path}`;
  const r = await httpJson(`Wikipedia (${code}.wikipedia.org REST summary)`, url);
  if (r.error) {
    if (r.status === 404) {
      return ok(`Wikipedia(${code})未找到词条 "${name}"(HTTP 404)。可能是拼写/大小写不符、该语言站没有此词条,或需要消歧——可先用 search-entity 按关键词找到实体再试。`);
    }
    return fail(`page-summary 失败:${r.error}`);
  }

  const d = r.data ?? {};
  if (d.type === 'disambiguation') {
    return ok(`Wikipedia(${code})词条 "${d.title ?? name}" 是消歧义页,不是具体条目。请换更具体的词条名,或用 search-entity 拿到 QID 后再查。`);
  }
  const lines = [
    `Wikipedia(${code}) 词条: ${d.title ?? name}`,
    `描述: ${clip(d.description, 200) || '(无一句话描述)'}`,
    `类型: ${d.type ?? '未知'} | 语言: ${d.lang ?? code} | Wikidata: ${d.wikibase_item ?? '(未关联)'}`,
    `链接: ${d.content_urls?.desktop?.page ?? `https://${code}.wikipedia.org/wiki/${path}`}`,
  ];
  if (d.coordinates?.lat != null) lines.push(`坐标: ${d.coordinates.lat}, ${d.coordinates.lon}`);
  if (d.thumbnail?.source) lines.push(`配图: ${d.thumbnail.source}`);
  lines.push('', `摘要: ${clip(d.extract, EXTRACT_CHARS) || '(该词条无正文摘要)'}`);
  return ok(lines.join('\n'));
});

// ---------- Wikidata ----------

server.registerTool('search-entity', {
  description:
    '按关键词搜 Wikidata 实体候选(action=wbsearchentities),用于**实体消歧**:'
    + '同名的公司/产品/人物会各自返回一个 QID + 标签 + 描述,拿到 QID 后可交给 entity-facts 查结构化属性。'
    + '输入关键词与可选条数、语言;关键词为空、条数越界或语言码非法返回错误;搜不到返回结构化"无候选"说明。',
  inputSchema: {
    query: z.string().describe('实体关键词(必填,非空),如 DeepSeek / Beijing / 张三'),
    limit: z.number().int().optional().describe('候选条数,1-10,默认 5'),
    language: z.string().optional().describe('标签与描述的语言,默认 en;中文用 zh'),
  },
}, async ({ query, limit, language }) => {
  const q = String(query ?? '').trim();
  if (!q) return fail('search-entity: 关键词为空,请给出非空关键词');
  const n = limit ?? 5;
  if (!Number.isInteger(n) || n < 1 || n > 10) return fail(`search-entity: limit 必须是 1-10 的整数,收到 ${JSON.stringify(limit)}`);
  const code = String(language ?? 'en').trim().toLowerCase();
  if (!LANG_RE.test(code)) return fail(`search-entity: "${language}" 不是合法语言码(应为 ISO-639 风格小写码,如 en / zh)`);

  const url = `https://www.wikidata.org/w/api.php?${new URLSearchParams({
    action: 'wbsearchentities',
    search: q,
    language: code,
    uselang: code,
    format: 'json',
    limit: String(n),
  })}`;
  const r = await httpJson('Wikidata (api.php action=wbsearchentities)', url);
  if (r.error) return fail(`search-entity 失败:${r.error}`);
  const apiErr = mediawikiError(r.data);
  if (apiErr) return fail(`search-entity 失败:Wikidata API 报错 ${apiErr}`);

  const hits = Array.isArray(r.data?.search) ? r.data.search : [];
  if (!hits.length) {
    return ok(`Wikidata 搜索 "${q}"(语言 ${code}):没有匹配的实体候选。可换其他写法,或改用 language=en 再试。`);
  }
  const lines = hits.map((h, i) => [
    `${i + 1}. ${h.label ?? h.title ?? '(无标签)'} — ${h.id}`,
    `   描述: ${clip(h.description, 200) || '(无描述)'}`,
    `   链接: https://www.wikidata.org/wiki/${h.id}`,
  ].join('\n'));
  return ok([`Wikidata 实体候选 | 关键词: "${q}" | 语言: ${code} | 返回 ${hits.length} 条`, '', ...lines,
    '', '拿到 QID 后可用 entity-facts 查该实体的结构化属性。'].join('\n'));
});

// 只取常用属性,claims 原始体极大(实测 Q956 达 280KB / 194 个属性),必须裁剪
const KEY_PROPS = [
  'P31',   // instance of
  'P279',  // subclass of
  'P17',   // country
  'P131',  // located in administrative entity
  'P571',  // inception
  'P576',  // dissolved
  'P112',  // founded by
  'P159',  // headquarters location
  'P452',  // industry
  'P169',  // CEO
  'P1128', // employees
  'P36',   // capital
  'P1082', // population
  'P625',  // coordinates
  'P106',  // occupation
  'P27',   // country of citizenship
  'P569',  // date of birth
  'P570',  // date of death
  'P50',   // author
  'P170',  // creator
  'P495',  // country of origin
  'P856',  // official website
];
const MAX_VALUES_PER_PROP = 3;

/** 把一个 mainsnak 变成 { text, qid? };qid 留给后续一次性批量解析标签。 */
function snakValue(snak) {
  if (!snak || snak.snaktype === 'novalue') return { text: '(无值)' };
  if (snak.snaktype === 'somevalue') return { text: '(未知值)' };
  const dv = snak.datavalue;
  if (!dv) return { text: '(无数据)' };
  switch (dv.type) {
    case 'wikibase-entityid': {
      const qid = dv.value?.id ?? (dv.value?.['numeric-id'] != null ? `Q${dv.value['numeric-id']}` : '');
      return { text: qid || '(实体)', qid };
    }
    case 'time': {
      // 形如 +2023-05-00T00:00:00Z,precision 9=年 10=月 11=日
      const raw = String(dv.value?.time ?? '').replace(/^\+/, '');
      const p = dv.value?.precision ?? 11;
      if (p <= 9) return { text: raw.slice(0, 4) };
      if (p === 10) return { text: raw.slice(0, 7) };
      return { text: raw.slice(0, 10) };
    }
    case 'quantity': {
      const amount = String(dv.value?.amount ?? '').replace(/^\+/, '');
      const unit = dv.value?.unit && dv.value.unit !== '1' ? String(dv.value.unit).split('/').pop() : '';
      return { text: unit ? `${amount} [${unit}]` : amount, qid: unit && /^Q\d+$/.test(unit) ? unit : undefined };
    }
    case 'globecoordinate':
      return { text: `${dv.value?.latitude}, ${dv.value?.longitude}` };
    case 'monolingualtext':
      return { text: clip(dv.value?.text, 200) };
    case 'string':
    default:
      return { text: clip(typeof dv.value === 'string' ? dv.value : JSON.stringify(dv.value), 200) };
  }
}

/** 把 QID/PID 批量解析成标签:分批 ≤50 个**顺序**请求(不做并发扇出)。 */
async function resolveLabels(ids, code) {
  const labels = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const url = `https://www.wikidata.org/w/api.php?${new URLSearchParams({
      action: 'wbgetentities',
      ids: batch.join('|'),
      format: 'json',
      props: 'labels',
      languages: code === 'en' ? 'en' : `${code}|en`,
    })}`;
    const r = await httpJson('Wikidata (api.php action=wbgetentities props=labels)', url);
    if (r.error || mediawikiError(r.data)) continue; // 标签解析失败不致命:退化成只显示裸 QID
    for (const [id, ent] of Object.entries(r.data?.entities ?? {})) {
      const v = ent?.labels?.[code]?.value ?? ent?.labels?.en?.value;
      if (v) labels.set(id, v);
    }
  }
  return labels;
}

server.registerTool('entity-facts', {
  description:
    '按 QID 取 Wikidata 实体的关键结构化属性(action=wbgetentities)。'
    + '原始 claims 极大(单个实体可达数百 KB / 上百个属性),这里只保留常用属性:'
    + 'P31 instance-of、P17 country、P571 inception、P159 总部、P452 行业、P1082 人口、P625 坐标、'
    + 'P569/P570 生卒、P106 职业、P856 官网等,每个属性最多 3 个值;'
    + '并把属性 ID 与实体值 QID 都额外解析成人类可读标签。'
    + 'QID 格式非法返回错误;Wikidata 查无此实体返回结构化"未找到"说明。',
  inputSchema: {
    qid: z.string().describe('Wikidata 实体 ID(必填),形如 Q956(北京)或 Q131577453(DeepSeek);可用 search-entity 先拿到'),
    language: z.string().optional().describe('标签语言,默认 en;中文用 zh(缺该语言标签时自动回落到 en)'),
  },
}, async ({ qid, language }) => {
  const id = String(qid ?? '').trim().toUpperCase();
  if (!id) return fail('entity-facts: QID 为空,请给出形如 Q956 的 Wikidata 实体 ID');
  if (!/^Q\d+$/.test(id)) return fail(`entity-facts: "${qid}" 不是合法 QID(应形如 Q956),可先用 search-entity 按关键词拿到 QID`);
  const code = String(language ?? 'en').trim().toLowerCase();
  if (!LANG_RE.test(code)) return fail(`entity-facts: "${language}" 不是合法语言码(应为 ISO-639 风格小写码,如 en / zh)`);

  const url = `https://www.wikidata.org/w/api.php?${new URLSearchParams({
    action: 'wbgetentities',
    ids: id,
    format: 'json',
    props: 'labels|descriptions|claims',
    languages: code === 'en' ? 'en' : `${code}|en`,
  })}`;
  const r = await httpJson('Wikidata (api.php action=wbgetentities)', url);
  if (r.error) return fail(`entity-facts 失败:${r.error}`);
  const apiErr = mediawikiError(r.data);
  if (apiErr) {
    if (/no-such-entity/.test(apiErr)) return ok(`Wikidata 未找到实体 ${id}(${apiErr})。请核对 QID,或用 search-entity 按关键词重新消歧。`);
    return fail(`entity-facts 失败:Wikidata API 报错 ${apiErr}`);
  }

  const ent = r.data?.entities?.[id];
  if (!ent || ent.missing !== undefined) return ok(`Wikidata 未找到实体 ${id}(返回体标记 missing)。请核对 QID,或用 search-entity 重新消歧。`);

  const label = ent.labels?.[code]?.value ?? ent.labels?.en?.value ?? '(无标签)';
  const description = ent.descriptions?.[code]?.value ?? ent.descriptions?.en?.value ?? '';
  const claims = ent.claims ?? {};

  // 第一趟:裁出关键属性的值(只留 QID/文本),收集待解析标签
  const picked = [];
  const toResolve = [];
  for (const prop of KEY_PROPS) {
    const statements = Array.isArray(claims[prop]) ? claims[prop] : [];
    if (!statements.length) continue;
    const values = statements
      .filter((s) => s?.rank !== 'deprecated')
      .slice(0, MAX_VALUES_PER_PROP)
      .map((s) => snakValue(s.mainsnak));
    if (!values.length) continue;
    picked.push({ prop, values, total: statements.length });
    toResolve.push(prop, ...values.map((v) => v.qid).filter(Boolean));
  }
  if (!picked.length) {
    return ok(`Wikidata 实体 ${id}(${label})\n描述: ${clip(description, 200) || '(无描述)'}\n\n该实体在关注的 ${KEY_PROPS.length} 个常用属性上没有任何取值(原始 claims 共 ${Object.keys(claims).length} 个属性)。`);
  }

  // 第二趟:一次(或按 50 分批顺序)把 PID/QID 解析成标签
  const labels = await resolveLabels(toResolve, code);
  const propLines = picked.map(({ prop, values, total }) => {
    const propName = labels.get(prop) ?? prop;
    const rendered = values.map((v) => (v.qid && labels.has(v.qid) ? `${labels.get(v.qid)} (${v.qid})` : v.text)).join('; ');
    const more = total > values.length ? ` (共 ${total} 个值,已截断)` : '';
    return `  ${prop} (${propName}): ${rendered}${more}`;
  });

  return ok([
    `Wikidata 实体 ${id}: ${label}`,
    `描述: ${clip(description, 200) || '(无描述)'}`,
    `链接: https://www.wikidata.org/wiki/${id}`,
    `原始属性总数: ${Object.keys(claims).length},下列为裁剪后的关键属性 ${picked.length} 个(语言 ${code}):`,
    '',
    ...propLines,
  ].join('\n'));
});

const transport = new StdioServerTransport();
await server.connect(transport);
