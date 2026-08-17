#!/usr/bin/env node
/**
 * 索引流水线 CLI —— 把"收录一个新开源库"压成命令序列。
 *
 * 设计给 agent 调用:CLI 只做确定性环节(取源、出工单、装依赖、质检、登记),
 * "切分能力点 + 写适配代码"这一智能环节留给调用方(调用方本来就是 LLM)。
 * 每个子命令最后一行输出一个 JSON 判定,机器可判读;质检门在流水线里:
 * verify 不过,register 直接拒绝。
 *
 * 用法:
 *   node scripts/index-add.mjs scaffold <owner/repo> --pkg <npm包名> [--id <零件id>]
 *       取 npm 元数据(版本/许可证)、浅取上游源码到 .cache/upstream/<id>、
 *       生成 generated/<id>/{package.json,.index-meta.json,WORK-ORDER.md} 骨架。
 *       然后由调用方按工单写 index.js + smoke.mjs。
 *   node scripts/index-add.mjs verify <id>
 *       npm install → 跑 smoke.mjs(exit 0 必须)→ 独立 listTools 实探 →
 *       写 index/reports/<id>.json。
 *   node scripts/index-add.mjs register <id>
 *       verify 报告必须存在且通过;幂等登记 index/catalog.yml +
 *       capabilities.yml 的 mcp-servers 段。
 *   node scripts/index-add.mjs check-all
 *       全量复检:跑每个 generated/<id>/smoke.mjs,任一失败退出非零。
 */
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const [cmd, target, ...rest] = process.argv.slice(2)
const flags = {}
for (let i = 0; i < rest.length; i += 2) {
  if (rest[i]?.startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1]
}

const die = (msg) => {
  console.log(JSON.stringify({ ok: false, error: msg }))
  process.exit(1)
}
const out = (obj) => {
  console.log(JSON.stringify({ ok: true, ...obj }))
}

// ── scaffold ───────────────────────────────────────────────────────────────
function scaffold() {
  const repoSlug = target
  if (!repoSlug?.includes('/')) die('scaffold 需要 <owner/repo>,如 kpdecker/jsdiff')
  const pkg = flags.pkg ?? repoSlug.split('/')[1]
  const id = (flags.id ?? pkg).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')

  let meta
  try {
    meta = JSON.parse(execSync(`npm view ${pkg} version license description --json`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  } catch {
    die(`npm view ${pkg} 失败——包名不对?用 --pkg 指定 npm 包名`)
  }

  const upstream = join(REPO, '.cache', 'upstream', id)
  if (!existsSync(upstream)) {
    try {
      execSync(`git clone --depth 1 https://github.com/${repoSlug}.git "${upstream}"`, { stdio: 'pipe' })
    } catch {
      // 上游读不到不拦骨架:调用方还能从 npm README/类型定义读 API
    }
  }
  const upstreamFiles = existsSync(upstream)
    ? readdirSync(upstream).filter((f) => !f.startsWith('.')).slice(0, 40)
    : []

  const dir = join(REPO, 'generated', id)
  mkdirSync(dir, { recursive: true })
  const pkgJsonPath = join(dir, 'package.json')
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(pkgJsonPath, JSON.stringify({
      name: `@dsh-index/${id}`,
      version: '0.0.1',
      type: 'module',
      private: true,
      description: `MCP stdio server exposing ${pkg} tools`,
      dependencies: {
        '@modelcontextprotocol/sdk': '^1.0.0',
        zod: '^3.23.0',
        [pkg]: meta.version,
      },
    }, null, 2) + '\n')
  }
  writeFileSync(join(dir, '.index-meta.json'), JSON.stringify({
    id, pkg, version: meta.version, repo: repoSlug,
    license: meta.license ?? 'UNKNOWN',
    scaffoldedAt: new Date().toISOString(),
  }, null, 2) + '\n')

  writeFileSync(join(dir, 'WORK-ORDER.md'), `# 收录工单:${id}(${pkg}@${meta.version})

上游:https://github.com/${repoSlug}(${meta.license ?? '许可证未知'})
${meta.description ? `简介:${meta.description}` : ''}
源码副本:${existsSync(upstream) ? `.cache/upstream/${id}/(顶层:${upstreamFiles.join(', ')})` : '克隆失败,读 npm 文档'}

## 要写的两个文件(户型规范,参照 generated/binary-write/)

1. **index.js** — MCP stdio 适配服务器
   - McpServer({ name: '${id}', version: '0.0.1' }) + StdioServerTransport
   - 切 2~4 个"工具级能力点":选这个库最常用、一轮对话内可完成的操作
   - registerTool:inputSchema 用 zod;description 中文、说清输入输出与边界
   - 错误路径返回 { isError: true, content: [{type:'text', text: ...}] },不抛裸异常
   - 只 import 锁定版本的 ${pkg}(package.json 已精确锁 ${meta.version}),不访问网络除非能力本身是网络
2. **smoke.mjs** — 冒烟(check() 计数模式,最后 process.exit(failures))
   - listTools 数量断言 → 每个工具至少一次**真实调用**并断言内容结果 → 至少一条错误路径被拒

## 完成后
   node scripts/index-add.mjs verify ${id}     # 质检(不过不入库)
   node scripts/index-add.mjs register ${id}   # 登记两个目录文件
`)
  out({ id, pkg, version: meta.version, license: meta.license ?? 'UNKNOWN', workOrder: `generated/${id}/WORK-ORDER.md`, upstream: existsSync(upstream) ? `.cache/upstream/${id}` : null, next: `写 generated/${id}/{index.js,smoke.mjs},然后 verify` })
}

// ── verify ─────────────────────────────────────────────────────────────────
async function verify() {
  const id = target
  const dir = join(REPO, 'generated', id ?? '')
  if (!id || !existsSync(dir)) die(`generated/${id} 不存在——先 scaffold`)
  for (const f of ['index.js', 'smoke.mjs', 'package.json']) {
    if (!existsSync(join(dir, f))) die(`缺 ${f}——按 WORK-ORDER.md 补齐`)
  }
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8', timeout: 300_000 })
  if (install.status !== 0) die(`npm install 失败:${(install.stderr ?? '').slice(-400)}`)
  const smoke = spawnSync('node', ['smoke.mjs'], { cwd: dir, encoding: 'utf8', timeout: 120_000 })
  process.stderr.write(smoke.stdout ?? '')
  if (smoke.status !== 0) die(`smoke.mjs 退出码 ${smoke.status}——冒烟未过,不入库`)

  // 独立实探:不信 smoke 自报,从装配器自身依赖直接 listTools
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const client = new Client({ name: 'index-add-verify', version: '0.0.1' })
  await client.connect(new StdioClientTransport({ command: 'node', args: [join(dir, 'index.js')] }))
  const tools = (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description ?? '' }))
  await client.close()
  if (tools.length === 0) die('listTools 为空')

  mkdirSync(join(REPO, 'index', 'reports'), { recursive: true })
  writeFileSync(join(REPO, 'index', 'reports', `${id}.json`), JSON.stringify({
    id, verifiedAt: new Date().toISOString(), node: process.version,
    smoke: 'pass', tools,
  }, null, 2) + '\n')
  out({ id, tools: tools.map((t) => t.name), report: `index/reports/${id}.json`, next: `register ${id}` })
}

