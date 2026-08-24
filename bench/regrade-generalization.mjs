#!/usr/bin/env node
// 离线重判:用修好的复核(全盘扫描认领实例)重算已跑完的题——原始轨迹与工件都在
// 盘上,不必重跑。病史:初版复核靠目录名猜实例,把 A3"走了配方"误判成 preset-only。
// 用法:node bench/regrade-generalization.mjs [port]
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { audit, grade } from './lib/generalization-grade.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.argv[2] ?? 3097)
const SPEC = JSON.parse(readFileSync(join(REPO, 'bench', 'scenarios', 'generalization-9.json'), 'utf8'))
const DIR = join(REPO, 'bench', 'results', '2026-08-25-generalization')

const rows = []
for (const scn of SPEC.scenarios) {
  const f = join(DIR, `${scn.id}.json`)
  if (!existsSync(f)) continue
  const prev = JSON.parse(readFileSync(f, 'utf8'))
  const run = { tools: prev.tools ?? [], finalText: prev.finalText ?? '', questionTexts: prev.questionTexts ?? [] }
  const aud = await audit(scn, PORT)
  const g = grade(scn, run, aud)
  const changed = g.verdict !== prev.verdict || g.lane !== prev.lane
  console.log(`${changed ? '⟳' : ' '} ${scn.id} [${scn.tier}] ${g.verdict} ${g.passed}/${g.total}  lane=${g.lane}${changed ? `  (原判 ${prev.verdict} lane=${prev.lane})` : ''}`)
  for (const c of g.checks) if (!c.ok) console.log(`     ✗ ${c.name}:${c.detail}`)
  const row = { ...prev, ...g, audit: aud, regradedAt: new Date().toISOString(), previous: { verdict: prev.verdict, lane: prev.lane, passed: prev.passed } }
  writeFileSync(f, JSON.stringify(row, null, 2))
  rows.push(row)
}

const byTier = rows.reduce((m, r) => { (m[r.tier] ??= []).push(r); return m }, {})
console.log('\n═══ 重判后三档汇总 ═══')
for (const [tier, list] of Object.entries(byTier)) {
  console.log(`${tier} 档:${list.filter((r) => r.verdict === 'PASS').length}/${list.length} PASS — ${list.map((r) => `${r.id}:${r.verdict}(${r.lane})`).join(' ')}`)
}
console.log(`\n总计 ${rows.filter((r) => r.verdict === 'PASS').length}/${rows.length}`)
writeFileSync(join(DIR, 'summary-regraded.json'), JSON.stringify({ regradedAt: new Date().toISOString(), rows }, null, 2))
