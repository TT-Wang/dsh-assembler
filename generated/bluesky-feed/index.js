#!/usr/bin/env node
/**
 * MCP stdio server: Bluesky public AppView (https://public.api.bsky.app) 适配。
 *
 * 能力点(三个完整动作,全部只读公开数据、免登录):
 *   1. author-feed    读某个账号(handle 或 DID)最近的帖子,带点赞/转发/回复数
 *   2. whats-hot      拿 Bluesky 官方 "whats-hot" 热门 feed(全站当下高互动帖)
 *   3. profile        看某账号资料:显示名、简介、粉丝/关注/发帖数
 *
 * 为什么是 Bluesky:大批 AI 研究者和从业者从 X 迁到了 Bluesky,公开数据免 auth
 * 免 key 免风险——这正是"X 官方 API 要付费、爬虫要拿账号密码"两难之外的第三条路。
 *
 * **一个诚实限制(已实测)**:公开 AppView 的 `searchPosts`(关键词搜全站)在部分
 * 网络/代理下被边缘层 403 拦截,不稳定,因此本零件**不做关键词搜索**;要"盯某话题"
 * 请给一批相关账号用 author-feed,或用 whats-hot 看全站热门。搜索类需求交给
 * hn-search 那类稳定的搜索零件。
 *
 * 数据是用户生成内容;返回附署名。返回体裁剪:一条 post 原文约 1–2KB,这里只留
 * 作者/正文/互动量/链接。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVICE = 'Bluesky public AppView (public.api.bsky.app)';
const BASE_URL = 'https://public.api.bsky.app/xrpc';
const UA = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const TIMEOUT_MS = 15000;
const MIN_GAP_MS = 150;
const ATTRIBUTION = 'Public post data from the Bluesky AppView; posts are user-generated content on bsky.app.';
/** 官方 whats-hot feed 的固定 AT-URI。 */
const WHATS_HOT = 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot';
const MAX_LIMIT = 25;

const server = new McpServer({ name: 'bluesky-feed', version: '0.0.1' });
const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });

let lastRequestAt = 0;

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
  if (!res.ok) {
    if (res.status === 400) return { error: `${SERVICE} ${what} 参数错误(HTTP 400):handle/DID 是否存在?例如 handle 写完整域名 "someone.bsky.social"。原文:${text.slice(0, 120)}` };
    return { error: `${SERVICE} ${what} 失败:HTTP ${res.status} ${text.slice(0, 120)}` };
  }
  try {
    return { value: text === '' ? {} : JSON.parse(text) };
  } catch {
    return { error: `${SERVICE} ${what} 返回的不是合法 JSON(可能被边缘层拦截):${text.slice(0, 120)}` };
  }
}

/** feed 项里的一条 post → 最小字段集。 */
function digestPost(item) {
  const p = item?.post ?? item;
  const rec = p?.record ?? {};
  return {
    author: p?.author?.handle ?? null,
    displayName: p?.author?.displayName ?? null,
    text: String(rec.text ?? '').slice(0, 300),
    likeCount: p?.likeCount ?? null,
    repostCount: p?.repostCount ?? null,
    replyCount: p?.replyCount ?? null,
    createdAt: rec.createdAt ?? null,
    uri: p?.uri ?? null,
    url: (p?.author?.handle && p?.uri) ? `https://bsky.app/profile/${p.author.handle}/post/${String(p.uri).split('/').pop()}` : null,
  };
}

const enc = encodeURIComponent;

server.registerTool(
  'author-feed',
  {
    description: '读某个 Bluesky 账号最近的帖子,带点赞/转发/回复数与原帖链接。盯特定 AI 大 V 或机构就用这个(给一批账号各调一次)。只读,不需要凭证。',
    inputSchema: {
      actor: z.string().describe('账号 handle(完整域名,如 "bsky.app" 或 "someone.bsky.social")或 DID'),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`返回条数,1-${MAX_LIMIT},默认 10`),
    },
  },
  async ({ actor, limit }) => {
    const n = Math.min(limit ?? 10, MAX_LIMIT);
    const res = await getJson(`/app.bsky.feed.getAuthorFeed?actor=${enc(actor)}&limit=${n}`, `读 ${actor} 的帖子`);
    if (res.error !== undefined) return fail(res.error);
    const feed = Array.isArray(res.value?.feed) ? res.value.feed : [];
    return ok({ actor, postCount: feed.length, posts: feed.map(digestPost), attribution: ATTRIBUTION });
  },
);

server.registerTool(
  'whats-hot',
  {
    description: 'Bluesky 官方 "whats-hot" 热门 feed:全站当下高互动的帖子。用来快速扫"现在 Bluesky 上什么在刷屏"。只读,不需要凭证。',
    inputSchema: {
      limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`返回条数,默认 15`),
    },
  },
  async ({ limit }) => {
    const n = Math.min(limit ?? 15, MAX_LIMIT);
    const res = await getJson(`/app.bsky.feed.getFeed?feed=${enc(WHATS_HOT)}&limit=${n}`, '拿 whats-hot 热门');
    if (res.error !== undefined) return fail(res.error);
    const feed = Array.isArray(res.value?.feed) ? res.value.feed : [];
    return ok({ feed: 'whats-hot', postCount: feed.length, posts: feed.map(digestPost), attribution: ATTRIBUTION });
  },
);

server.registerTool(
  'profile',
  {
    description: '看某个 Bluesky 账号的资料:显示名、简介、粉丝数/关注数/发帖数。用来判断一个账号的分量。只读,不需要凭证。',
    inputSchema: {
      actor: z.string().describe('账号 handle(完整域名)或 DID'),
    },
  },
  async ({ actor }) => {
    const res = await getJson(`/app.bsky.actor.getProfile?actor=${enc(actor)}`, `查 ${actor} 资料`);
    if (res.error !== undefined) return fail(res.error);
    const v = res.value ?? {};
    if (v.handle === undefined) return fail(`${SERVICE} 未返回账号 ${actor} 的资料。`);
    return ok({
      handle: v.handle,
      displayName: v.displayName ?? null,
      description: String(v.description ?? '').slice(0, 400),
      followersCount: v.followersCount ?? null,
      followsCount: v.followsCount ?? null,
      postsCount: v.postsCount ?? null,
      url: `https://bsky.app/profile/${v.handle}`,
      attribution: ATTRIBUTION,
    });
  },
);

await server.connect(new StdioServerTransport());
