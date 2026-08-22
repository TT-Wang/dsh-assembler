/**
 * Smoke test for @dsh-index/mobi-parser MCP stdio server.
 * Connects a real MCP client, lists tools, and exercises every tool with a
 * REAL MOBI file from the upstream example fixtures, plus error paths.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let failures = 0
const check = (cond, label) => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}`)
  if (!cond) failures++
}

function textOf(result) {
  const t = result && result.content && result.content[0]
  return t ? t.text : JSON.stringify(result)
}

const here = dirname(fileURLToPath(import.meta.url))
// 真实 MOBI 测试文件:上游 example 里的 Alice in Wonderland
const MOBI = join(here, '..', '..', '.cache', 'upstream', 'mobi-parser', 'example', 'Alices-Adventures.mobi')
const NOFILE = join(here, 'definitely-not-here.mobi')

if (!existsSync(MOBI)) {
  console.error(`缺真实测试文件:${MOBI}(先 scaffold 拉取上游源码)`)
  process.exit(1)
}

const transport = new StdioClientTransport({ command: 'node', args: ['index.js'] })
const client = new Client({ name: 'mobi-parser-smoke', version: '0.0.1' })
await client.connect(transport)

const { tools } = await client.listTools()
console.log(`TOOLS (${tools.length}):`)
for (const t of tools) console.log(`- ${t.name}: ${(t.description || '').slice(0, 80)}...`)
console.log('---')
check(tools.length >= 3, `listTools 至少 3 个(实得 ${tools.length})`)

// 1) parse-mobi: 真实文件 -> 元数据 + spine
const r1 = await client.callTool({ name: 'parse-mobi', arguments: { filePath: MOBI } })
const t1 = textOf(r1)
console.log('parse-mobi:')
console.log(t1.slice(0, 600))
console.log('---')
let parsed1
try { parsed1 = JSON.parse(t1) } catch { /* below */ }
check(parsed1 && typeof parsed1.metadata === 'object', 'parse-mobi 返回 metadata 对象')
check(parsed1 && typeof parsed1.metadata.title === 'string' && parsed1.metadata.title.length > 0, 'parse-mobi 提取到标题')
check(parsed1 && Array.isArray(parsed1.spine) && parsed1.spine.length > 0, `parse-mobi 提取到章节 spine(共 ${parsed1?.spine?.length ?? 0} 章)`)
const firstId = parsed1?.spine?.[0]?.id

// 2) read-chapter: 读第一章正文(纯文本)
const r2 = await client.callTool({ name: 'read-chapter', arguments: { filePath: MOBI, chapterId: firstId } })
const t2 = textOf(r2)
console.log('read-chapter (first chapter):')
console.log(t2.slice(0, 400))
console.log('---')
let parsed2
try { parsed2 = JSON.parse(t2) } catch { /* below */ }
check(parsed2 && typeof parsed2.text === 'string' && parsed2.text.length > 0, `read-chapter 返回非空正文(${parsed2?.text?.length ?? 0} 字符)`)
check(parsed2 && parsed2.chapterId === String(firstId), 'read-chapter 回显章节 id')
check(parsed2 && typeof parsed2.text === 'string' && !/<[a-z]/.test(parsed2.text.slice(0, 200)), 'read-chapter 正文已剥离 HTML 标签')

// 3) get-toc: 目录树
const r3 = await client.callTool({ name: 'get-toc', arguments: { filePath: MOBI } })
const t3 = textOf(r3)
console.log('get-toc:')
console.log(t3.slice(0, 400))
console.log('---')
let parsed3
try { parsed3 = JSON.parse(t3) } catch { /* below */ }
check(parsed3 && Array.isArray(parsed3.toc), 'get-toc 返回 toc 数组')

// 4) 错误路径:不存在的章节 id
const r4 = await client.callTool({ name: 'read-chapter', arguments: { filePath: MOBI, chapterId: '999999' } })
const t4 = textOf(r4)
console.log('read-chapter (bad chapterId):')
console.log(t4.slice(0, 200))
console.log('---')
check(t4.startsWith('Error:'), 'read-chapter 对不存在章节返回 Error')

// 5) 错误路径:不存在的文件
const r5 = await client.callTool({ name: 'parse-mobi', arguments: { filePath: NOFILE } })
const t5 = textOf(r5)
console.log('parse-mobi (missing file):')
console.log(t5.slice(0, 200))
console.log('---')
check(t5.startsWith('Error:'), 'parse-mobi 对缺失文件返回 Error')

await client.close()
console.log(`SMOKE ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
