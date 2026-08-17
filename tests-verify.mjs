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

// 3b. 场景判定:全轮通过才算过;轮数不符/空场景一律不过
const { marksPresent, evaluateScenario } = await import('./lib/verify.js')
check('marksPresent 全中才真', marksPresent(['a', 'B'], 'x A y b z'))
check('marksPresent 缺一即假', !marksPresent(['a', 'zz'], 'only a here'))
check('marksPresent 空标记恒假', !marksPresent([], '任何回复'))
const T = (i, pass) => ({ index: i, prompt: 'p', mustInclude: ['m'], pass, reply: 'r' })
check('场景全过才 PASS', evaluateScenario([T(1, true), T(2, true), T(3, true)], 3))
check('任一轮挂即 FAIL', !evaluateScenario([T(1, true), T(2, false), T(3, true)], 3))
check('轮数不足即 FAIL(中途中断)', !evaluateScenario([T(1, true)], 3))
check('空场景恒 FAIL', !evaluateScenario([], 0))

// 4. persona lint:约束不编舞、工具面对齐、长度界
const { lintPersona, resolvePersonaText } = await import('./lib/index.js')
const SEL = [
  { id: 'mcp-currency-calc-currency-calc', via: 'mcp', tool: 'mcp__currency-calc__currency-calc', description: '', tags: [], config: { server: 'currency-calc' } },
]
const okText = '你是货币换算助手。只用你的货币工具 mcp__currency-calc__currency-calc 处理换算;绝不编造汇率;用用户的语言回答,金额始终带币种符号。'
check('干净 persona 零发现', lintPersona(okText, SEL).length === 0, JSON.stringify(lintPersona(okText, SEL)))
check('步骤句式被抓(第 N 步)', lintPersona(okText + ' 第一步解析金额,第二步换算。', SEL).some((f) => f.kind === 'procedure-steps'))
check('步骤句式被抓(Step N)', lintPersona(okText + ' Step 1: parse.', SEL).some((f) => f.kind === 'procedure-steps'))
check('首先然后最后三连被抓', lintPersona(okText + ' 首先解析,然后换算,最后输出。', SEL).some((f) => f.kind === 'procedure-steps'))
check('单独"首先"不误报', !lintPersona(okText + ' 首先要保持礼貌。', SEL).some((f) => f.kind === 'procedure-steps'))
check('未挂载工具引用被抓', lintPersona(okText + ' 用 mcp__qrcode-generate__qr-generate-png 生成二维码。', SEL).some((f) => f.kind === 'unknown-tool'))
check('host 平面工具豁免', !lintPersona(okText + ' 用 mcp__filesystem__read_text_file 读文件。', SEL, ['filesystem']).some((f) => f.kind === 'unknown-tool'))
check('过短被抓', lintPersona('你是助手。', SEL).some((f) => f.kind === 'too-short'))
check('过长被抓', lintPersona('约束'.repeat(1300), SEL).some((f) => f.kind === 'too-long'))
check('解析链:目录 persona 优先', resolvePersonaText('generated text', [{ id: 'p', via: 'harness', description: '', tags: [], config: { persona: 'catalog text' } }]) === 'catalog text')
check('解析链:生成兜底', resolvePersonaText('generated text', SEL) === 'generated text')
check('解析链:默认殿后', resolvePersonaText(undefined, SEL).includes('helpful assistant'))

console.log(`\n==== verify 单元测试: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`)
process.exit(failures === 0 ? 0 : 1)
