#!/usr/bin/env node
/**
 * static-deploy — deploy 类零件(P2:吸收 AI 生成器阵营"一键部署"环路,本机版)。
 * 把工作区内的静态站点目录部署为某 preset 的 frontend/(host 的 /assembler/ui/<id>
 * 直接伺服)。零账户零网络:先闭合本机环;Vercel/EAS 等外部部署件是后续兄弟。
 * Safety:源目录锚定 PART_WORKDIR(穿越拒绝);目标只许 $DSH_HOME/.agent-presets/
 * <合法 id>/frontend;必须已存在该 preset(不无中生有);index.html 必在。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { cpSync, existsSync, rmSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

const PART_WORKDIR = process.env.PART_WORKDIR || process.cwd();
const PRESET_ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.agent-presets');
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const inside = (root, p) => { const r = resolve(root); const t = resolve(p); return t === r || t.startsWith(r + '/'); };

const server = new McpServer({ name: 'static-deploy', version: '0.0.1' });

server.registerTool('deploy-static', {
  description:
    '把工作区内的静态站点目录(须含 index.html)部署为指定 preset 的前端页:'
    + '整目录替换 <preset>/frontend/,host 即刻在 /assembler/ui/<presetId> 伺服。'
    + '源目录传相对工作区路径(如 dist 或 app/dist)。',
  inputSchema: {
    srcDir: z.string().describe('相对工作区的静态产物目录,如 dist'),
    presetId: z.string().describe('目标 preset id(必须已存在)'),
  },
}, async ({ srcDir, presetId }) => {
  const err = (t) => ({ isError: true, content: [{ type: 'text', text: `deploy-static: ${t}` }] });
  if (!ID_RE.test(String(presetId || ''))) return err('presetId 非法(kebab-case)');
  const src = resolve(PART_WORKDIR, String(srcDir || ''));
  if (!inside(PART_WORKDIR, src)) return err('srcDir 越出工作区,拒绝');
  if (!existsSync(src) || !statSync(src).isDirectory()) return err(`源目录不存在:${srcDir}`);
  if (!existsSync(join(src, 'index.html'))) return err('源目录缺 index.html(不是可伺服的静态站点)');
  const presetDir = join(PRESET_ROOT, presetId);
  if (!existsSync(join(presetDir, 'agent.cordis.yml'))) return err(`preset「${presetId}」不存在——先装配它`);
  const target = join(presetDir, 'frontend');
  try {
    rmSync(target, { recursive: true, force: true });
    cpSync(src, target, { recursive: true });
  } catch (e) { return err(`复制失败:${String(e && e.message || e)}`); }
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, deployedTo: target, url: `/assembler/ui/${presetId}` }) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
