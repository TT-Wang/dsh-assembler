// express-track 冒烟:凭证契约脸为主(无凭证环境全绿),真调腿有凭证才跑。
// 纪律:契约脸三断言(起得来/listTools 全/无凭证报错可行动)+ 签名离线向量;
// 真凭证腿(KDNIAO_* 配齐时)打一发单号识别,断言签名被上游接受(wire 形态实证)。
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail !== '' && !ok ? `——${detail}` : ''}`)
  if (!ok) failed += 1
}

// 1) 签名离线向量(与 python hashlib 独立算出的定值比对——算法钉死,不许漂)
const { kdniaoSign } = await import(join(DIR, 'index.js'))
check('签名向量(md5hex→base64)', kdniaoSign('{"LogisticCode":"SF123"}', 'testkey-vector') === 'MzM4MmIzZjg0YmQ4YTNhYzkzMjAyOTE1MTMyZGJhMDI=')

// 2) 凭证契约脸:剥掉凭证起服,listTools 必须全,调用必须回可行动错误
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
// 契约腿必须真的无凭证:env 剥掉之外,把凭证库查找也指向空目录(不然用户配好
// 凭证后本腿会假红——readSecret 从 ~/.dsh/.env 兜底捞到值)。
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
const emptyHome = mkdtempSync(join(tmpdir(), 'et-smoke-'))
const bareEnv = { ...process.env, HOME: emptyHome, DSH_HOME: emptyHome }
delete bareEnv.KDNIAO_EBUSINESS_ID
delete bareEnv.KDNIAO_API_KEY
const c = new Client({ name: 'express-track-smoke', version: '0.0.1' })
await c.connect(new StdioClientTransport({ command: 'node', args: [join(DIR, 'index.js')], env: bareEnv }))
const tools = (await c.listTools()).tools.map((t) => t.name).sort()
check('无凭证也起得来且工具面全', tools.join(',') === 'detect-carrier,query-express', tools.join(','))
let errText = ''
try {
  const r = await c.callTool({ name: 'query-express', arguments: { carrier: 'YTO', trackingNo: 'YT0000000000001' } })
  errText = (r.content ?? []).map((b) => b.text ?? '').join('')
  check('无凭证调用回错误而非假数据', r.isError === true, errText.slice(0, 120))
} catch (error) {
  errText = String(error.message ?? error)
  check('无凭证调用回错误而非假数据', true)
}
check('错误点名两个 env', errText.includes('KDNIAO_EBUSINESS_ID') && errText.includes('KDNIAO_API_KEY'), errText.slice(0, 160))
check('错误给注册路径', errText.includes('kdniao.com'), errText.slice(0, 160))
check('SF 缺手机尾号被前置拦截', await (async () => {
  const r = await c.callTool({ name: 'query-express', arguments: { carrier: 'SF', trackingNo: 'SF000' } })
  const t = (r.content ?? []).map((b) => b.text ?? '').join('')
  return r.isError === true && t.includes('后四位')
})())
await c.close()

// 3) 真凭证腿(等用户注册快递鸟后扣扳机;无凭证如实 SKIPPED,绝不假绿)。
// 开关与零件 readSecret 同一套查找:env 或凭证库($DSH_HOME/.env → ~/.dsh/.env)
// 任一有值即算配好——不然"配进凭证库而非 env"的正确姿势反而触发不了真调。
const vaultHas = (name) => {
  if ((process.env[name] ?? '') !== '') return true
  const files = [
    process.env.DSH_HOME ? join(process.env.DSH_HOME, '.env') : null,
    process.env.HOME ? join(process.env.HOME, '.dsh', '.env') : null,
  ].filter(Boolean)
  for (const f of files) {
    try {
      if (existsSync(f) && new RegExp(`^\\s*${name}\\s*=\\s*.+$`, 'm').test(readFileSync(f, 'utf8'))) return true
    } catch { /* 无凭证库 */ }
  }
  return false
}
const haveCreds = vaultHas('KDNIAO_EBUSINESS_ID') && vaultHas('KDNIAO_API_KEY')
if (haveCreds) {
  const c2 = new Client({ name: 'express-track-smoke-live', version: '0.0.1' })
  await c2.connect(new StdioClientTransport({ command: 'node', args: [join(DIR, 'index.js')], env: process.env }))
  const r = await c2.callTool({ name: 'detect-carrier', arguments: { trackingNo: 'SF1234567890123' } })
  const t = (r.content ?? []).map((b) => b.text ?? '').join('')
  // 断言的是 wire 形态被上游接受(有结构化回答);识别成败都算过——签名错会是网关级报错
  check('真调:签名被上游接受(结构化回应)', t.includes('候选承运商') || t.includes('识别未成功'), t.slice(0, 160))
  await c2.close()
} else {
  console.log('- SKIPPED 真调腿:未配 KDNIAO_EBUSINESS_ID/KDNIAO_API_KEY(注册快递鸟后重跑本 smoke 补上实弹)')
}

process.exit(failed === 0 ? 0 : 1)
