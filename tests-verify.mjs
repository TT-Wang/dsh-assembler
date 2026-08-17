/**
 * 装配即验证的纯函数单元测试:evaluateProbe 判定 + writePresetFile 幂等写盘。
 * 跑法:node tests-verify.mjs(先 npm run build)
 */
import { evaluateProbe } from './lib/verify.js'
import { writePresetFile } from './lib/index.js'
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

// 1. evaluateProbe:全部标记命中才 PASS,大小写不敏感,空标记集恒 FAIL
check('全标记命中 PASS', evaluateProbe({ task: '', mustInclude: ['42', 'CNY'] }, '结果是 42 cny'))
check('缺一个标记 FAIL', !evaluateProbe({ task: '', mustInclude: ['42', 'usd'] }, '结果是 42 cny'))
check('大小写不敏感', evaluateProbe({ task: '', mustInclude: ['Hello'] }, 'say HELLO world'))
check('空标记集恒 FAIL(拒绝空验收)', !evaluateProbe({ task: '', mustInclude: [] }, '任何回复'))
check('标记可以是中文', evaluateProbe({ task: '', mustInclude: ['汇率'] }, '今日汇率为 7.1'))
check('部分匹配算命中(子串语义)', evaluateProbe({ task: '', mustInclude: ['723'] }, 'total=7234'))

// 2. writePresetFile:字节相同跳写(mtime 不变 ⇒ host 不换代),字节不同才写
const dir = mkdtempSync(join(tmpdir(), 'verify-test-'))
const f = join(dir, 'agent.cordis.yml')
writeFileSync(f, 'v1')
const stamp1 = statSync(f).mtimeMs
await new Promise((r) => setTimeout(r, 20))
writePresetFile(f, 'v1')
check('字节相同跳写(stamp 不变)', statSync(f).mtimeMs === stamp1)
await new Promise((r) => setTimeout(r, 20))
writePresetFile(f, 'v2')
check('字节不同才写', readFileSync(f, 'utf8') === 'v2' && statSync(f).mtimeMs !== stamp1)
writePresetFile(join(dir, 'fresh.yml'), 'new')
check('新文件正常创建', readFileSync(join(dir, 'fresh.yml'), 'utf8') === 'new')
rmSync(dir, { recursive: true, force: true })

// 3. renderPartsLock:出处映射 + serverName 从 preset 字节读回 + host 平面标注
const { renderPartsLock } = await import('./lib/index.js')
const lock = renderPartsLock({
  presetId: 'demo',
  requirement: '  一个   演示需求  ',
  selected: [
    { id: 'mcp-currency-calc-currency-calc', via: 'mcp', tool: 'mcp__currency-calc__currency-calc', description: '', tags: [], config: { server: 'currency-calc' } },
    { id: 'mcp-filesystem-read', via: 'mcp', tool: 'mcp__filesystem__read_text_file', description: '', tags: [], config: { server: 'filesystem' } },
    { id: 'web-lookup', via: 'harness', description: '', tags: [], config: { presetRows: [{ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' }] } },
  ],
  presetText: '- id: mcp-currency-calc\n  config:\n    serverName: "currency-calc-59cbbdba"\n',
  index: [{ id: 'currency-calc', repo: 'scurker/currency.js', rev: 'v2.0.4', license: 'MIT', verified: true }],
})
import yamlmod from 'js-yaml'
const parsed2 = yamlmod.load(lock)
check('BOM preset 头', parsed2.preset === 'demo')
check('BOM 需求归一空白', parsed2.requirement === '一个 演示需求')
const cur = parsed2.parts.find((p) => p.server === 'currency-calc')
check('BOM 供应链出处 repo@rev+license', cur.repo === 'scurker/currency.js' && cur.rev === 'v2.0.4' && cur.license === 'MIT' && cur.verified === true)
check('BOM serverName 从字节读回', cur.serverName === 'currency-calc-59cbbdba')
const fsp = parsed2.parts.find((p) => p.server === 'filesystem')
check('BOM host 平面零件标注 plane', fsp.plane === 'host' && fsp.serverName === undefined)
const web = parsed2.parts.find((p) => p.capability === 'web-lookup')
check('BOM harness 零件 mounts', Array.isArray(web.mounts) && web.mounts[0] === '@deepseek-ai/dsh-tool-web')

console.log(`\n==== verify 单元测试: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`)
process.exit(failures === 0 ? 0 : 1)
