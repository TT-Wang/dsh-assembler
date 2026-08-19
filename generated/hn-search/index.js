#!/usr/bin/env node
/**
 * MCP stdio server: Hacker News search (Algolia HN Search API, https://hn.algolia.com/api).
 *
 * 能力点(三个完整动作):
 *   1. search-stories    按关键词搜 HN 故事,可按相关度或时间排,回标题/链接/分数/评论数
 *   2. top-stories       某关键词下当前最高分的故事(做"今日热议"用,points 降序)
 *   3. get-item          按 objectID 取一条 HN 项(故事或评论)的详情
 *
 * 为什么是 HN:它是技术/AI 圈信息浓度最高的公共讨论场之一,免 key、有 points 和
 * num_comments 这类真实互动量,正好补上"X 要付费"留下的那块——AI 发布、论文、
 * 工具上线在这里往往和 X 同步刷屏,而且这里的数据可实跑、可验收、合规。
 *
 * 只读、无凭证。数据是用户生成内容(HN 评论/提交),随每次返回附来源说明。
 * 返回体裁剪:一条 hit 原文约 3.9KB(含 _highlightResult 高亮标记),这里只留
 * 驱动决策的字段,把体积压到十分之一。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVICE = 'HN Search (hn.algolia.com)';
const BASE_URL = 'https://hn.algolia.com/api/v1';
const UA = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const TIMEOUT_MS = 15000;
const MIN_GAP_MS = 120;
const ATTRIBUTION = 'Data from the Algolia Hacker News Search API; items are user-submitted content on news.ycombinator.com.';
const MAX_HITS = 20;

const server = new McpServer({ name: 'hn-search', version: '0.0.1' });
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
  if (!res.ok) return { error: `${SERVICE} ${what} 失败:HTTP ${res.status} ${text.slice(0, 160)}` };
  try {
    return { value: text === '' ? {} : JSON.parse(text) };
  } catch {
    return { error: `${SERVICE} ${what} 返回的不是合法 JSON:${text.slice(0, 160)}` };
  }
}

/** 一条 hit → 驱动决策的最小字段集(原文约 3.9KB,这里约 0.2KB)。 */
function digest(h) {
  return {
    title: String(h.title ?? h.story_title ?? '').slice(0, 200),
    url: h.url ?? (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : null),
    points: h.points ?? null,
    numComments: h.num_comments ?? null,
    author: h.author ?? null,
    createdAt: h.created_at ?? null,
    objectID: h.objectID ?? null,
    hnUrl: h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : null,
  };
}

const enc = encodeURIComponent;

server.registerTool(
  'search-stories',
  {
    description: '按关键词搜 Hacker News 故事,返回标题、外链、分数(points)、评论数与作者。sort=relevance 按相关度、sort=date 按时间(找最新)。只读,不需要凭证。',
    inputSchema: {
      query: z.string().describe('搜索关键词,例如 "LLM" 或 "OpenAI"'),
      sort: z.enum(['relevance', 'date']).optional().describe('relevance=相关度(默认),date=最新在前'),
      limit: z.number().int().min(1).max(MAX_HITS).optional().describe(`返回条数,1-${MAX_HITS},默认 10`),
    },
  },
  async ({ query, sort, limit }) => {
    const n = Math.min(limit ?? 10, MAX_HITS);
    const endpoint = sort === 'date' ? 'search_by_date' : 'search';
    const res = await getJson(`/${endpoint}?query=${enc(query)}&tags=story&hitsPerPage=${n}`, `搜索 "${query}"`);
    if (res.error !== undefined) return fail(res.error);
    const hits = Array.isArray(res.value?.hits) ? res.value.hits : [];
    return ok({
      query, sort: sort ?? 'relevance',
      totalMatches: res.value?.nbHits ?? hits.length,
      stories: hits.map(digest),
      attribution: ATTRIBUTION,
    });
  },
);

server.registerTool(
  'top-stories',
  {
    description: '某关键词下当前分数最高的 HN 故事(points 降序),用来看"这个话题现在最热的讨论是什么"。只读,不需要凭证。',
    inputSchema: {
      query: z.string().describe('话题关键词,例如 "AI" 或 "Claude"'),
      limit: z.number().int().min(1).max(MAX_HITS).optional().describe(`返回条数,默认 10`),
    },
  },
  async ({ query, limit }) => {
    const n = Math.min(limit ?? 10, MAX_HITS);
    // 多取一些再本地按 points 排:search 的相关度序不等于分数序。
    const res = await getJson(`/search?query=${enc(query)}&tags=story&hitsPerPage=${Math.min(n * 3, 50)}`, `热门 "${query}"`);
    if (res.error !== undefined) return fail(res.error);
    const hits = (Array.isArray(res.value?.hits) ? res.value.hits : [])
      .slice()
      .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
      .slice(0, n);
    return ok({ query, stories: hits.map(digest), attribution: ATTRIBUTION });
  },
);

server.registerTool(
  'get-item',
  {
    description: '按 objectID 取一条 HN 项(故事或评论)的详情,包括正文文本与子评论 id。只读,不需要凭证。',
    inputSchema: {
      objectID: z.string().describe('HN 项的 objectID,例如 search-stories 返回里的那个数字串'),
    },
  },
  async ({ objectID }) => {
    if (!/^\d+$/.test(String(objectID))) return fail(`objectID 应为数字串,收到:${objectID}`);
    const res = await getJson(`/items/${enc(objectID)}`, `取项 ${objectID}`);
    if (res.error !== undefined) return fail(res.error);
    const v = res.value ?? {};
    return ok({
      id: v.id ?? objectID,
      type: v.type ?? null,
      title: v.title ?? null,
      url: v.url ?? null,
      author: v.author ?? null,
      points: v.points ?? null,
      text: typeof v.text === 'string' ? v.text.slice(0, 2000) : null,
      createdAt: v.created_at ?? null,
      childCount: Array.isArray(v.children) ? v.children.length : 0,
      hnUrl: `https://news.ycombinator.com/item?id=${v.id ?? objectID}`,
      attribution: ATTRIBUTION,
    });
  },
);

await server.connect(new StdioServerTransport());
