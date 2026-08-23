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
ok('listTools 含 ai-complete 且仅 1 个', tools.length === 1 && tools[0] === 'ai-complete')

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

await client.close()
if (failures > 0) { console.error(`ai-call smoke: ${failures} failure(s)`); process.exit(1) }
console.log('ai-call smoke: all green')
process.exit(0)