// ── register ───────────────────────────────────────────────────────────────
function register() {
  const id = target
  const dir = join(REPO, 'generated', id ?? '')
  const metaPath = join(dir, '.index-meta.json')
  const reportPath = join(REPO, 'index', 'reports', `${id}.json`)
  if (!existsSync(metaPath)) die('缺 .index-meta.json——先 scaffold')
  if (!existsSync(reportPath)) die('缺 verify 报告——质检门:先 verify 且必须通过')
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  if (report.smoke !== 'pass') die('verify 报告非 pass,拒绝登记')

  const changed = []
  // catalog.yml:追加条目(幂等)
  const catalogPath = join(REPO, 'index', 'catalog.yml')
  const catalog = readFileSync(catalogPath, 'utf8')
  if (!new RegExp(`^- id: ${id}$`, 'm').test(catalog)) {
    const toolLines = report.tools
      .map((t) => `    - { name: ${t.name}, description: ${JSON.stringify(t.description.replace(/\n[\s\S]*/, '').slice(0, 80))} }`)
      .join('\n')
    writeFileSync(catalogPath, catalog.replace(/\n*$/, '\n') + `
- id: ${id}
  repo: ${meta.repo}
  rev: v${meta.version}
  license: ${meta.license}
  tools:
${toolLines}
`)
    changed.push('index/catalog.yml')
  }
  // capabilities.yml:mcp-servers 段插入连接配置(段尾 = capabilities: 键之前;幂等)
  const capsPath = join(REPO, 'capabilities.yml')
  const caps = readFileSync(capsPath, 'utf8')
  if (!new RegExp(`^  ${id}:$`, 'm').test(caps)) {
    const entry = `  ${id}:\n    transport: stdio\n    command: node\n    args: ['${join(REPO, 'generated', id, 'index.js')}']\n\n`
    if (!/^capabilities:$/m.test(caps)) die('capabilities.yml 缺 capabilities: 键,无法定位 mcp-servers 段尾')
    writeFileSync(capsPath, caps.replace(/^capabilities:$/m, entry + 'capabilities:'))
    changed.push('capabilities.yml')
  }
  out({ id, registered: changed, note: changed.length > 0 ? 'git diff 后提交即完成收录;联邦缓存无此 server 键,下次装配自动实探' : '已登记过,无改动' })
}

// ── check-all ──────────────────────────────────────────────────────────────
function checkAll() {
  const gen = join(REPO, 'generated')
  const ids = readdirSync(gen).filter((d) => existsSync(join(gen, d, 'smoke.mjs')))
  const results = []
  for (const id of ids) {
    const r = spawnSync('node', ['smoke.mjs'], { cwd: join(gen, id), encoding: 'utf8', timeout: 120_000 })
    results.push({ id, pass: r.status === 0 })
    console.error(`${r.status === 0 ? '  ✓' : '  ✗ FAIL'} ${id}`)
  }
  const failed = results.filter((r) => !r.pass)
  console.log(JSON.stringify({ ok: failed.length === 0, total: results.length, failed: failed.map((r) => r.id) }))
  process.exit(failed.length === 0 ? 0 : 1)
}

if (cmd === 'scaffold') scaffold()
else if (cmd === 'verify') await verify()
else if (cmd === 'register') register()
else if (cmd === 'check-all') checkAll()
else die('用法:index-add.mjs scaffold <owner/repo> --pkg <npm名> | verify <id> | register <id> | check-all')
