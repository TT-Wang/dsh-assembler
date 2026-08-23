#!/usr/bin/env node
/**
 * app-scaffold — scaffold-as-part(P2 吸收协议 ①):不手包框架,直接调框架
 * 官方生成器。首发 create-vite(vanilla 模板,零框架心智负担);Expo 等是
 * 后续兄弟。产物落工作区,配合 static-deploy 部署为 preset 前端页。
 * Safety:目标目录锚定 PART_WORKDIR;目录已存在拒绝(不覆盖);npm 走网络
 * (供应链事实,BOM 由 registry/package-lock 记)。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const PART_WORKDIR = process.env.PART_WORKDIR || process.cwd();
const inside = (root, p) => { const r = resolve(root); const t = resolve(p); return t === r || t.startsWith(r + '/'); };

const server = new McpServer({ name: 'app-scaffold', version: '0.0.1' });

server.registerTool('scaffold-vite', {
  description:
    '在工作区用官方 create-vite 生成一个 vanilla(纯 TS/JS)web 应用骨架:'
    + '返回落盘目录与文件清单。之后由你写应用代码,npm install && npm run build 出 dist/,'
    + '再用 static-deploy 部署为 preset 前端页。',
  inputSchema: {
    dir: z.string().describe('相对工作区的目标目录名,如 myapp(必须不存在)'),
    template: z.string().optional().describe('vite 模板,默认 vanilla;可 vanilla-ts'),
  },
}, async ({ dir, template }) => {
  const err = (t) => ({ isError: true, content: [{ type: 'text', text: `scaffold-vite: ${t}` }] });
  const target = resolve(PART_WORKDIR, String(dir || ''));
  if (!inside(PART_WORKDIR, target) || target === resolve(PART_WORKDIR)) return err('目标目录越界或为空');
  if (existsSync(target)) return err(`目录已存在:${dir}(不覆盖,换名)`);
  const tpl = template === 'vanilla-ts' ? 'vanilla-ts' : 'vanilla';
  const run = spawnSync('npm', ['create', 'vite@latest', String(dir), '--', '--template', tpl], {
    cwd: PART_WORKDIR, encoding: 'utf8', timeout: 120000, env: { ...process.env, npm_config_yes: 'true', CI: 'true' },
  });
  if (run.status !== 0 || !existsSync(target)) {
    return err(`create-vite 失败(exit ${run.status}):${String(run.stderr || run.stdout || '').slice(-300)}`);
  }
  const files = readdirSync(target);
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, dir: String(dir), template: tpl, files, next: '写代码 → npm install && npm run build → deploy-static { srcDir: "' + String(dir) + '/dist", presetId }' }) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
