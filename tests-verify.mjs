/**
 * 装配即验证的纯函数单元测试:evaluateProbe 判定 + writePresetFile 幂等写盘。
 * 跑法:node tests-verify.mjs(先 npm run build)
 */
import { evaluateProbe, sendTurn } from './lib/verify.js'
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
// 归一化双通道(reader-b 假红实录:「第2章第2段」被「第 2 章 · 第 2 段」判死,白烧 302s 重试)
check('排版变体命中(空格+间隔号)', evaluateProbe({ task: '', mustInclude: ['第2章第2段'] }, '当前位置:第 2 章 · 第 2 段'))
check('排版变体命中(连字符/下划线)', evaluateProbe({ task: '', mustInclude: ['READ-7781_摘录.md'] }, '文件 READ 7781 摘录.md 已保存'))
check('归一不假阳(内容真不同仍 FAIL)', !evaluateProbe({ task: '', mustInclude: ['第3章第1段'] }, '当前位置:第 2 章 · 第 2 段'))
check('全标点标记不走归一通道(防空串假阳)', !evaluateProbe({ task: '', mustInclude: ['—·—'] }, '任意回复'))
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

// 5. 凭证契约:秘密永不进 preset;声明可读;配置状态如实报告
const { stripSecretEnv, collectRequiredSecrets } = await import('./lib/index.js')
const envIn = { LANG: 'zh_CN', SLACK_BOT_TOKEN: 'xoxb-real-secret', API_KEY: 'k', TIMEOUT_MS: '5000', DB_PASSWORD: 'p' }
const kept = stripSecretEnv(envIn)
check('非秘密 env 保留', kept.LANG === 'zh_CN' && kept.TIMEOUT_MS === '5000')
check('秘密形状的 env 一律剥离', kept.SLACK_BOT_TOKEN === undefined && kept.API_KEY === undefined && kept.DB_PASSWORD === undefined, JSON.stringify(kept))
check('秘密值零字节残留', !JSON.stringify(kept).includes('xoxb-real-secret'))
check('非对象输入安全', Object.keys(stripSecretEnv(undefined)).length === 0 && Object.keys(stripSecretEnv('x')).length === 0)

const SECRET_SERVERS = {
  'slack-messaging': { requiredSecrets: [{ env: 'SLACK_BOT_TOKEN', purpose: 'Bot token' }] },
  'feishu-messaging': { requiredSecrets: [{ env: 'FEISHU_APP_ID' }, { env: 'FEISHU_APP_SECRET' }] },
  'weather-forecast': {},
}
const SECRET_SEL = [
  { id: 'a', via: 'mcp', description: '', tags: [], config: { server: 'slack-messaging' } },
  { id: 'b', via: 'mcp', description: '', tags: [], config: { server: 'feishu-messaging' } },
  { id: 'c', via: 'mcp', description: '', tags: [], config: { server: 'weather-forecast' } },
]
process.env.SLACK_BOT_TOKEN = 'configured-for-test'
const secrets = collectRequiredSecrets(SECRET_SEL, SECRET_SERVERS)
delete process.env.SLACK_BOT_TOKEN
check('收集到三个声明(两个零件)', secrets.length === 3, JSON.stringify(secrets.map((x) => x.env)))
check('已配置的标 configured', secrets.find((x) => x.env === 'SLACK_BOT_TOKEN').configured === true)
check('未配置的标 待配置', secrets.find((x) => x.env === 'FEISHU_APP_SECRET').configured === false)
check('purpose 透传', secrets.find((x) => x.env === 'SLACK_BOT_TOKEN').purpose === 'Bot token')
check('无声明的零件不产生条目', !secrets.some((x) => x.server === 'weather-forecast'))
check('声明里只有名字没有值', !JSON.stringify(secrets).includes('configured-for-test'))

// 可选凭证:未配也不该拦住验证(GitHub 公开读匿名可用)
const OPT_SERVERS = { 'github-issues': { requiredSecrets: [{ env: 'GITHUB_TOKEN_TEST_ONLY', purpose: 'PAT', optional: true }] } }
const optSecrets = collectRequiredSecrets(
  [{ id: 'g', via: 'mcp', description: '', tags: [], config: { server: 'github-issues' } }],
  OPT_SERVERS,
)
check('optional 标记透传', optSecrets[0].optional === true)
check('未配的可选凭证不进"阻塞"集合', optSecrets.filter((x) => !x.configured && x.optional !== true).length === 0)
const REQ_SERVERS = { s: { requiredSecrets: [{ env: 'MUST_HAVE_TEST_ONLY', purpose: 'x' }] } }
const reqSecrets = collectRequiredSecrets([{ id: 'r', via: 'mcp', description: '', tags: [], config: { server: 's' } }], REQ_SERVERS)
check('未配的必需凭证进"阻塞"集合', reqSecrets.filter((x) => !x.configured && x.optional !== true).length === 1)

