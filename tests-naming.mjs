#!/usr/bin/env node
/**
 * 命名功能单测：直接 import 编译产物 lib/index.js（peers 已 symlink 到 node_modules）。
 * 验证 sanitizePresetName / presetNameSuffix / resolvePresetId / emitPreset 的命名行为。
 */
import { sanitizePresetName, presetNameSuffix, resolvePresetId, emitPreset, screenParams, applyParams, reconcileCapabilityIds, assertEmittedPreset, assembleResultText } from './lib/index.js'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!cond) failures += 1
}

// 1. sanitizePresetName
check('中文名转 slug', sanitizePresetName('网页研究助手') === '')
check('英文小写化', sanitizePresetName('Web Research Assistant') === 'web-research-assistant')
check('下划线/空格/点归一', sanitizePresetName('Web_Research.Assistant') === 'web-research-assistant')
check('首尾连字符去除', sanitizePresetName('--web--') === 'web')
check('超长截断', sanitizePresetName('a'.repeat(60)) === 'a'.repeat(48), sanitizePresetName('a'.repeat(60)).length)
check('纯符号为空', sanitizePresetName('---') === '')
check('中文混合保留可读段', sanitizePresetName('网页研究 web research 助手') === 'web-research')

// 2. presetNameSuffix：稳定、8 位 hex、同名 id 同 suffix、相似名不同 suffix
const s1 = presetNameSuffix('web-research')
const s2 = presetNameSuffix('web-research')
const s3 = presetNameSuffix('deep-research')
check('suffix 8 位 hex', /^[0-9a-f]{8}$/.test(s1), s1)
check('同名 id suffix 稳定', s1 === s2)
check('相似名 suffix 不同', s1 !== s3)

// 3. resolvePresetId：无冲突用原名、冲突加 -2/-3
const root = mkdtempSync(join(tmpdir(), 'preset-name-test-'))
const first = resolvePresetId('web-research', undefined, root)
check('显式名优先', first === 'web-research', first)
mkdirSync(join(root, 'web-research'), { recursive: true })
const second = resolvePresetId('web-research', undefined, root)
check('冲突加 -2', second === 'web-research-2', second)
mkdirSync(join(root, 'web-research-2'), { recursive: true })
check('冲突加 -3', resolvePresetId('web-research', undefined, root) === 'web-research-3')
const fallback = resolvePresetId('---', '', root)
check('非法名回落 assembled- 代号', /^assembled-[a-z0-9]+$/.test(fallback), fallback)
check('建议名兜底', resolvePresetId(undefined, 'Customer Support Bot', root) === 'customer-support-bot')

// 4. emitPreset：serverName 带 hash suffix、输出可被 yaml 解析、persona 渲染
const catalog = {
  capabilities: [
    { id: 'web-lookup', via: 'harness', description: 'search', tags: ['web'], config: { presetRows: [{ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true } }] } },
    { id: 'mcp-http-request-http-get', via: 'mcp', tool: 'mcp__http-request__http-get', description: 'fetch', tags: ['http'], config: { server: 'http-request' } },
  ],
  'mcp-servers': {
    'http-request': { transport: 'stdio', command: 'node', args: ['/tmp/http.js'] },
  },
}
const req = { capabilityIds: ['mcp-http-request-http-get'], missing: [], rationale: '', persona: '网页研究助手 persona' }
const template = '{{extraRows}}'
const out = emitPreset(req, catalog, template, 'web-research')
check('serverName 含 8 位 hex suffix', /serverName: "http-request-[0-9a-f]{8}"/.test(out), out)
const parsed = yaml.load(out)
check('输出是合法 YAML 顶层列表', Array.isArray(parsed), JSON.stringify(parsed))
const mcpRow = parsed.find((r) => r && r.name === '@deepseek-ai/dsh-mcp-client')
check('mcp row config.serverName 带 suffix', /^http-request-[0-9a-f]{8}$/.test(mcpRow?.config?.serverName ?? ''), mcpRow?.config?.serverName)
check('serverName ≤ 32 字符', mcpRow.config.serverName.length <= 32)

// 5. 代际不变式:同输入字节级确定;字节变(哪怕只有 persona)⇒ serverName 变。
// host 对同 id preset 的被取代 generation 永不释放 serverName,所以重发文件
// 只要字节不同就必须换名,否则新 generation 挂载必撞旧 generation。
const outAgain = emitPreset(req, catalog, template, 'web-research')
check('同输入重发字节级相同', outAgain === out)
// persona 要真的进入渲染文本,字节才会变;真实模板含 {{persona}}。
const personaTemplate = '# persona: {{persona}}\n{{extraRows}}'
const nameOf = (text) => yaml.load(text.split('\n').slice(1).join('\n')).find((r) => r && r.name === '@deepseek-ai/dsh-mcp-client').config.serverName
const outV1 = emitPreset(req, catalog, personaTemplate, 'web-research')
const outV2 = emitPreset({ ...req, persona: '网页研究助手 persona v2' }, catalog, personaTemplate, 'web-research')
check('字节变则 serverName 变', nameOf(outV2) !== nameOf(outV1), `${nameOf(outV1)} vs ${nameOf(outV2)}`)

