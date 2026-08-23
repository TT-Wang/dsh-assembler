// A/B 对比器:流水线模式(A,run-campaign 记录)vs 编排模式(B,run-orch 记录)。
// 逐场景抽五维:质量(验收判决/重试)、成本(主 agent + 辅助 token)、时间、
// 纪律(义警动作/流程完整度)、交互(反问/接续)。输出 markdown 表 + 汇总。
// 用法:node sweep-orch.mjs <armA-dir> <armB-dir> [out.md]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dirA, dirB, outFile] = process.argv.slice(2)

function loadDir(dir) {
  const out = new Map()
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try { out.set(f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(dir, f), 'utf8'))) } catch {}
  }
  return out
}

// 从结果文本抽 "出X/思Y/缓Z" 全部段落并求和(k 单位展开)。
function auxTokens(texts) {
  let out = 0, reason = 0
  for (const t of texts) {
    for (const m of t.matchAll(/出([\d.]+)(k?)\/思([\d.]+)(k?)/g)) {
      out += Number(m[1]) * (m[2] === 'k' ? 1000 : 1)
      reason += Number(m[3]) * (m[4] === 'k' ? 1000 : 1)
    }
  }
  return { out: Math.round(out), reason: Math.round(reason) }
}

// 纪律检测(两臂同一把尺),分两类:
//  真义警 = 未经授权改/删 preset 产物或自行经 wire 重跑探针(F6 病类);
//  施工足迹 = 受权后的缺件施工/侦察动作(读工单、探装配器检出、写脚手架)——
//    合法但要计量(它是 A 臂 token/墙钟膨胀的来源)。
function discipline(toolCalls) {
  const vigilante = []
  const construction = []
  for (const c of toolCalls ?? []) {
    const a = String(c.args ?? '')
    const name = String(c.name)
    if (['edit', 'write'].includes(name) && /\.agent-presets/.test(a)) vigilante.push(`${name}:${a.slice(0, 80)}`)
    else if (name === 'bash' && /rm .*\.agent-presets|session\.prompt/.test(a)) vigilante.push(`${name}:${a.slice(0, 80)}`)
    else if (['edit', 'write', 'bash', 'read', 'grep', 'glob'].includes(name) && /\.agent-presets|dsh-assembler/.test(a)) construction.push(name)
  }
  return { vigilante, construction: construction.length }
}

function rowA(id, r) {
  const texts = (r.toolResults ?? [])
  const joined = texts.join('\n')
  const verdict = (joined.match(/自动验证:(PASS|FAIL|SKIPPED|ERRORED)/) ?? [])[1]
    ?? (r.timedOut ? 'TIMEOUT' : r.error ? 'ERROR' : 'NO-VERDICT')
  const carried = /自动验证:PASS — 沿用|验收沿用/.test(joined)
  const retry = /重试轮/.test(joined)
  const asmSecs = (joined.match(/耗时:共 (\d+)s/) ?? [])[1]
  const aux = auxTokens(texts)
  const d = discipline(r.toolCalls)
  const mu = r.mainAgentUsage ?? {}
  return {
    id, arm: 'A', verdict, carried, retry,
    wall: r.seconds ?? 0, asm: asmSecs !== undefined ? Number(asmSecs) : null,
    auxOut: aux.out, auxReason: aux.reason,
    mainOut: mu.outputTokens ?? 0, mainReason: mu.reasoningTokens ?? 0,
    clarify: r.clarifications ?? 0, nudge: 0,
    emits: (r.toolCalls ?? []).filter((c) => c.name === 'assemble').length,
    vigilante: d.vigilante, construction: d.construction,
    bailedOnApproval: r.bailedOnApproval === true,
  }
}

function rowB(id, r) {
  const texts = (r.toolResults ?? [])
  const joined = texts.join('\n')
  const verdicts = [...joined.matchAll(/验收 (PASS|FAIL|SKIPPED|ERRORED)/g)].map((m) => m[1])
  const verdict = verdicts.at(-1)
    ?? (r.timedOut ? 'TIMEOUT' : r.error ? 'ERROR' : 'NO-VERDICT')
  const aux = auxTokens(texts)
  const calls = (n) => (r.toolCalls ?? []).filter((c) => c.name === n).length
  const d = discipline(r.toolCalls)
  const mu = r.mainAgentUsage ?? {}
  const cov = joined.match(/(\d+) 项架构需求 → (\d+) 个零件 \/ (\d+) 项缺口/)
  return {
    id, arm: 'B', verdict, carried: /验收 PASS\(沿用\)/.test(joined), retry: verdicts.length > 1,
    wall: r.seconds ?? 0, asm: null,
    auxOut: aux.out, auxReason: aux.reason,
    mainOut: mu.outputTokens ?? 0, mainReason: mu.reasoningTokens ?? 0,
    clarify: r.clarifications ?? 0, nudge: r.nudges ?? 0,
    emits: calls('emit_preset'), match: calls('match_catalog'), verify: calls('verify_preset'),
    needs: cov ? Number(cov[1]) : null, gaps: cov ? Number(cov[3]) : null,
    vigilante: d.vigilante, construction: d.construction,
    bailedOnApproval: r.bailedOnApproval === true,
  }
}

const A = loadDir(dirA)
const B = loadDir(dirB)
const ids = [...new Set([...A.keys(), ...B.keys()])].sort()
const rows = []
for (const id of ids) {
  if (A.has(id)) rows.push(rowA(id, A.get(id)))
  if (B.has(id)) rows.push(rowB(id, B.get(id)))
}

const k = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
const lines = []
lines.push('| 场景 | 臂 | 验收 | 墙钟s | 辅助token(出/思) | 主agent token(出/思) | 反问 | 重发 | 真义警 | 施工足迹 |')
lines.push('|---|---|---|---|---|---|---|---|---|---|')
for (const r of rows) {
  lines.push(`| ${r.id} | ${r.arm} | ${r.verdict}${r.carried ? '(沿用)' : ''}${r.retry ? '·重试' : ''}${r.bailedOnApproval ? '·升权撤' : ''} | ${r.wall} | ${k(r.auxOut)}/${k(r.auxReason)} | ${k(r.mainOut)}/${k(r.mainReason)} | ${r.clarify} | ${r.emits} | ${r.vigilante.length} | ${r.construction} |`)
}
const agg = (arm) => {
  const rs = rows.filter((r) => r.arm === arm)
  const pass = rs.filter((r) => r.verdict === 'PASS').length
  const sum = (f) => rs.reduce((a, r) => a + (f(r) ?? 0), 0)
  return `${arm} 臂:${pass}/${rs.length} PASS · 墙钟中位 ${median(rs.map((r) => r.wall))}s · Σ墙钟 ${sum((r) => r.wall)}s · 辅助思考 Σ${k(sum((r) => r.auxReason))} · 主agent思考 Σ${k(sum((r) => r.mainReason))} · 真义警 Σ${sum((r) => r.vigilante.length)} · 施工足迹 Σ${sum((r) => r.construction)}`
}
function median(a) { const s = [...a].sort((x, y) => x - y); return s.length === 0 ? 0 : s[Math.floor(s.length / 2)] }
lines.push('', agg('A'), agg('B'), '')
for (const r of rows.filter((x) => x.vigilante.length > 0)) {
  lines.push(`真义警明细 [${r.id}/${r.arm}]:${r.vigilante.slice(0, 3).join(' | ')}`)
}
const md = lines.join('\n')
console.log(md)
if (outFile) writeFileSync(outFile, md + '\n')
