#!/usr/bin/env node
/**
 * 目录分层单元测试。
 *
 * 客户目录**垫在**公共目录之上,而不是取代它。这条是被真实交付逼出来的:
 * northwind 这一单里,两个上游(OSV.dev / deps.dev)是公共基础设施、属于公共
 * 目录,只有治理口径属于客户;而 catalogPath 当时只认一个路径,把它指向客户
 * 目录就只剩知识包、一个零件都看不见,唯一的出路是每个客户各包一遍同一个公开
 * API——正是去重门要挡的事。
 *
 * 同时必须守住隔离:A 客户的条目绝不能出现在 B 客户的装配里。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCatalog, dedupeRowsById, knowledgeLocatorText, catalogChain } from './lib/index.js'

let failed = 0
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra === '' ? '' : ` — ${extra}`}`)
  if (!cond) failed++
}
const threw = (name, fn, match) => {
  let msg = null
  try { fn() } catch (e) { msg = e.message }
  ok(name, msg !== null && (match === undefined || msg.includes(match)), msg === null ? '(没有抛)' : msg.slice(0, 70))
}

const root = mkdtempSync(join(tmpdir(), 'catalog-layer-'))
const write = (rel, text) => {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
  return p
}

const base = write('base.yml', `
mcp-servers:
  shared-part:
    command: node
    args: ["/shared.js"]
  overridden-part:
    command: node
    args: ["/base.js"]
capabilities:
  - id: shared-row
    description: from base
  - id: overridden-row
    description: from base
`)

const overlay = write('clients/alpha/capabilities.yml', `
extends: ../../base.yml
mcp-servers:
  alpha-only:
    command: node
    args: ["/alpha.js"]
  overridden-part:
    command: node
    args: ["/alpha-override.js"]
capabilities:
  - id: alpha-row
    description: from alpha
  - id: overridden-row
    description: from alpha
`)

const other = write('clients/beta/capabilities.yml', `
extends: ../../base.yml
mcp-servers:
capabilities:
  - id: beta-row
    description: from beta
`)

// ── 合并 ───────────────────────────────────────────────────────────────────
const a = loadCatalog(overlay)
const ids = a.capabilities.map((c) => c.id)
ok('看得见基座的行', ids.includes('shared-row'))
ok('看得见自己的行', ids.includes('alpha-row'))
ok('看得见基座的 server', 'shared-part' in a['mcp-servers'])
ok('看得见自己的 server', 'alpha-only' in a['mcp-servers'])
ok('行不重复(同 id 只留一条)', ids.filter((x) => x === 'overridden-row').length === 1, ids.join(','))

// ── 覆盖 ───────────────────────────────────────────────────────────────────
ok('同 id 时客户层覆盖基座(行)',
  a.capabilities.find((c) => c.id === 'overridden-row')?.description === 'from alpha')
ok('同 id 时客户层覆盖基座(server)',
  a['mcp-servers']['overridden-part'].args[0] === '/alpha-override.js',
  a['mcp-servers']['overridden-part'].args[0])
ok('覆盖后的行排在基座行之后(客户层是最后一句话)',
  ids.indexOf('alpha-row') > ids.indexOf('shared-row'))

// ── 隔离 ───────────────────────────────────────────────────────────────────
const b = loadCatalog(other)
ok('beta 看不到 alpha 的行', !b.capabilities.some((c) => c.id === 'alpha-row'))
ok('beta 看不到 alpha 的 server', !('alpha-only' in b['mcp-servers']))
ok('beta 仍看得到基座', b.capabilities.some((c) => c.id === 'shared-row'))
ok('beta 的空 mcp-servers 段不报错', typeof b['mcp-servers'] === 'object')

// ── 无 extends:行为不变 ───────────────────────────────────────────────────
const standalone = write('standalone.yml', `
mcp-servers:
  only:
    command: node
capabilities:
  - id: only-row
`)
const s = loadCatalog(standalone)
ok('没写 extends 就只有自己(旧行为不变)',
  s.capabilities.length === 1 && Object.keys(s['mcp-servers']).length === 1)

// ── 路径是相对声明它的那个文件 ─────────────────────────────────────────────
ok('extends 相对自身所在目录解析(而不是进程 cwd)',
  loadCatalog(overlay).capabilities.some((c) => c.id === 'shared-row'))

// ── 环与深度 ───────────────────────────────────────────────────────────────
const loopA = write('loop-a.yml', 'extends: ./loop-b.yml\ncapabilities:\n  - id: a\n')
write('loop-b.yml', 'extends: ./loop-a.yml\ncapabilities:\n  - id: b\n')
threw('自指成环时抛错而不是无限递归', () => loadCatalog(loopA), 'cycle')

const selfLoop = write('self.yml', 'extends: ./self.yml\ncapabilities:\n  - id: x\n')
threw('直接自引用也抛错', () => loadCatalog(selfLoop), 'cycle')

// 一条足够长的链:超过层数上限要抛,而不是默默截断
let prev = write('chain/L0.yml', 'capabilities:\n  - id: L0\n')
for (let i = 1; i <= 10; i++) {
  prev = write(`chain/L${i}.yml`, `extends: ./L${i - 1}.yml\ncapabilities:\n  - id: L${i}\n`)
}
threw('链过深时抛错(不默默截断)', () => loadCatalog(prev), 'layers')

// ── 缺失的基座要报出来,不能静默当空 ───────────────────────────────────────
const dangling = write('dangling.yml', 'extends: ./nope.yml\ncapabilities:\n  - id: x\n')
threw('extends 指向不存在的文件时报错', () => loadCatalog(dangling))

// ── 行去重:两个能力想要同一行是正常的 ─────────────────────────────────────
// 知识包要文件检索,content-search 也要;两个都被选中时,preset 里必须只出现
// 一行——否则 host 直接拒载整个 preset("duplicate loader entry id:
// tool-fs-search"),三个 agent 就是这么全挂的。
const rows = [
  { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { a: 1 } },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
  { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { a: 2 } },
]
const deduped = dedupeRowsById(rows)
ok('同 id 的行只留一条', deduped.length === 2, deduped.map((r) => r.id).join(','))
ok('留的是第一条(配置不做合并,合并出来的配置没人写过也没人审过)',
  deduped.find((r) => r.id === 'tool-fs-search')?.config.a === 1)
ok('顺序保持不变', JSON.stringify(deduped.map((r) => r.id)) === JSON.stringify(['tool-fs-search', 'tool-web']))
ok('空数组安全', dedupeRowsById([]).length === 0)
ok('全同 id 折成一条', dedupeRowsById([{ id: 'x' }, { id: 'x' }, { id: 'x' }]).length === 1)
ok('不改动入参数组', rows.length === 3)

// ── 层链:BOM 的出处要顺着同一条链找 ───────────────────────────────────────
// index/catalog.yml 躺在每个 catalog 旁边,所以 catalog 分层了、index 也就分层
// 了。第一次只读顶层 index 的后果是交接文档里"出处 / 许可"两列整列空白——
// 而那正是那张表存在的理由。
const chain = catalogChain(overlay)
ok('层链按基座在前的顺序', chain.length === 2 && chain[1] === overlay, chain.length + ' 层')
ok('基座在链首', chain[0].endsWith('base.yml'))
ok('无 extends 时链长为 1', catalogChain(standalone).length === 1)
ok('成环时不无限递归', catalogChain(loopA).length <= 8 + 1)

// ── 知识定位:装好了还得说在哪 ─────────────────────────────────────────────
// 实测代价:preset 把文档拷进 kb/ 却只说"以 xx 口径文档为准",不给路径,
// agent 第一轮就花了 18 次调用(glob / search_files / directory_tree /
// list_directory / get_file_info / grep)去找一直待在固定路径上的文件。
const loc = knowledgeLocatorText([
  { id: 'nw-oss-governance', docs: 2, dir: '/p/kb/nw-oss-governance', files: ['01-a.md', '02-b.md'], version: '2026-08-17' },
])
ok('给出绝对目录', loc.includes('/p/kb/nw-oss-governance'))
ok('列出文件名', loc.includes('01-a.md') && loc.includes('02-b.md'))
ok('带版本', loc.includes('2026-08-17'))
ok('明确叫它别去搜', /不要去搜索|不要.*遍历/.test(loc))
ok('没有知识包时是空串(不往 persona 里塞空话)', knowledgeLocatorText([]) === '')
const two = knowledgeLocatorText([
  { id: 'a', docs: 1, dir: '/p/kb/a', files: ['x.md'] },
  { id: 'b', docs: 1, dir: '/p/kb/b', files: ['y.md'] },
])
ok('多个知识包各占一行', two.split('\n').filter((l) => l.startsWith('- ')).length === 2)
ok('缺版本时不写"版本 undefined"', !two.includes('undefined'))

console.log(`\n==== 目录分层单元测试: ${failed === 0 ? '全部通过 ✅' : `${failed} 条失败 ❌`} ====`)
process.exit(failed === 0 ? 0 : 1)
