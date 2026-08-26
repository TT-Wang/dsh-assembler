#!/usr/bin/env node
// 离线重判:复核照盘上工件重算 + **硬化判据并列入档**(2026-08-26 对抗审计后重构)。
//
// 纪律:字面判定(预注册考卷的机器分)**永不改写**——它是当轮的历史事实;硬化判
// 定(hardenChecks:考官亲笔判定/lock 识伪/发布回指/字节严判)只紧不松,作为并列
// 判定写进每题的 `hardened` 字段与 summary-hardened.json。两套判定不一致的题,
// 差异本身就是审计结论的实证。
//
// 病史仍然有效:①初版复核靠目录名猜实例(已改按绑定认领);②陈旧闸——工件被
// 后续清场删了就大声跳过,绝不照空盘重算覆盖原始结果。
// 用法:node bench/regrade-generalization.mjs [port] [resultsDirName]
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { audit, grade, hardenChecks } from './lib/generalization-grade.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.argv[2] ?? 3097)
const SPEC = JSON.parse(readFileSync(join(REPO, 'bench', 'scenarios', 'generalization-9.json'), 'utf8'))
const DIR = join(REPO, 'bench', 'results', process.argv[3] ?? '2026-08-26-generalization-v4')

// 证据窗口:从 summary.json 的 ranAt(驱动器落盘、重判从不改写)+ Σ墙钟推导——
// 病史(本文件第一次跑就踩):首版用结果文件 mtime 定窗,而重判自己会覆写这些
// 文件,第二次重判窗口即漂移到"现在",全部工件出窗、A 档被冤判"考官从未真判"。
// 幂等的窗只能锚在重判不碰的数据上。
const files = SPEC.scenarios.map((s) => join(DIR, `${s.id}.json`)).filter((f) => existsSync(f))
if (files.length === 0) { console.error('结果目录为空,无可重判'); process.exit(1) }
const summaryPath = join(DIR, 'summary.json')
if (!existsSync(summaryPath)) { console.error('缺 summary.json——无法锚定证据窗口'); process.exit(1) }
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
const totalElapsed = (summary.results ?? []).reduce((n, r) => n + (r.elapsedSeconds ?? 0), 0)
const windowEndMs = Date.parse(summary.ranAt) + 120_000
const windowStartMs = Date.parse(summary.ranAt) - totalElapsed * 1000 - 600_000

const rows = []
for (const scn of SPEC.scenarios) {
  const f = join(DIR, `${scn.id}.json`)
  if (!existsSync(f)) continue
  const prev = JSON.parse(readFileSync(f, 'utf8'))
  const run = { tools: prev.tools ?? [], finalText: prev.finalText ?? '', questionTexts: prev.questionTexts ?? [] }
  const aud = await audit(scn, PORT)
  const hadArtifacts = prev.audit?.presetEmitted === true || prev.audit?.appEmitted === true
  const hasArtifacts = aud.presetEmitted === true || aud.appEmitted === true
  if (hadArtifacts && !hasArtifacts) {
    console.log(`  ${scn.id} [${scn.tier}] 跳过重判:原判有工件、盘上已无(多半被后续清场删了)——原结果保留不动`)
    continue
  }
  const g = grade(scn, run, aud)
  // 证据降级检测(审计发现 13):归档 finalText 截 1200 字——现场判卷吃的是全文,
  // 复算吃的是截断档案,证据严格劣于现场。降级证据上的复算差异**不构成翻案**,
  // 字面判定永远以现场记录(prev.verdict)为准;复算只做一致性标注。
  const degraded = (prev.finalText ?? '').length >= 1200
  const reproduced = g.verdict === prev.verdict
  const hard = hardenChecks(scn, aud, { windowStartMs, windowEndMs })
  // 硬化终判 = 现场字面 ∧ 硬化判项(只紧不松);C 档无硬化判项时随现场字面。
  const finalHard = hard.checks.length === 0 ? prev.verdict : (prev.verdict === 'PASS' && hard.verdict === 'PASS' ? 'PASS' : 'FAIL')
  const flipped = finalHard !== prev.verdict
  console.log(`${flipped ? '⟳' : ' '} ${scn.id} [${scn.tier}] 字面 ${prev.verdict}${reproduced ? '' : degraded ? '(复算差异:证据已截断,不构成翻案)' : '(!复算 ' + g.verdict + ',待查)'} → 硬化 ${finalHard}  lane=${g.lane}`)
  for (const c of hard.checks) if (!c.ok) console.log(`     ✗ ${c.name}:${c.detail}`)
  const row = {
    ...prev,
    audit: aud,
    hardened: {
      at: new Date().toISOString(), checks: hard.checks, evidence: hard.evidence, verdict: finalHard,
      ...(reproduced ? {} : { recompute: g.verdict, recomputeDegraded: degraded }),
    },
  }
  writeFileSync(f, JSON.stringify(row, null, 2))
  rows.push(row)
}

const byTier = rows.reduce((m, r) => { (m[r.tier] ??= []).push(r); return m }, {})
console.log('\n═══ 字面 vs 硬化 ═══')
for (const [tier, list] of Object.entries(byTier)) {
  const lit = list.filter((r) => r.verdict === 'PASS').length
  const hardN = list.filter((r) => r.hardened.verdict === 'PASS').length
  console.log(`${tier} 档:字面 ${lit}/${list.length} → 硬化 ${hardN}/${list.length} — ${list.map((r) => `${r.id}:${r.verdict}→${r.hardened.verdict}`).join(' ')}`)
}
console.log(`总计 字面 ${rows.filter((r) => r.verdict === 'PASS').length}/${rows.length} → 硬化 ${rows.filter((r) => r.hardened.verdict === 'PASS').length}/${rows.length}`)
writeFileSync(join(DIR, 'summary-hardened.json'), JSON.stringify({ hardenedAt: new Date().toISOString(), windowStartMs, windowEndMs, rows }, null, 2))
console.log(`落盘:${join(DIR, 'summary-hardened.json').replace(REPO + '/', '')}`)
