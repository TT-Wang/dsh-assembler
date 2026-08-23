// app-scaffold 冒烟:真调官方生成器 → 真 install → 真 build → dist 可伺服。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
let failures = 0
const ok = (n, c, d = '') => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${n}${c ? '' : ` — ${d}`}`); if (!c) failures++ }

const work = mkdtempSync(join(tmpdir(), 'appscaffold-'))
const client = new Client({ name: 'smoke', version: '0.0.1' })
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [join(here, 'index.js')],
  env: { ...process.env, PART_WORKDIR: work },
}))
ok('listTools 含 scaffold-vite', (await client.listTools()).tools.some((t) => t.name === 'scaffold-vite'))

const r = JSON.parse((await client.callTool({ name: 'scaffold-vite', arguments: { dir: 'demo' } })).content[0].text)
ok('骨架落盘(含 package.json/index.html)', r.ok === true && r.files.includes('package.json') && r.files.includes('index.html'), JSON.stringify(r).slice(0, 160))
const dup = await client.callTool({ name: 'scaffold-vite', arguments: { dir: 'demo' } })
ok('已存在目录拒绝', dup.isError === true)
const esc = await client.callTool({ name: 'scaffold-vite', arguments: { dir: '../evil' } })
ok('越界拒绝', esc.isError === true)

const app = join(work, 'demo')
const inst = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: app, encoding: 'utf8', timeout: 120000 })
ok('npm install 通过', inst.status === 0, (inst.stderr || '').slice(-160))
const build = spawnSync('npm', ['run', 'build'], { cwd: app, encoding: 'utf8', timeout: 120000 })
ok('vite build 出 dist/index.html', build.status === 0 && existsSync(join(app, 'dist', 'index.html')), (build.stderr || '').slice(-160))

await client.close()
if (failures > 0) { console.error(`app-scaffold smoke: ${failures} failure(s)`); process.exit(1) }
console.log('app-scaffold smoke: all green'); process.exit(0)
