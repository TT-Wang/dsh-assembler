// static-deploy 冒烟:真部署(tmp DSH_HOME 里的假 preset)、穿越拒绝、缺 index 拒绝。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
let failures = 0
const ok = (n, c, d = '') => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${n}${c ? '' : ` — ${d}`}`); if (!c) failures++ }

const work = mkdtempSync(join(tmpdir(), 'sdep-work-'))
const home = mkdtempSync(join(tmpdir(), 'sdep-home-'))
mkdirSync(join(work, 'dist'), { recursive: true })
writeFileSync(join(work, 'dist', 'index.html'), '<h1>DEPLOY-OK-7741</h1>')
writeFileSync(join(work, 'dist', 'app.js'), 'console.log(1)')
mkdirSync(join(home, '.agent-presets', 'demo-app'), { recursive: true })
writeFileSync(join(home, '.agent-presets', 'demo-app', 'agent.cordis.yml'), '- id: persona\n')

const client = new Client({ name: 'smoke', version: '0.0.1' })
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [join(here, 'index.js')],
  env: { ...process.env, PART_WORKDIR: work, DSH_HOME: home },
}))
const tools = (await client.listTools()).tools.map((t) => t.name)
ok('listTools 含 deploy-static', tools.includes('deploy-static'))

const r = JSON.parse((await client.callTool({ name: 'deploy-static', arguments: { srcDir: 'dist', presetId: 'demo-app' } })).content[0].text)
ok('部署成功回 url', r.ok === true && r.url === '/assembler/ui/demo-app', JSON.stringify(r))
ok('文件真落到 preset/frontend', existsSync(join(home, '.agent-presets', 'demo-app', 'frontend', 'app.js'))
  && readFileSync(join(home, '.agent-presets', 'demo-app', 'frontend', 'index.html'), 'utf8').includes('DEPLOY-OK-7741'))

const esc = await client.callTool({ name: 'deploy-static', arguments: { srcDir: '../outside', presetId: 'demo-app' } })
ok('穿越拒绝', esc.isError === true)
const noIdx = await client.callTool({ name: 'deploy-static', arguments: { srcDir: '.', presetId: 'demo-app' } })
ok('缺 index.html 拒绝', noIdx.isError === true && noIdx.content[0].text.includes('index.html'))
const noPreset = await client.callTool({ name: 'deploy-static', arguments: { srcDir: 'dist', presetId: 'ghost' } })
ok('目标 preset 不存在拒绝', noPreset.isError === true)

await client.close()
if (failures > 0) { console.error(`static-deploy smoke: ${failures} failure(s)`); process.exit(1) }
console.log('static-deploy smoke: all green'); process.exit(0)
