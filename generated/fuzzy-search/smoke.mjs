/**
 * Smoke test for @dsh-index/fuzzy-search MCP stdio server.
 * Connects a real MCP client, lists tools, exercises every tool
 * (real fuzzy-search round-trips, index create/reuse, config,
 * and missing-required-param validation), then asserts outcomes.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// Watchdog so a hanging child can never hang this script forever.
const watchdog = setTimeout(() => {
  console.error('SMOKE TIMEOUT after 60s')
  process.exit(2)
}, 60000)
watchdog.unref()

function textOf(result) {
  const t = result && result.content && result.content[0]
  return t ? t.text : JSON.stringify(result)
}

const transport = new StdioClientTransport({ command: 'node', args: ['index.js'] })
const client = new Client({ name: 'fuzzy-search-smoke', version: '0.0.1' })
await client.connect(transport)

let failures = 0
function check(label, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  <-- ${detail || ''}`}`)
  if (!cond) failures += 1
}

/* 1) listTools */
const { tools } = await client.listTools()
console.log(`TOOLS (${tools.length}):`)
for (const t of tools) console.log(`- ${t.name}: ${(t.description || '').slice(0, 90)}...`)
console.log('---')
check('listTools 返回 4 个工具', tools.length === 4, `got ${tools.length}`)
const names = tools.map((t) => t.name).sort()
check(
  '工具名为 kebab-case 且符合切分',
  JSON.stringify(names) ===
    JSON.stringify(['fuse-config', 'fuse-create-index', 'fuse-search-with-index', 'fuzzy-search']),
  names.join(',')
)

/* 2) fuzzy-search: string list, query "apple" */
const fruits = ['Apple', 'Pineapple', 'Banana', 'Grapes', 'Apricot', 'Apple Pie', 'applesauce', 'Avocado']
const r1 = await client.callTool({
  name: 'fuzzy-search',
  arguments: { documents: fruits, query: 'apple', limit: 5 }
})
console.log('fuzzy-search(documents=fruits, query="apple"):')
console.log(textOf(r1))
console.log('---')
const j1 = JSON.parse(textOf(r1))
check('fuzzy-search 返回结果', Array.isArray(j1.results) && j1.results.length > 0, 'empty results')
check('fuzzy-search 排序：Apple 命中且 score=0', j1.results[0] && j1.results[0].item === 'Apple' && j1.results[0].score === 0, JSON.stringify(j1.results && j1.results[0]))
check(
  'fuzzy-search 含子串命中 Pineapple 且 refIndex 正确',
  j1.results.some((r) => r.item === 'Pineapple' && r.refIndex === 1),
  'Pineapple missing'
)
check('fuzzy-search 默认开启 includeScore', j1.results.every((r) => typeof r.score === 'number'), 'no scores')

/* 3) fuzzy-search: object list with keys */
const books = [
  { title: 'The Old Man and the Sea', author: 'Ernest Hemingway' },
  { title: 'Moby Dick', author: 'Herman Melville' },
  { title: 'The Sea-Wolf', author: 'Jack London' },
  { title: 'War and Peace', author: 'Leo Tolstoy' }
]
const r2 = await client.callTool({
  name: 'fuzzy-search',
  arguments: { documents: books, query: 'sea', keys: ['title'], limit: 3, includeMatches: true }
})
console.log('fuzzy-search(objects, keys=["title"], query="sea", includeMatches=true):')
console.log(textOf(r2))
console.log('---')
const j2 = JSON.parse(textOf(r2))
const seaHits = j2.results.filter((r) => r.item.title.toLowerCase().includes('sea'))
check(
  '对象搜索：标题含 sea 的书优先命中（排前且分数更低）',
  j2.results.length >= 2 && seaHits.length >= 2 && j2.results[0].item.title.includes('Sea'),
  j2.results.map((r) => `${r.item.title}@${r.score}`).join(' | ')
)
check(
  '对象搜索：结果按 score 升序排序',
  j2.results.every((r, i, a) => i === 0 || a[i - 1].score <= r.score),
  'unsorted'
)
check('includeMatches 返回匹配区间', j2.results[0] && Array.isArray(j2.results[0].matches) && j2.results[0].matches.length > 0, 'no matches')