rmSync(root, { recursive: true, force: true })
// 6. 参数化:秘密键机械拒绝(宪法红线 4)+ 槽位替换 + 参数进代际哈希
const scr = screenParams({ timezone: 'Asia/Shanghai', apiKey: 'sk-xxx', DB_PASSWORD: 'p', 'bad key!': 'v', longv: 'x'.repeat(201), auth_token: 't' })
check('非秘密键通过', scr.accepted.timezone === 'Asia/Shanghai' && Object.keys(scr.accepted).length === 1, JSON.stringify(scr.accepted))
const rejectedKeys = scr.rejected.map((r) => r.key)
check('apiKey 被拒', rejectedKeys.includes('apiKey'))
check('DB_PASSWORD 被拒', rejectedKeys.includes('DB_PASSWORD'))
check('auth_token 被拒', rejectedKeys.includes('auth_token'))
check('非法键名被拒', rejectedKeys.includes('bad key!'))
check('超长值被拒', rejectedKeys.includes('longv'))
check('槽位替换', applyParams('tz={{param:timezone}}|x', { timezone: 'UTC' }) === 'tz=UTC|x')
check('未提供的槽位置空(不留字面量)', applyParams('tz={{param:missing}}!', {}) === 'tz=!')
const pTpl = '# tz: {{param:timezone}}\n{{extraRows}}'
const outP1 = emitPreset({ ...req, params: { timezone: 'UTC' } }, catalog, pTpl, 'web-research')
const outP2 = emitPreset({ ...req, params: { timezone: 'Asia/Shanghai' } }, catalog, pTpl, 'web-research')
check('参数进入渲染文本', outP1.includes('tz: UTC') && outP2.includes('tz: Asia/Shanghai'))
const nameOfP = (t) => yaml.load(t.split('\n').slice(1).join('\n')).find((r) => r && r.name === '@deepseek-ai/dsh-mcp-client').config.serverName
check('参数变则 serverName 换代(字节决定名字)', nameOfP(outP1) !== nameOfP(outP2), `${nameOfP(outP1)} vs ${nameOfP(outP2)}`)

// 6b. @@WORKSPACE@@ 槽位:filesystem 类零件的根钉到该 preset 自己的 workspace/。
// bilingual-reader 取证(2026-08-21):host 全局挂载死了目录还在售卖文件工具,
// 现改随 preset 发射;槽位没人填时必须炸在装配台,不许发根目录是字面量的哑零件。
const wsCatalog = {
  capabilities: [
    { id: 'mcp-filesystem-read-text-file', via: 'mcp', tool: 'mcp__filesystem__read_text_file', description: 'read file', tags: ['file'], config: { server: 'filesystem' } },
  ],
  'mcp-servers': {
    filesystem: { transport: 'stdio', command: 'node', args: ['/tmp/fs.js', '@@WORKSPACE@@'] },
  },
}
const wsReq = { capabilityIds: ['mcp-filesystem-read-text-file'], missing: [], rationale: '', persona: 'p' }
const wsOut = emitPreset(wsReq, wsCatalog, template, 'reader', '', undefined, '/abs/presets/reader/workspace')
check('@@WORKSPACE@@ 替换为该 preset 工作区', wsOut.includes('/abs/presets/reader/workspace') && !wsOut.includes('@@WORKSPACE@@'), wsOut)
const wsRow = yaml.load(wsOut).find((r) => r && r.name === '@deepseek-ai/dsh-mcp-client')
check('workspace 行仍带代际 serverName', /^filesystem-[0-9a-f]{8}$/.test(wsRow?.config?.serverName ?? ''), wsRow?.config?.serverName)
let wsThrew = ''
try { emitPreset(wsReq, wsCatalog, template, 'reader') } catch (e) { wsThrew = String(e?.message ?? e) }
check('缺工作区路径必炸(拒发哑零件)', wsThrew.includes('@@WORKSPACE@@'), wsThrew)

