// ai-call 冒烟:真调一次 DeepSeek(回显 token 断言真结果)。密钥从进程 env 或
// ~/.dsh/.env 读(smoke 自己解析,值绝不打印);无密钥 = 门如实红(未验证的
// AI 零件不出厂)。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
let failures = 0
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} ${name}${cond ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

let key = process.env.DEEPSEEK_API_KEY || ''
if (key === '') {
  const envFile = join(homedir(), '.dsh', '.env')
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/^DEEPSEEK_API_KEY=(.+)$/m)
    if (m) key = m[1].trim().replace(/^["']|["']$/g, '')
  }
}
if (key === '') {
  console.error('ai-call smoke: 环境与 ~/.dsh/.env 均无 DEEPSEEK_API_KEY——无法真调,门红(不发未验证的 AI 零件)')
  process.exit(1)
}

const client = new Client({ name: 'smoke', version: '0.0.1' })
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [join(here, 'index.js')],
  env: { ...process.env, DEEPSEEK_API_KEY: key },
}))

const tools = (await client.listTools()).tools.map((t) => t.name)
ok('listTools = ai-complete + ai-face-info(工具面 + 服务脸发现)', tools.length === 2 && tools.includes('ai-complete') && tools.includes('ai-face-info'))

const res = await client.callTool({ name: 'ai-complete', arguments: {
  system: '你只做回显:把用户给的口令原样输出,不加任何别的字。',
  prompt: '口令:SMOKE-7741',
  maxTokens: 300,
} })
const j = JSON.parse(res.content[0].text)
ok('真调回显命中口令', typeof j.text === 'string' && j.text.includes('SMOKE-7741'), JSON.stringify(j).slice(0, 160))
ok('用量账目在(prompt/completion)', j.usage && Number.isFinite(j.usage.completion))

// 无密钥行为:子进程剥掉 key,应回结构化错误而非崩
const bare = new Client({ name: 'smoke2', version: '0.0.1' })
const env2 = { ...process.env }
delete env2.DEEPSEEK_API_KEY
await bare.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, 'index.js')], env: env2 }))
const noKey = await bare.callTool({ name: 'ai-complete', arguments: { prompt: 'hi' } })
ok('无密钥 = 结构化报错(不崩、不泄值)', noKey.isError === true && noKey.content[0].text.includes('DEEPSEEK_API_KEY'))
await bare.close()

// ── 服务脸(ai-thin 路由的物理基础)────────────────────────────────────────
{
  const info = JSON.parse((await client.callTool({ name: 'ai-face-info', arguments: {} })).content[0].text)
  ok('服务脸:ai-face-info 给 url+token', typeof info.url === 'string' && info.url.startsWith('http://127.0.0.1:') && typeof info.token === 'string' && info.token.length === 32)
  const bad = await fetch(`${info.url}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  ok('服务脸:错/缺 token 401', bad.status === 401)
  const H = { 'content-type': 'application/json', 'x-service-token': info.token }
  const empty = await (await fetch(`${info.url}/complete`, { method: 'POST', headers: H, body: '{}' })).json()
  ok('服务脸:空 prompt 给可行动错误', typeof empty.error === 'string' && empty.error.includes('prompt'))
  if (process.env.DEEPSEEK_API_KEY) {
    const TOK = 'AIFACE-' + Math.random().toString(36).slice(2, 6).toUpperCase()
    const r = await (await fetch(`${info.url}/complete`, { method: 'POST', headers: H, body: JSON.stringify({ prompt: `原样重复这串口令,只输出它本身:${TOK}`, maxTokens: 256 }) })).json()
    ok('服务脸:真补全回显口令(与工具面同一段实现)', typeof r.text === 'string' && r.text.includes(TOK), String(r.text ?? r.error).slice(0, 80))
  } else {
    console.log('SKIP | 服务脸真调用(无 DEEPSEEK_API_KEY)')
  }
}

await client.close()
if (failures > 0) { console.error(`ai-call smoke: ${failures} failure(s)`); process.exit(1) }
console.log('ai-call smoke: all green')
process.exit(0)
