#!/usr/bin/env node
/**
 * 目录清单生成器 —— 把 index/catalog.yml 渲染成 README 里的能力清单。
 *
 * 为什么生成而不手写:目录每周都在长,手写的清单第二天就过期,而过期的
 * 清单比没有清单更坏(它让人以为自己知道有什么)。这里的每个数字与每条
 * 出处都直接来自 catalog.yml,README 里那段只是它的投影。
 *
 * 领域分组是唯一的人工输入(哪个零件属于哪个领域是语义判断),放在
 * DOMAINS 里;新零件若未归类会落进"其他"并在 stderr 提醒。
 *
 * 用法:
 *   node scripts/catalog-report.mjs            # 中文片段到 stdout
 *   node scripts/catalog-report.mjs --lang en  # 英文片段
 *   node scripts/catalog-report.mjs --check    # 只报未归类零件,给 CI 用
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const lang = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : 'zh'
const checkOnly = args.includes('--check')

const catalog = yaml.load(readFileSync(join(REPO, 'index', 'catalog.yml'), 'utf8'))
const caps = yaml.load(readFileSync(join(REPO, 'capabilities.yml'), 'utf8'))
const servers = caps['mcp-servers'] ?? {}

/** Domain grouping — the one human input here (which part serves which domain). */
const DOMAINS = [
  { zh: '文档办公', en: 'Documents & office', ids: ['pdf-generate', 'pdf-extract', 'pdf-report', 'docx-generate', 'docx-extract', 'pptx-generate', 'excel-read-write', 'zip-archive', 'mobi-parser'] },
  { zh: '数据格式', en: 'Data formats', ids: ['csv-parse', 'yaml-convert', 'toml-parse', 'xml-parse', 'json-query', 'json-schema-validate', 'html-parse', 'html-to-text', 'gpx-parse'] },
  { zh: '文本处理', en: 'Text processing', ids: ['markdown-render', 'html-to-markdown', 'readability-extract', 'text-diff', 'template-render', 'fuzzy-search', 'text-encoding'] },
  { zh: '中文专项', en: 'Chinese language', ids: ['pinyin-convert', 'chinese-convert', 'word-segment', 'num-to-chinese'] },
  { zh: '计算', en: 'Computation', ids: ['math-eval', 'currency-calc', 'number-format', 'semver-check', 'geo-distance', 'color-convert'] },
  { zh: '时间日历', en: 'Time & calendars', ids: ['date-format', 'cron-parse', 'calendar-parse', 'calendar-generate', 'rrule-expand'] },
  { zh: '数据库', en: 'Databases', ids: ['sqlite-query', 'mysql-query', 'postgres-query'] },
  { zh: '网络通信', en: 'Network & messaging', ids: ['http-request', 'email-send', 'email-fetch', 'rss-parse'] },
  { zh: '媒体识别', en: 'Media & recognition', ids: ['image-process', 'ocr-parse', 'qrcode-generate', 'barcode-generate', 'exif-read', 'file-type-detect'] },
  { zh: '安全校验', en: 'Security & validation', ids: ['jwt-decode', 'ip-utils', 'string-validate', 'fake-data', 'phone-parse'] },
  { zh: '工程工具', en: 'Engineering tools', ids: ['github-api', 'browser-automate', 'url-slugify', 'transliterate', 'safe-filename'] },
  { zh: '应用与交付', en: 'Apps & delivery', ids: ['webhook-intake', 'static-deploy', 'app-scaffold'] },
]

const byId = new Map(catalog.map((x) => [x.id, x]))
const service = catalog.filter((x) => x.kind === 'service')
const firstParty = catalog.filter((x) => x.repo === 'first-party')
const recipes = catalog.filter((x) => x.kind === 'recipe')
const library = catalog.filter((x) => x.kind !== 'service' && x.kind !== 'recipe' && x.repo !== 'first-party')
const toolCount = (x) => (x.tools ?? []).length
const total = catalog.reduce((n, x) => n + toolCount(x), 0)

const grouped = new Set(DOMAINS.flatMap((d) => d.ids))
const ungrouped = library.filter((x) => !grouped.has(x.id)).map((x) => x.id)
const stale = [...grouped].filter((id) => !byId.has(id))
if (ungrouped.length > 0) console.error(`[catalog-report] 未归类零件(会落进"其他"):${ungrouped.join(', ')}`)
if (stale.length > 0) console.error(`[catalog-report] DOMAINS 里有目录中已不存在的 id:${stale.join(', ')}`)
if (checkOnly) process.exit(ungrouped.length === 0 && stale.length === 0 ? 0 : 1)

const secretsOf = (id) => {
  const list = servers[id]?.requiredSecrets
  if (!Array.isArray(list) || list.length === 0) return lang === 'en' ? 'none' : '免'
  return list.map((s) => `\`${s.env}\`${s.optional === true ? (lang === 'en' ? ' (optional)' : '(可选)') : ''}`).join(' ')
}

