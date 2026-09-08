#!/usr/bin/env node
/**
 * shipped-catalog 一致性闸:对真实 shipped 数据(capabilities.yml ↔
 * index/catalog.yml ↔ generated/ 入口)做离线一致性校验。
 *
 * 基线:docs/code-review-2026-09-08/01-t1-core-pipeline.md M1(两条 via:'mcp'
 * 条目无 config.server → 发射端静默剔除)、03-t3-orchestrated-tools.md OT 数据面、
 * 06-t6-test-gates.md M1(README 计数陈旧且无闸)/M2(三向一致性无闸且真实违例
 * 发生过)、07-t7-synthesis.md C1/R4/R12。验收 A5。
 *
 * 跑法:node tests-shipped-catalog.mjs(纯数据闸,离线,无需 build;npm test 链
 * 在 catalog-report --check 之后调用)。
 *
 * 计数口径说明(与 06-t6 M1 "实测 311 工具行"一致):
 *   工具行 = registerCore 发射的 `    - { name: ... }` flow 行。binary-write /
 *   book-intake 两条历史手写条目的工具用了块式行(`    - name: x`),不在该口径
 *   内(共 4 行,见 BLOCK_TOOL_LEGACY);块式行若出现在其它条目即视为漂移并报错
 *   ——新条目只会由 registerCore 以 flow 行写入。parts/service/library/
 *   first-party 按结构解析(与 catalog-report.mjs 同口径)。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const REPO = join(dirname(fileURLToPath(import.meta.url)))
const failCount = { n: 0 }
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failCount.n++
}

const catalogPath = join(REPO, 'index', 'catalog.yml')
const capsPath = join(REPO, 'capabilities.yml')
if (!existsSync(catalogPath) || !existsSync(capsPath)) {
  console.error('缺 shipped 数据文件(index/catalog.yml / capabilities.yml)——请在仓库根运行')
  process.exit(1)
}
const catalog = yaml.load(readFileSync(catalogPath, 'utf8'))
const caps = yaml.load(readFileSync(capsPath, 'utf8'))
const servers = caps['mcp-servers'] ?? {}
const capList = Array.isArray(caps.capabilities) ? caps.capabilities : []
const catalogText = readFileSync(catalogPath, 'utf8')

// ── (a) via:'mcp' 能力条目必须带 config.server 且 ∈ mcp-servers ────────────
// 违例历史:sms-gateway/mobi-parser 无 config.server,index.ts:422-424 选中即
// 静默剔除(01-t1 M1)。已修复;此闸防再犯。
const mcpCaps = capList.filter((c) => c.via === 'mcp')
const mcpViolators = mcpCaps.filter(
  (c) => typeof c.config?.server !== 'string' || c.config.server === '' || servers[c.config.server] === undefined,
)
check(
  `(a) via:'mcp' 能力条目(${mcpCaps.length})都带 config.server 且 ∈ mcp-servers`,
  mcpViolators.length === 0,
  mcpViolators.map((c) => `${c.id} → config.server=${JSON.stringify(c.config?.server)}`).join('; '),
)

// ── (b) catalog.yml 条目 ↔ mcp-servers 键双向完备 ──────────────────────────
// 白名单(键存在但没有 catalog 行):filesystem —— 官方 filesystem MCP,装在根
// node_modules 而非目录零件(见 capabilities.yml mcp-servers 段注释:随 preset
// 发射、@@WORKSPACE@@ 槽位替身);目录只收"零件",不收官方工具。
// kg-memory 不是本轴例外:catalog.yml 有 kg-memory 行、mcp-servers 有同名校键
// (双向完备),只是其 args 指向 generated/kg-memory/node_modules(见 (c) 豁免)。
const SERVER_NO_CATALOG = {
  filesystem: '官方 filesystem MCP(根 node_modules,非目录零件;随 preset 发射,@@WORKSPACE@@/@@KBDIR@@ 槽位)',
}
const catalogIds = catalog.map((x) => x.id)
const serverKeys = Object.keys(servers)
const orphanCaps = catalogIds.filter((id) => servers[id] === undefined)
check('(b1) 每条 catalog 行都有 mcp-servers 键', orphanCaps.length === 0, `缺键:${orphanCaps.join(', ')}`)
const extraKeys = serverKeys.filter((k) => !catalogIds.includes(k))
const extraUnexpected = extraKeys.filter((k) => SERVER_NO_CATALOG[k] === undefined)
check(
  '(b2) mcp-servers 多余键 ⊆ 显式白名单',
  extraUnexpected.length === 0,
  `未白名单的多余键:${extraUnexpected.join(', ')};白名单:${Object.entries(SERVER_NO_CATALOG).map(([k, r]) => `${k}(${r})`).join(' ')}`,
)

// ── (c) 入口存在性:args 指向 generated/<id>/index.js 者文件必须存在 ────────
// 豁免(注明):(1) 含 '/node_modules/' 的 arg —— 依赖安装态(filesystem /
// kg-memory / stock-sdk 收编件,生成/装配时 npm install 后才存在);(2) '@@'
// 槽位 arg(filesystem 的 @@WORKSPACE@@/@@KBDIR@@,发射时替位);(3) 非路径
// 形态 arg(如收编件 bin 的子命令 'mcp')。其余必须是仓库内存在的文件:
// 绝对路径按仓库前缀剥,机器绝对路径按 '/generated/' 后缀映射到本检出。
const FLOW_TOOL_RE = /^\s*-\s*\{\s*name:/gm
const blockRowRe = /^ {4}- name:/
const flowToolRows = (catalogText.match(FLOW_TOOL_RE) ?? []).length
// 块式行(legacy 白名单):binary-write(1)/book-intake(3) 历史手写条目的工具行,
// 工具真实存在但不在 flow 行口径内。逐行 test 用非 /g 正则,避免 lastIndex 漂移。
const blockRows = catalogText.split('\n').filter((l) => blockRowRe.test(l)).length
const blockOwners = new Set()
let curId = null
for (const line of catalogText.split('\n')) {
  const m = line.match(/^- id: (\S+)/)
  if (m !== null) { curId = m[1]; continue }
  if (blockRowRe.test(line) && curId !== null) blockOwners.add(curId)
}
const BLOCK_TOOL_LEGACY = ['binary-write', 'book-intake'] // 历史块式行,工具真实存在但不在 flow 行口径内
const blockUnexpected = [...blockOwners].filter((id) => !BLOCK_TOOL_LEGACY.includes(id))
check('(c0) 块式工具行只出现在 legacy 白名单条目', blockUnexpected.length === 0,
  `新块式行条目:${blockUnexpected.join(', ')};registerCore 只写 flow 行(- { name: …}),历史条目 ${BLOCK_TOOL_LEGACY.join('/')} 除外`)

const parsedTools = catalog.reduce((n, x) => n + (x.tools?.length ?? 0), 0)
check('(c0b) 数据自洽:解析工具数 = flow 行 + legacy 块式行', parsedTools === flowToolRows + blockRows,
  `parsed=${parsedTools} flow=${flowToolRows} block=${blockRows}`)

const missingEntries = []
let checkedFiles = 0
for (const key of serverKeys) {
  for (const arg of servers[key].args ?? []) {
    if (typeof arg !== 'string' || arg === '') continue
    if (arg.includes('/node_modules/') || arg.includes('@@')) continue // (1)(2) 豁免
    if (!arg.startsWith('/') && !arg.startsWith('generated/') && !arg.startsWith('catalogs/')) continue // (3) 子命令等非路径 arg
    const rel = arg.startsWith(REPO + '/')
      ? arg.slice(REPO.length + 1)
      : arg.includes('/generated/')
        ? arg.slice(arg.indexOf('/generated/') + 1) // 机器绝对路径 → 本检出相对
        : arg
    checkedFiles++
    if (!existsSync(join(REPO, rel))) missingEntries.push(`${key}: ${arg}`)
  }
}
check(`(c) 入口文件存在(检查 ${checkedFiles} 个路径 arg;node_modules/@@/子命令 arg 豁免)`,
  missingEntries.length === 0, missingEntries.join('; '))

// ── (e) README 计数与实测一致(防漂移,06-t6 M1)────────────────────────────
const parts = catalog.length
const service = catalog.filter((x) => x.kind === 'service').length
const firstParty = catalog.filter((x) => x.repo === 'first-party').length
const library = catalog.filter((x) => x.kind !== 'service' && x.repo !== 'first-party').length
const tools = flowToolRows // 口径见文件头:registerCore 发射行(与 06-t6 M1 实测一致)
const readmeEn = readFileSync(join(REPO, 'README.md'), 'utf8')
const readmeZh = readFileSync(join(REPO, 'README.zh.md'), 'utf8')
const enCore = `${parts} parts / ${tools} tools`
const enBreak = `${library} library-backed, ${service} service-backed, ${firstParty} first-party`
const zhCore = `${parts} 个零件 / ${tools} 个工具`
const zhBreak = `${library} 库型、${service} 服务型、${firstParty} 第一方`
const occ = (s, p) => (s.match(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
check(`(e) README.md 计数(实测 ${parts} parts / ${tools} tools — ${library} library / ${service} service / ${firstParty} first-party,至少两处声明)`,
  occ(readmeEn, enCore) >= 2 && occ(readmeEn, enBreak) >= 2,
  `core=${occ(readmeEn, enCore)}/≥2 breakdown=${occ(readmeEn, enBreak)}/≥2 (期望文本:"${enCore}" 与 "${enBreak}")`)
check(`(e) README.zh.md 计数(实测 ${parts} 零件 / ${tools} 工具 — ${library} 库型 / ${service} 服务型 / ${firstParty} 第一方,至少两处声明)`,
  occ(readmeZh, zhCore) >= 2 && occ(readmeZh, zhBreak) >= 2,
  `core=${occ(readmeZh, zhCore)}/≥2 breakdown=${occ(readmeZh, zhBreak)}/≥2 (期望文本:"${zhCore}" 与 "${zhBreak}")`)

console.log(`\nshipped-catalog 现状:${parts} 条目 / ${service} 服务型 / ${firstParty} 第一方 / ${library} 库型;工具行 ${tools}(flow)+${blockRows}(legacy 块式)=解析 ${parsedTools};mcp-servers ${serverKeys.length} 键;via:'mcp' 能力 ${mcpCaps.length} 条`)
if (failCount.n > 0) {
  console.error(`tests-shipped-catalog: ${failCount.n} failed`)
  process.exit(1)
}
console.log('tests-shipped-catalog: all green')
