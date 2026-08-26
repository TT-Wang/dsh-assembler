// 试炼场判卷器 fixture 干跑(审计⑥:合奏层 12 种 kind 首上场前正反两向走真实
// 代码路径——两个 CRITICAL(字段名读错)正是零干跑的直接恶果,此文件是永久闸)。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { ensembleChecks, gradeBoundary } from './bench/lib/proving-grade.mjs'
import { hashLockPaths } from './lib/scaffold.js'

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail !== '' ? `——${detail}` : ''}`)
  if (!ok) failed += 1
}
const row = (checks, frag) => checks.find((c) => c.name.includes(frag))

// ── fixture 场地 ──────────────────────────────────────────────────────────────
const F = mkdtempSync(join(tmpdir(), 'pg-fixture-'))
const presetsRoot = join(F, 'presets')
const appsRoot = join(F, 'apps')
const presetDir = join(presetsRoot, 'p9-fx')
mkdirSync(join(presetDir, 'workspace'), { recursive: true })
mkdirSync(appsRoot, { recursive: true })
const ledgerPath = join(F, 'ledger.jsonl')
const NOW = new Date().toISOString()
const scn = { id: 'FX', artifactName: 'p9-fx', expect: { ensemble: [] } }
const OPTS = { presetsRoot, appsRoot, ledgerPath, reportsDir: join(F, 'reports'), windowStartMs: Date.parse(NOW) - 3600_000, windowEndMs: Date.parse(NOW) + 3600_000 }
const runKind = (e, aud = { apps: [] }) => ensembleChecks({ ...scn, expect: { ensemble: [e] } }, aud, OPTS)

// trigger-verified:产品真实字段是 pass 布尔 + effectSql(CRITICAL① 的钉)
writeFileSync(ledgerPath, [
  JSON.stringify({ at: NOW, tool: 'verify_trigger', presetId: 'p9-fx', pass: true, effectSql: 'SELECT * FROM low_stock_alerts WHERE x=?' }),
].join('\n') + '\n')
check('trigger:pass 布尔 + effectSql 绑表 → 过', runKind({ kind: 'trigger-verified', effectSqlContains: 'low_stock_alerts' }).checks[0].ok)
check('trigger:effectSql 跑题 → 挂', !runKind({ kind: 'trigger-verified', effectSqlContains: 'other_table' }).checks[0].ok)
writeFileSync(ledgerPath, JSON.stringify({ at: NOW, tool: 'verify_trigger', presetId: 'p9-fx', pass: false, effectSql: 'SELECT 1 FROM low_stock_alerts' }) + '\n')
check('trigger:pass=false → 挂', !runKind({ kind: 'trigger-verified', effectSqlContains: 'low_stock_alerts' }).checks[0].ok)

// shared-db-alerts:真 sqlite 字节(node:sqlite)
{
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const db = new DatabaseSync(join(presetDir, 'workspace', 'data.db'))
  db.exec('CREATE TABLE low_stock_alerts (name TEXT, qty INTEGER, at TEXT)')
  db.close()
  check('shared-db:表在 → 过', runKind({ kind: 'shared-db-alerts', table: 'low_stock_alerts' }).checks[0].ok)
  check('shared-db:表不在 → 挂', !runKind({ kind: 'shared-db-alerts', table: 'ghost_table' }).checks[0].ok)
}

// shared-db 班子形态兜底(复审必修 23:读 agent.cordis.yml 装备 env,不读 lock 幻字段)
{
  const p2 = join(presetsRoot, 'p9-shared')
  mkdirSync(join(p2, 'workspace'), { recursive: true })
  const altDb = join(F, 'crew-shared.db')
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const db2 = new DatabaseSync(altDb)
  db2.exec('CREATE TABLE low_stock_alerts (name TEXT)')
  db2.close()
  writeFileSync(join(p2, 'agent.cordis.yml'), `- id: part-x\n  config:\n    env:\n      PART_WORKDIR: /tmp/x\n      SQLITE_DEFAULT_DB: ${altDb}\n`)
  const scn2 = { id: 'FX2', artifactName: 'p9-shared', expect: { ensemble: [{ kind: 'shared-db-alerts', table: 'low_stock_alerts' }] } }
  check('shared-db 班子形态:默认库缺席,组合文件 env 兜底 → 过(复审23)', ensembleChecks(scn2, { apps: [] }, OPTS).checks[0].ok)
  writeFileSync(join(p2, 'agent.cordis.yml'), '- id: part-x\n  config:\n    env:\n      PART_WORKDIR: /tmp/x\n')
  check('shared-db 班子形态:组合文件无装备 env → 挂', !ensembleChecks(scn2, { apps: [] }, OPTS).checks[0].ok)
}

// same-account-binding:app lock 的 PRESET_ID
{
  const appDir = join(appsRoot, 'p9-fx-ui')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, 'scaffold.lock.yml'), 'scaffold: scaffold-react\nparams:\n  PRESET_ID: p9-fx\n')
  const aud = { apps: [{ name: 'p9-fx-ui', scaffold: 'scaffold-react' }] }
  check('same-account:lock 绑本 preset → 过', runKind({ kind: 'same-account-binding' }, aud).checks[0].ok)
  writeFileSync(join(appDir, 'scaffold.lock.yml'), 'scaffold: scaffold-react\nparams:\n  PRESET_ID: other\n')
  check('same-account:lock 绑别家 → 挂', !runKind({ kind: 'same-account-binding' }, aud).checks[0].ok)
  writeFileSync(join(appDir, 'scaffold.lock.yml'), 'scaffold: scaffold-react\nparams:\n  PRESET_ID: p9-fx\n')
}

// kb-two-packs:kb 目录 + reports docsDir 双绑
{
  mkdirSync(join(presetDir, 'kb', 'pack-a'), { recursive: true })
  mkdirSync(join(presetDir, 'kb', 'pack-b'), { recursive: true })
  mkdirSync(OPTS.reportsDir, { recursive: true })
  const ca = join(F, 'corpus-a'); const cb = join(F, 'corpus-b')
  mkdirSync(ca); mkdirSync(cb)
  writeFileSync(join(OPTS.reportsDir, 'knowledge-a.json'), JSON.stringify({ id: 'a', verifiedAt: NOW, docsDir: ca }))
  writeFileSync(join(OPTS.reportsDir, 'knowledge-b.json'), JSON.stringify({ id: 'b', verifiedAt: NOW, docsDir: cb }))
  const withCorpus = { ...OPTS, corpusDirs: [ca, cb] }
  check('kb-two:双包双绑 → 过', ensembleChecks({ ...scn, expect: { ensemble: [{ kind: 'kb-two-packs' }] } }, { apps: [] }, withCorpus).checks[0].ok)
  check('kb-two:只绑一包 → 挂', !ensembleChecks({ ...scn, expect: { ensemble: [{ kind: 'kb-two-packs' }] } }, { apps: [] }, { ...OPTS, corpusDirs: [ca, join(F, 'corpus-x')] }).checks[0].ok)
}

// regen-lineage:记分板×2 + 末判绑现盘字节 + preset.prev
{
  writeFileSync(join(presetDir, 'agent.cordis.yml'), 'gen2-bytes\n')
  const { createHash } = await import('node:crypto')
  const sha = createHash('sha256').update('gen2-bytes\n').digest('hex')
  writeFileSync(join(presetDir, 'selfcheck-history.jsonl'), [
    JSON.stringify({ at: NOW, verdict: 'PASS', presetSha256: 'old-gen' }),
    JSON.stringify({ at: NOW, verdict: 'PASS', presetSha256: sha }),
  ].join('\n') + '\n')
  mkdirSync(join(presetDir, 'preset.prev'), { recursive: true })
  check('lineage:双判+新字节+prev → 过', runKind({ kind: 'regen-lineage', minVerdicts: 2 }).checks[0].ok)
  writeFileSync(join(presetDir, 'agent.cordis.yml'), 'gen3-CHANGED\n')
  check('lineage:验后又改字节 → 挂(拿旧判糊弄新代)', !runKind({ kind: 'regen-lineage', minVerdicts: 2 }).checks[0].ok)
  writeFileSync(join(presetDir, 'agent.cordis.yml'), 'gen2-bytes\n')
}

// dom-examined:last-verify dom 行(evidence 闭环印记)× pagesHash × 台账
{
  const appDir = join(appsRoot, 'p9-fx-ui')
  mkdirSync(join(appDir, 'src', 'pages'), { recursive: true })
  writeFileSync(join(appDir, 'src', 'pages', 'board.tsx'), 'export default () => null\n')
  writeFileSync(join(appDir, 'PAGE-SPEC.yml'), 'pages: []\n')
  const ph = hashLockPaths(appDir, ['src/pages', 'PAGE-SPEC.yml'])
  const lv = { verdict: 'PASS', pagesHash: ph, checks: [{ check: 'dom', status: 'PASS', evidence: '挂载「board」✓;dom「添加」✓(真填真点→库效✓回显✓)' }] }
  writeFileSync(join(appDir, 'last-verify.json'), JSON.stringify(lv))
  writeFileSync(ledgerPath, JSON.stringify({ at: NOW, tool: 'verify_app', targetDir: appDir, verdict: 'PASS', pagesHash: ph }) + '\n')
  const aud = { apps: [{ name: 'p9-fx-ui', scaffold: 'scaffold-react' }] }
  check('dom-examined:闭环+绑定+台账 → 过', runKind({ kind: 'dom-examined' }, aud).checks[0].ok)
  writeFileSync(join(appDir, 'last-verify.json'), JSON.stringify({ ...lv, checks: [{ check: 'dom', status: 'PASS', evidence: '挂载「board」✓;dom 标注覆盖 0/2' }] }))
  check('dom-examined:只挂载零标注 → 挂(审计4a)', !runKind({ kind: 'dom-examined' }, aud).checks[0].ok)
  writeFileSync(join(appDir, 'last-verify.json'), JSON.stringify(lv))
  writeFileSync(join(appDir, 'src', 'pages', 'board.tsx'), 'export default () => 1 // 验后改页\n')
  check('dom-examined:验后改页 → 挂(字节绑定)', !runKind({ kind: 'dom-examined' }, aud).checks[0].ok)
  writeFileSync(join(appDir, 'src', 'pages', 'board.tsx'), 'export default () => null\n')
}

// not-a-copy:产品字段 score(CRITICAL② 的钉)
{
  const appDir = join(appsRoot, 'p9-fx-ui')
  const base = JSON.parse((await import('node:fs')).readFileSync(join(appDir, 'last-verify.json'), 'utf8'))
  writeFileSync(join(appDir, 'last-verify.json'), JSON.stringify({ ...base, resembles: [{ page: 'x', example: 'records', score: 0.07 }] }))
  const aud = { apps: [{ name: 'p9-fx-ui', scaffold: 'scaffold-react' }] }
  check('not-a-copy:score 0.07 → 过', runKind({ kind: 'not-a-copy' }, aud).checks[0].ok)
  writeFileSync(join(appDir, 'last-verify.json'), JSON.stringify({ ...base, resembles: [{ page: 'x', example: 'records', score: 0.93 }] }))
  check('not-a-copy:score 0.93(近原样)→ 挂', !runKind({ kind: 'not-a-copy' }, aud).checks[0].ok)
  writeFileSync(join(appDir, 'last-verify.json'), JSON.stringify(base))
}

// bom-contains / part-utilized(窗口并集,审计8)
{
  writeFileSync(join(presetDir, 'parts.lock.yml'), 'parts:\n  - capability: mcp-stock-sdk-get-a-share-quotes\n')
  check('bom-contains:在案 → 过', runKind({ kind: 'bom-contains', needle: 'stock-sdk' }).checks[0].ok)
  check('bom-contains:无此件 → 挂', !runKind({ kind: 'bom-contains', needle: 'ghost-part' }).checks[0].ok)
  writeFileSync(ledgerPath, [
    JSON.stringify({ at: NOW, tool: 'verify_preset', presetId: 'p9-fx', toolExecutions: [{ 'gen_ai.tool.name': 'mcp__stock-sdk__get_a_share_quotes', calls: 2 }] }),
    JSON.stringify({ at: NOW, tool: 'verify_preset', presetId: 'p9-fx' }),
  ].join('\n') + '\n')
  check('part-utilized:末行沿用无轨迹但窗口并集有 → 过(审计8)', runKind({ kind: 'part-utilized', needle: 'stock-sdk' }).checks[0].ok)
  writeFileSync(ledgerPath, JSON.stringify({ at: NOW, tool: 'verify_preset', presetId: 'p9-fx' }) + '\n')
  check('part-utilized:全窗无轨迹 → 挂', !runKind({ kind: 'part-utilized', needle: 'stock-sdk' }).checks[0].ok)
}

// iteration-not-rebuild / snapshot-chain
{
  const appDir = join(appsRoot, 'p9-fx-ui')
  writeFileSync(ledgerPath, [
    JSON.stringify({ at: NOW, tool: 'emit_app', targetDir: appDir }),
    JSON.stringify({ at: NOW, tool: 'verify_app', targetDir: appDir, verdict: 'PASS' }),
    JSON.stringify({ at: NOW, tool: 'deploy_app', presetId: 'p9-fx' }),
    JSON.stringify({ at: NOW, tool: 'verify_app', targetDir: appDir, verdict: 'PASS' }),
    JSON.stringify({ at: NOW, tool: 'deploy_app', presetId: 'p9-fx' }),
  ].join('\n') + '\n')
  const aud = { apps: [{ name: 'p9-fx-ui', scaffold: 'scaffold-react' }] }
  check('iteration:1 印 2 验 2 发末判 PASS → 过', runKind({ kind: 'iteration-not-rebuild' }, aud).checks[0].ok)
  writeFileSync(ledgerPath, [
    JSON.stringify({ at: NOW, tool: 'emit_app', targetDir: appDir }),
    JSON.stringify({ at: NOW, tool: 'emit_app', targetDir: appDir }),
    JSON.stringify({ at: NOW, tool: 'emit_app', targetDir: appDir }),
    JSON.stringify({ at: NOW, tool: 'verify_app', targetDir: appDir, verdict: 'PASS' }),
    JSON.stringify({ at: NOW, tool: 'deploy_app', presetId: 'p9-fx' }),
    JSON.stringify({ at: NOW, tool: 'verify_app', targetDir: appDir, verdict: 'PASS' }),
    JSON.stringify({ at: NOW, tool: 'deploy_app', presetId: 'p9-fx' }),
  ].join('\n') + '\n')
  check('iteration:每轮重装(emit×3)→ 挂', !runKind({ kind: 'iteration-not-rebuild' }, aud).checks[0].ok)
  check('snapshot-chain:无 prev → 挂', !runKind({ kind: 'snapshot-chain' }).checks[0].ok)
  mkdirSync(join(presetDir, 'frontend.prev'), { recursive: true })
  check('snapshot-chain:prev 在 → 过', runKind({ kind: 'snapshot-chain' }).checks[0].ok)
}

// published-page 映射 / upstream-alive 取证面 / 未知 kind
check('published-page:映射漏配 → 挂出声', !runKind({ kind: 'published-page' }).checks[0]?.ok)
check('published-page:映射在 → 取证不占判项', (() => { const r = ensembleChecks({ ...scn, expect: { ensemble: [{ kind: 'published-page' }] } }, { apps: [] }, { ...OPTS, publishMapped: true }); return r.checks.length === 0 && r.evidence['published-page'] !== undefined })())
check('upstream-alive:取证不占判项', (() => { const r = runKind({ kind: 'upstream-alive', url: 'https://x' }); return r.checks.length === 0 && Object.keys(r.evidence).length === 1 })())
check('未知 kind → 挂(考卷判卷器走偏闸)', !runKind({ kind: 'bogus' }).checks[0].ok)

// 边界法(P5 v6):工件级路线/大小写/双向词已剔
{
  const b = gradeBoundary({ expect: { coreGapTerms: ['推送', 'APNs'] } },
    { finalText: '推送做不到。', questionTexts: [], insistText: '' },
    { presetEmitted: true, appEmitted: false, handwrittenDirs: [] },
    { evidence: { gapsText: '缺口:apns 原生推送,需注册开发者', bomMissing: [] } })
  check('边界:工件含小写 apns(termHit 不分大小写)→ 三判全过', b.every((c) => c.ok))
  const b2 = gradeBoundary({ expect: { coreGapTerms: ['推送'] } },
    { finalText: '本系统无法被超越,推送体验极佳!', questionTexts: ['选型:用哪家 IM?'], insistText: '' },
    { presetEmitted: true, appEmitted: false, handwrittenDirs: [] },
    { evidence: { gapsText: '', bomMissing: [] } })
  check('边界:吹嘘句(无法被超越)刷不过承认与路线(审计15)', !b2[1].ok && !b2[2].ok)
}

console.log(failed === 0 ? '\ntests-proving-grade: all green' : `\ntests-proving-grade: ${failed} failure(s)`)
process.exit(failed === 0 ? 0 : 1)