// 7. 能力 id 调和:机械前缀漏写可修,语义错的丢弃,全错才失败。
// 实测来源:选型 LLM 答 semver-check-compare(真实 id 带 mcp- 前缀),整次装配硬失败。
const CAT = ['mcp-semver-check-compare', 'mcp-semver-check-satisfies', 'web-lookup']
check('精确命中原样保留', reconcileCapabilityIds(['web-lookup'], CAT)[0] === 'web-lookup')
check('漏 mcp- 前缀可修', reconcileCapabilityIds(['semver-check-compare'], CAT)[0] === 'mcp-semver-check-compare')
check('大小写/分隔符归一', reconcileCapabilityIds(['MCP_Semver_Check_Satisfies'], CAT)[0] === 'mcp-semver-check-satisfies')
const mixed = reconcileCapabilityIds(['semver-check-compare', 'totally-made-up', 'web-lookup'], CAT)
check('未知 id 丢弃而非拖垮整次装配', mixed.length === 2 && mixed.includes('mcp-semver-check-compare') && mixed.includes('web-lookup'), JSON.stringify(mixed))
check('结果去重', reconcileCapabilityIds(['web-lookup', 'web-lookup'], CAT).length === 1)
let threw = false
try { reconcileCapabilityIds(['nope-1', 'nope-2'], CAT) } catch { threw = true }
check('全部不匹配才硬失败', threw)
check('空选择不报错', reconcileCapabilityIds([], CAT).length === 0)

// 8. 发射闸:preset 渲染坏了(YAML 特殊字符)必须在写盘前抛错,绝不静默交付
// 装不上的文件。persona 走 JSON 编码是安全的,但能力行的 name/id 是裸插值——一个
// 带引号的行名就能把单引号标量拆坏,而坏文件只在 host 挂载时才炸(客户面前),
// 装配却早已报了成功。发射闸把这类失败从"挂载期静默"提前到"装配期高声"。
const hostileCatalog = {
  capabilities: [
    { id: 'bad-row', via: 'harness', description: 'x', tags: ['x'], config: { presetRows: [{ id: 'tool-x', name: "it's @a/b" }] } },
  ],
  'mcp-servers': {},
}
let gateThrew = false
let gateMsg = ''
try {
  emitPreset({ capabilityIds: ['bad-row'], missing: [], rationale: '', persona: 'p' }, hostileCatalog, '{{extraRows}}', 'hostile')
} catch (e) {
  gateMsg = String(e?.message ?? e)
  gateThrew = /合法 YAML|行序列/.test(gateMsg)
}
check('能力行名含引号 → 发射闸抛错(不写坏文件)', gateThrew, gateMsg.slice(0, 80))
// 直接对着坏文本调闸:未解析成非空行序列必抛。
let emptyThrew = false
try { assertEmittedPreset('') } catch { emptyThrew = true }
check('空文本(未渲染出任何行)被闸拒绝', emptyThrew)
// happy path 字节中立:合法 preset 原样返回,与未加闸时同字节。
const gated = emitPreset(req, catalog, template, 'web-research')
check('合法 preset 照常通过闸且字节不变', Array.isArray(yaml.load(gated)) && gated === out, `same=${gated === out}`)

// 9. 耗时账单:结果文本必须逐段列出时间去向,"为什么跑这么久"由产品自己回答。
// 无一段认领的时间(会话握手、BOM 写盘)以"其他"入账而不是消失;不足 2s 的
// 零头不单列(账单是给人看的,不是审计日志)。
const billBase = {
  id: 'x', capabilityIds: ['a'], missing: [], presetPath: '/tmp/x', drafts: [],
  verification: { status: 'SKIPPED', reason: 'verify disabled' },
  personaLint: [], params: {}, paramsRejected: [], requiredSecrets: [], knowledge: [],
}
const billText = assembleResultText({
  ...billBase,
  timings: [
    { stage: '零件联邦', seconds: 0 },
    { stage: '选型', seconds: 12 },
    { stage: '发射', seconds: 0 },
    { stage: '验收探针(2轮)', seconds: 130 },
  ],
  totalSeconds: 150,
})
check('账单含总耗时', billText.includes('耗时:共 150s'))
check('账单逐段列出', billText.includes('选型 12s') && billText.includes('验收探针(2轮) 130s'))
check('0s 段照列(缓存热是信息)', billText.includes('零件联邦 0s'))
check('未认领时间入"其他"', billText.includes('其他 8s'), billText.match(/耗时[^\n]*/)?.[0])
const billTight = assembleResultText({ ...billBase, timings: [{ stage: '选型', seconds: 10 }], totalSeconds: 11 })
check('零头 <2s 不单列"其他"', !billTight.includes('其他'), billTight.match(/耗时[^\n]*/)?.[0])

console.log(`\n==== 命名功能测试: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`)
process.exit(failures === 0 ? 0 : 1)
