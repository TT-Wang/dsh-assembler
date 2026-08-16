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

console.log(`\n==== verify 单元测试: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`)
process.exit(failures === 0 ? 0 : 1)
