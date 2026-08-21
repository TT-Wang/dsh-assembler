/**
 * 联邦缓存单元测试:serverCacheKey 失效语义 + toolsToEntries 确定性。
 * 跑法:node tests-federation.mjs(先 npm run build)
 */
import { serverCacheKey, toolsToEntries, federateMcpTools } from './lib/index.js'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

const dir = mkdtempSync(join(tmpdir(), 'fed-cache-test-'))
const adapter = join(dir, 'index.js')
writeFileSync(adapter, 'v1')
const dataRoot = join(dir, 'data')
mkdirSync(dataRoot)

// 1. serverCacheKey:同配置稳定、配置变则变
const cfg = { transport: 'stdio', command: 'node', args: [adapter, dataRoot] }
const k1 = serverCacheKey(cfg)
check('同配置键稳定', k1 === serverCacheKey(cfg))
check('键为 16 位 hex', /^[0-9a-f]{16}$/.test(k1), k1)
check('配置变则键变', k1 !== serverCacheKey({ ...cfg, command: 'node20' }))

// 2. 适配器文件改动(重新生成零件)必须失效
utimesSync(adapter, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
const k2 = serverCacheKey(cfg)
check('文件 arg 触碰则键变(适配器重生成必须重探)', k2 !== k1)

// 3. 目录 arg 的 mtime 抖动不得失效(数据根如 /tmp,每个无关临时文件都会
//    改它的 mtime;曾让 npx 型零件几乎每次都假失效重探 ~3s)
writeFileSync(join(dataRoot, 'noise.txt'), 'x')
check('目录 arg 抖动不失效', serverCacheKey(cfg) === k2)

// 4. 不存在的 arg(flag、包名)不参与 stamp,不抛错
const k3 = serverCacheKey({ command: 'npx', args: ['-y', '@scope/pkg', dataRoot] })
check('非路径 arg 安全', /^[0-9a-f]{16}$/.test(k3))

// 5. toolsToEntries:确定性 + id 归一 + 描述兜底 + tags 构造
const tools = [
  { name: 'Http.Get', description: 'Fetch a URL over HTTP with headers support' },
  { name: 'plain-tool' },
]
const e1 = toolsToEntries('http-request', tools)
const e2 = toolsToEntries('http-request', tools)
check('映射确定性(缓存/实探同构)', JSON.stringify(e1) === JSON.stringify(e2))
check('id 归一小写-连字符', e1[0].id === 'mcp-http-request-http-get', e1[0].id)
check('tool 全名保留原样', e1[0].tool === 'mcp__http-request__Http.Get')
check('无描述兜底', e1[1].description.includes('plain-tool'), e1[1].description)
check('tags 含 server 名', e1[0].tags.includes('http-request'))

rmSync(dir, { recursive: true, force: true })

// 6. 可达闸:stdio 命令本机解析不到 ⇒ 整台服务器剔除(不炸、不入目录、不 spawn)。
// 目录只许承诺本机此刻真能拉起的零件——filesystem 幽灵挂载(命令不存在、目录
// 照旧售卖其工具、agent 求助用户挂满 600s)就是这道闸缺席的代价。
const fedOut = await federateMcpTools({
  capabilities: [],
  'mcp-servers': {
    'ghost-abs': { transport: 'stdio', command: '/nonexistent-assembler-test-bin-xyz', args: [] },
    'ghost-bare': { transport: 'stdio', command: 'nonexistent-assembler-cmd-xyz', args: [] },
  },
})
check('不可达 stdio 服务器整台剔除', fedOut.capabilities.length === 0, JSON.stringify(fedOut.capabilities))

console.log(`\n==== federation 缓存单元测试: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`)
process.exit(failures === 0 ? 0 : 1)