// 6. 知识包安装:拷贝进 preset(自包含交付)+ 出处随行
const { installKnowledgePacks } = await import('./lib/index.js')
const { mkdtempSync: mkt, mkdirSync: mkd, writeFileSync: wf, readFileSync: rf, existsSync: ex } = await import('node:fs')
const { join: jn } = await import('node:path')
const { tmpdir: td } = await import('node:os')
const kroot = mkt(jn(td(), 'kb-root-'))
mkd(jn(kroot, 'knowledge', 'demo-pack', 'docs'), { recursive: true })
wf(jn(kroot, 'knowledge', 'demo-pack', 'docs', 'policy.md'), '# 政策\n退货 15 日')
wf(jn(kroot, 'knowledge', 'demo-pack', '.knowledge-meta.json'), JSON.stringify({ source: '客户导出', version: '2026-08' }))
const pdir = mkt(jn(td(), 'preset-'))
const instR = installKnowledgePacks(
  [{ id: 'kb-cap', via: 'knowledge', description: '', tags: [], config: { pack: 'demo-pack' } }],
  pdir, kroot,
)
const inst = instR.installed
check('知识包被安装', inst.length === 1 && inst[0].id === 'demo-pack' && inst[0].docs === 1, JSON.stringify(inst))
check('在场的包不报缺书', instR.skipped.length === 0)
check('文档真的拷进 preset 的 kb/', ex(jn(pdir, 'kb', 'demo-pack', 'policy.md')) && rf(jn(pdir, 'kb', 'demo-pack', 'policy.md'), 'utf8').includes('退货 15 日'))
check('出处与版本随行', inst[0].source === '客户导出' && inst[0].version === '2026-08')
const none = installKnowledgePacks([{ id: 'x', via: 'mcp', description: '', tags: [], config: { server: 's' } }], pdir, kroot)
check('非知识条目不触发安装', none.installed.length === 0 && none.skipped.length === 0)
// 过堂刀2③:缺书曾被静默跳过(发射"成功"而 kb/ 空)——现在如实上报,emit 侧拒印。
const missing = installKnowledgePacks([{ id: 'y', via: 'knowledge', description: '', tags: [], config: { pack: 'no-such-pack' } }], pdir, kroot)
check('不存在的包如实上报缺书(不再静默)', missing.installed.length === 0 && missing.skipped.length === 1 && missing.skipped[0].id === 'y' && missing.skipped[0].expectedDir.includes('no-such-pack'))

// N. sendTurn 三义务(bilingual-reader 悬挂取证,2026-08-21):
//    问人即判负 + 工具动作流进直播台 + 正常轮取 assistant/message 文本。
{
  const phases = []
  const s1 = { sessionId: 's-ask', frames: [], rpc: async () => ({}), close: () => {} }
  const p1 = sendTurn(s1, '测试任务', 30_000, (l) => phases.push(l))
  s1.frames.push({ type: 'tool/call', data: { name: 'read_file', arguments: '{}' } })
  await new Promise((r) => setTimeout(r, 1300))
  s1.frames.push({ type: 'tool/call', data: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ question: '能否把 book.txt 粘贴给我?' }] }) } })
  const askOut = await p1
  check('agent 问人 ⇒ 立即判负并带回问题原文', askOut.askedUser === '能否把 book.txt 粘贴给我?', JSON.stringify(askOut))
  check('工具动作实时流进直播台', phases.some((l) => l.includes('read_file')), JSON.stringify(phases))

  const s2 = { sessionId: 's-ok', frames: [], rpc: async () => ({}), close: () => {} }
  const p2 = sendTurn(s2, 'hi', 30_000)
  s2.frames.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答复正文' }] } } })
  s2.frames.push({ type: 'turn/end' })
  const okOut = await p2
  check('正常轮返回 reply', okOut.reply === '答复正文', JSON.stringify(okOut))

  const s3 = { sessionId: 's-to', frames: [], rpc: async () => ({}), close: () => {} }
  const toOut = await sendTurn(s3, 'hi', 1500)
  check('轮预算耗尽返回空对象(超时语义不变)', toOut.reply === undefined && toOut.askedUser === undefined, JSON.stringify(toOut))
}

console.log(`\n==== verify 单元测试: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`)
process.exit(failures === 0 ? 0 : 1)
