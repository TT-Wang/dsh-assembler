#!/usr/bin/env node
/**
 * 命名功能单测：直接 import 编译产物 lib/index.js（peers 已 symlink 到 node_modules）。
 * 验证 sanitizePresetName / presetNameSuffix / resolvePresetId / emitPreset 的命名行为。
 */
import { sanitizePresetName, presetNameSuffix, resolvePresetId, emitPreset } from './lib/index.js'
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
console.log(`\n==== 命名功能测试: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`)
process.exit(failures === 0 ? 0 : 1)
