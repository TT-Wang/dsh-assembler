#!/usr/bin/env node
/**
 * translate-text — 机器翻译(免费公共服务,零凭证)。
 *
 * 上游 MyMemory(api.mymemory.translated.net):匿名可用;配 TRANSLATE_EMAIL 进
 * 礼貌池拿更高配额——与 SEC/Crossref 零件同款"联系方式不是凭证但也不硬编码"纪律。
 * 归类:变换器(分类法判定单脸终审)——页面要翻译时由 agent 调用,不长服务脸。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = 'https://api.mymemory.translated.net/get';
const UA = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const MAX_CHARS = 500; // 上游单次上限
const server = new McpServer({ name: 'translate-text', version: '0.0.1' });
const text = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
const err = (m) => ({ isError: true, content: [{ type: 'text', text: `translate-text: ${m}` }] });
const LANG_RE = /^[a-zA-Z]{2}(-[a-zA-Z]{2})?$/;

async function translateOne(q, from, to) {
  const u = new URL(BASE);
  u.searchParams.set('q', q);
  u.searchParams.set('langpair', `${from}|${to}`);
  const email = process.env.TRANSLATE_EMAIL || '';
  if (email !== '') u.searchParams.set('de', email);
  const res = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`上游 HTTP ${res.status}`);
  const j = await res.json();
  const status = j.responseStatus;
  if (String(status) !== '200') throw new Error(`上游拒绝(${status}):${String(j.responseDetails ?? '').slice(0, 120)}`);
  return {
    text: String(j.responseData?.translatedText ?? ''),
    match: Number(j.responseData?.match ?? 0),
  };
}

server.registerTool('translate', {
  description: '翻译一段文本(≤500 字符)。langpair 用两字母代码:zh/en/ja/fr/de/es…。免费公共服务,无需凭证;配 TRANSLATE_EMAIL 可提高配额。长文请分段调用。',
  inputSchema: {
    text: z.string().describe('待翻译文本(≤500 字符)'),
    from: z.string().describe('源语言,如 zh'),
    to: z.string().describe('目标语言,如 en'),
  },
}, async ({ text: q, from, to }) => {
  if (typeof q !== 'string' || q.trim() === '') return err('text 不能为空');
  if (q.length > MAX_CHARS) return err(`text ${q.length} 字符 > ${MAX_CHARS}(上游单次上限;请分段)`);
  if (!LANG_RE.test(from) || !LANG_RE.test(to)) return err('from/to 需为两字母语言代码(如 zh、en、ja)');
  try {
    const r = await translateOne(q, from, to);
    return text({ from, to, source: q, translated: r.text, match: r.match });
  } catch (e) { return err(String(e && e.message || e).slice(0, 200)); }
});

server.registerTool('translate-batch', {
  description: '批量翻译多段文本(单次 ≤20 段,每段 ≤500 字符;顺序返回)。批量接口替模型省 roundtrip。',
  inputSchema: {
    texts: z.array(z.string()).describe('待翻译文本数组(≤20 段)'),
    from: z.string(), to: z.string(),
  },
}, async ({ texts, from, to }) => {
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > 20) return err('texts 需 1..20 段');
  if (!LANG_RE.test(from) || !LANG_RE.test(to)) return err('from/to 需为两字母语言代码');
  const out = [];
  for (const [i, q] of texts.entries()) {
    if (typeof q !== 'string' || q.trim() === '' || q.length > MAX_CHARS) return err(`第 ${i + 1} 段非法(空或 >${MAX_CHARS} 字符)`);
    try { out.push({ source: q, translated: (await translateOne(q, from, to)).text }); }
    catch (e) { return err(`第 ${i + 1} 段失败:${String(e && e.message || e).slice(0, 150)}`); }
  }
  return text({ from, to, count: out.length, results: out });
});

await server.connect(new StdioServerTransport());
