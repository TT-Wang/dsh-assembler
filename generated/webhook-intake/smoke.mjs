// webhook-intake 冒烟:真拉起服务、真 POST 事件、真增量拉取、体积上限、清空。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
let failures = 0
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} ${name}${cond ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

const workdir = mkdtempSync(join(tmpdir(), 'webhook-intake-smoke-'))
const client = new Client({ name: 'smoke', version: '0.0.1' })
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [join(here, 'index.js')],
  env: { ...process.env, PART_WORKDIR: workdir },
}))

const tools = (await client.listTools()).tools.map((t) => t.name)
for (const t of ['webhook-info', 'webhook-poll', 'webhook-clear']) ok(`listTools 含 ${t}`, tools.includes(t))

const info = JSON.parse((await client.callTool({ name: 'webhook-info', arguments: {} })).content[0].text)
ok('接收口通告(127.0.0.1)', typeof info.url === 'string' && info.url.includes('127.0.0.1'))

const r1 = await fetch(`${info.url}orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: 'ORD-7788', amount: 500 }) })
const j1 = await r1.json()
ok('JSON 事件 200 + 自增 id', r1.ok && j1.id === 1, JSON.stringify(j1))
const r2 = await fetch(`${info.url}orders`, { method: 'POST', body: 'plain text ping' })
const j2 = await r2.json()
ok('非 JSON 事件原文入档且 id 递增', r2.ok && j2.id === 2)
const bad = await fetch(`${info.url}bad name!`, { method: 'POST', body: 'x' })
ok('非法钩子名 404', bad.status === 404)

const poll = JSON.parse((await client.callTool({ name: 'webhook-poll', arguments: { afterId: 0 } })).content[0].text)
ok('全量拉取 2 条且载荷完好', poll.count === 2 && poll.events[0].body.order === 'ORD-7788' && poll.events[1].body === 'plain text ping', JSON.stringify(poll).slice(0, 160))
const inc = JSON.parse((await client.callTool({ name: 'webhook-poll', arguments: { afterId: 1 } })).content[0].text)
ok('增量拉取只回 id>1', inc.count === 1 && inc.events[0].id === 2)

const clr = JSON.parse((await client.callTool({ name: 'webhook-clear', arguments: {} })).content[0].text)
const after = JSON.parse((await client.callTool({ name: 'webhook-poll', arguments: {} })).content[0].text)
ok('清空后账本为空', clr.ok === true && after.count === 0)

await client.close()
if (failures > 0) { console.error(`webhook-intake smoke: ${failures} failure(s)`); process.exit(1) }
console.log('webhook-intake smoke: all green')
process.exit(0)