const L = lang === 'en'
  ? {
    head: `**${catalog.length} parts / ${total} tools** — ${library.length} library-backed, ${service.length} service-backed, ${firstParty.length} first-party.`,
    svc: '### Service-backed parts — live data and external systems',
    svcHead: '| Part | Tools | Source | Licence / terms | Credentials |',
    fp: '### First-party parts — thin shells over Node built-ins, zero third-party deps',
    lib: '### Library-backed parts, by domain',
    libHead: '| Domain | Parts (tool count) |',
    full: 'Full tool-level inventory',
    lic: '### Licences',
    licCode: '**Wrapped code** (library + first-party parts): ',
    licData: '**Data licence / terms** (service-backed parts): ',
    licNote: 'All permissive — no copyleft exposure in code. Service parts additionally record the **data** licence, which is a different obligation: Nominatim is ODbL and Wikipedia is CC-BY-SA (attribution / share-alike duties), so both are recorded per entry and travel into each assembly\'s BOM.',
    other: 'Other',
    machine: 'Machine-readable inventory with every `repo@rev`, licence, terms, rate limit and tool description: [`index/catalog.yml`](index/catalog.yml).',
  }
  : {
    head: `**${catalog.length} 个零件 / ${total} 个工具** —— ${library.length} 库型、${service.length} 服务型、${firstParty.length} 第一方。`,
    svc: '### 服务型零件 —— 实时数据与外部系统',
    svcHead: '| 零件 | 工具 | 数据源 | 许可/条款 | 凭证 |',
    fp: '### 第一方零件 —— Node 内置薄壳,零第三方依赖',
    lib: '### 库型零件(按领域)',
    libHead: '| 领域 | 零件(工具数) |',
    full: '完整工具级清单',
    lic: '### 许可证',
    licCode: '**所包装代码**(库型 + 第一方零件):',
    licData: '**数据许可 / 服务条款**(服务型零件):',
    licNote: '全部宽松许可,代码侧零 copyleft 风险。服务型零件另记**数据许可**——那是另一种义务:Nominatim 是 ODbL、Wikipedia 是 CC-BY-SA(署名/共享要求),因此逐条记录并随装配进入 BOM。',
    other: '其他',
    machine: '完整机器可读清单(含每个零件的 `repo@rev`、许可、条款、速率限制与工具描述):[`index/catalog.yml`](index/catalog.yml)。',
  }

const lines = [L.head, '']

lines.push(L.svc, '', L.svcHead, '|---|---|---|---|---|')
for (const x of service) {
  const tools = (x.tools ?? []).map((t) => `\`${t.name}\``).join(' ')
  lines.push(`| **${x.id}** | ${tools} | ${x.provider ?? x.service ?? ''} | ${x.license ?? ''} | ${secretsOf(x.id)} |`)
}
lines.push('')

lines.push(L.fp, '')
lines.push(firstParty.map((x) => `\`${x.id}\`(${(x.tools ?? []).map((t) => t.name).join(', ')})`).join(' · '))
lines.push('')

lines.push(L.lib, '', L.libHead, '|---|---|')
for (const d of DOMAINS) {
  const items = d.ids.filter((id) => byId.has(id)).map((id) => `\`${id}\`(${toolCount(byId.get(id))})`)
  if (items.length > 0) lines.push(`| **${lang === 'en' ? d.en : d.zh}** | ${items.join(' · ')} |`)
}
if (ungrouped.length > 0) {
  lines.push(`| **${L.other}** | ${ungrouped.map((id) => `\`${id}\`(${toolCount(byId.get(id))})`).join(' · ')} |`)
}
lines.push('')

// Full inventory folded away: complete, without burying the page.
lines.push('<details>', `<summary><b>${L.full}</b></summary>`, '')
for (const x of catalog) {
  const origin = x.kind === 'service' ? x.service : `${x.repo}@${x.rev}`
  lines.push(`- **${x.id}** — ${(x.tools ?? []).map((t) => `\`${t.name}\``).join(', ')}`)
  lines.push(`  <br/><sub>${origin} · ${x.license ?? ''}</sub>`)
}
lines.push('', '</details>', '')

// Code licences and service terms are different things and must not be
// tallied in one list: an OSS licence governs the wrapped code, a service's
// terms govern the DATA it returns.
const codeLic = new Map()
const dataLic = new Map()
for (const x of catalog) {
  const key = x.license ?? '?'
  const bucket = x.kind === 'service' ? dataLic : codeLic
  bucket.set(key, (bucket.get(key) ?? 0) + 1)
}
const fmt = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')
lines.push(L.lic, '')
lines.push(`${L.licCode}${fmt(codeLic)}`)
lines.push('')
lines.push(`${L.licData}${fmt(dataLic)}`)
lines.push('', L.licNote, '', L.machine)

process.stdout.write(lines.join('\n') + '\n')
