#!/usr/bin/env node
/**
 * ai-call — AI 能力零件化(P1:泛化 agent 的"模型只在有判断处出现")。
 *
 * 把"一次 AI 调用"包成可被任何调用者(agent 工具面/服务件/触发流程)使用的
 * 零件:应用无需开聊天会话即可调 AI(摘要/分类/改写/抽取)。persona 在这里
 * 降维为参数(system),不再是会话灵魂。
 *
 * Safety:密钥只从进程 env 读(DEEPSEEK_API_KEY,host 或 .env 提供),值绝不
 * 进参数/日志/返回;prompt 上限 64KB;默认 flash(便宜快),可换 pro。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com';
const MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);

const server = new McpServer({ name: 'ai-call', version: '0.0.1' });

server.registerTool('ai-complete', {
  description:
    '一次独立的 AI 补全调用(与当前会话完全无关的新调用):给 prompt(和可选 system),'
    + '返回模型文本。用于把摘要/分类/改写/抽取等 AI 步骤嵌进确定性流程——无需开会话。'
    + '默认 deepseek-v4-flash;凭证走进程环境 DEEPSEEK_API_KEY,不经参数。',
  inputSchema: {
    prompt: z.string().describe('用户内容(≤64KB)'),
    system: z.string().optional().describe('可选 system 指令(这一步 AI 的"岗位说明")'),
    model: z.string().optional().describe('deepseek-v4-flash(默认)| deepseek-v4-pro'),
    maxTokens: z.number().optional().describe('输出上限,默认 1024,最大 8192'),
  },
}, async ({ prompt, system, model, maxTokens }) => {
  const key = process.env.DEEPSEEK_API_KEY || '';
  if (key === '') {
    return { isError: true, content: [{ type: 'text', text: 'ai-complete: 进程环境缺 DEEPSEEK_API_KEY(host 或 .env 提供;密钥不走参数)' }] };
  }
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 64 * 1024) {
    return { isError: true, content: [{ type: 'text', text: 'ai-complete: prompt 必须为 1 字节 ~ 64KB 的字符串' }] };
  }
  const useModel = MODELS.has(model) ? model : 'deepseek-v4-flash';
  // 下限 256:v4 是推理模型,completion 预算先喂隐藏思维链——上限给太小
  // (实测 32)思维链吃光预算,text 返回空串。这是消费方最容易踩的坑,零件
  // 端直接抬地板。
  const cap = Math.max(256, Math.min(8192, Number.isFinite(maxTokens) ? maxTokens : 1024));
  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: useModel,
        max_tokens: cap,
        messages: [
          ...(typeof system === 'string' && system !== '' ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return { isError: true, content: [{ type: 'text', text: `ai-complete: 上游 HTTP ${res.status}:${body}` }] };
    }
    const j = await res.json();
    const text = j && j.choices && j.choices[0] && j.choices[0].message ? String(j.choices[0].message.content || '') : '';
    const usage = j && j.usage ? { prompt: j.usage.prompt_tokens, completion: j.usage.completion_tokens } : undefined;
    return { content: [{ type: 'text', text: JSON.stringify({ model: useModel, text, ...(usage !== undefined ? { usage } : {}) }) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `ai-complete: 调用失败:${String(e && e.message || e).slice(0, 200)}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