/* 4) fuzzy-search: extended search, prefix "^app" */
const r3 = await client.callTool({
  name: 'fuzzy-search',
  arguments: { documents: fruits, query: '^app', useExtendedSearch: true, limit: 10 }
})
console.log('fuzzy-search(useExtendedSearch, query="^app"):')
console.log(textOf(r3))
console.log('---')
const j3 = JSON.parse(textOf(r3))
check(
  '扩展搜索 ^app 只命中以 app 开头的项',
  j3.results.length === 3 && j3.results.every((r) => r.item.toLowerCase().startsWith('app')),
  j3.results.map((r) => r.item).join(',')
)

/* 5) fuse-create-index + fuse-search-with-index round trip */
const r4 = await client.callTool({
  name: 'fuse-create-index',
  arguments: { documents: fruits, keys: [] }
})
console.log('fuse-create-index(fruits):')
console.log(textOf(r4).slice(0, 400))
console.log('---')
const j4 = JSON.parse(textOf(r4))
check('create-index 产出 {keys, records}', j4.index && Array.isArray(j4.index.records) && j4.index.records.length === fruits.length, 'bad index')
check('create-index docCount 正确', j4.docCount === fruits.length, `${j4.docCount}`)

const r5 = await client.callTool({
  name: 'fuse-search-with-index',
  arguments: { index: j4.index, documents: fruits, query: 'apple', limit: 5 }
})
console.log('fuse-search-with-index(fruits, query="apple"):')
console.log(textOf(r5))
console.log('---')
const j5 = JSON.parse(textOf(r5))
check('with-index 结果非空', Array.isArray(j5.results) && j5.results.length > 0, 'empty')
check(
  'with-index 与直接搜索结果一致',
  j5.results[0] && j5.results[0].item === 'Apple' && j5.results.length === j1.results.length,
  `first=${j5.results[0] && j5.results[0].item} n=${j5.results.length} vs ${j1.results.length}`
)

/* 6) fuse-config */
const r6 = await client.callTool({ name: 'fuse-config', arguments: {} })
console.log('fuse-config:')
console.log(textOf(r6))
console.log('---')
const j6 = JSON.parse(textOf(r6))
check(
  'fuse-config 返回默认配置',
  j6.config && j6.config.threshold === 0.6 && j6.config.distance === 100 && j6.config.includeMatches === false,
  JSON.stringify(j6.config)
)

/* 7) validation: missing required params */
console.log('validation: fuzzy-search with NO arguments ...')
try {
  const bad = await client.callTool({ name: 'fuzzy-search', arguments: {} })
  const text = textOf(bad)
  const isErr = bad.isError === true || /(invalid|required|错误|must|至少)/i.test(text)
  check('缺参调用被拒绝', isErr, `isError=${bad.isError} text=${text.slice(0, 120)}`)
} catch (e) {
  check('缺参调用被拒绝（抛错）', true, `threw: ${e.message}`)
  console.log(`  validation error: code=${e.code} message=${e.message}`)
}

/* 8) validation: wrong documents type */
console.log('validation: documents 传字符串而非数组 ...')
try {
  const bad = await client.callTool({
    name: 'fuzzy-search',
    arguments: { documents: 'not-an-array', query: 'x' }
  })
  const text = textOf(bad)
  const isErr = bad.isError === true || /(invalid|expected|必须|错误)/i.test(text)
  check('类型错误被拒绝', isErr, `isError=${bad.isError} text=${text.slice(0, 120)}`)
} catch (e) {
  check('类型错误被拒绝（抛错）', true, `threw: ${e.message}`)
  console.log(`  validation error: code=${e.code} message=${e.message}`)
}

await client.close()
console.log('---')
console.log(failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures} failures)`)
process.exit(failures === 0 ? 0 : 1)
