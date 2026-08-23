// 多形态对比器(B/C/D/F):逐场景 × 臂的五维 + 各形态专属指标。
// 用法:node sweep-forms.mjs B=cdf-armB-out C=cdf-armC-out D=cdf-armD-out F=cdf-armF-out [out.md]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const pairs = process.argv.slice(2).filter((a) => a.includes('='))
const outFile = process.argv.slice(2).find((a) => a.endsWith('.md'))

function loadDir(dir) {
  const out = new Map()
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try { out.set(f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(dir, f), 'utf8'))) } catch {}
  }
  return out
}

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

function row(arm, id, r) {
  const texts = r.toolResults ?? []
  const joined = texts.join('\n')
  const verdicts = [...joined.matchAll(/验收 (PASS|FAIL|SKIPPED|ERRORED)|验收(跳过)/g)].map((m) => m[1] ?? 'SKIPPED')
  // 判决:末次 verify;b04 类拒绝场景没有 verify——检测拒绝话术。
  const refused = verdicts.length === 0 && /(不能|无法|不会|拒绝|违法|合规|不予)/.test((r.assistantText ?? '').slice(0, 2000)) && (r.toolCalls ?? []).every((c) => c.name !== 'emit_preset')
  const verdict = verdicts.at(-1) ?? (refused ? 'REFUSED' : r.timedOut ? 'TIMEOUT' : r.error ? 'ERROR' : 'NO-VERDICT')
  const aux = auxTokens(texts)
  const mu = r.mainAgentUsage ?? {}
  const calls = (n) => (r.toolCalls ?? []).filter((c) => c.name === n).length
  const vigilante = (r.toolCalls ?? []).filter((c) => ['edit', 'write'].includes(String(c.name)) && /\.agent-presets/.test(String(c.args ?? ''))).length
  // C 专属:红笔率——emit 的 name/capabilityIds/persona 与 draft 建议的差异。
  let redPen = null
  if (calls('draft_assembly') > 0 && calls('emit_preset') > 0) {
    const draftText = texts.find((t) => t.includes('方案书')) ?? ''
    const emitArgs = (r.toolCalls ?? []).find((c) => c.name === 'emit_preset')?.args ?? ''
    const dName = (draftText.match(/建议 preset 名:([a-z0-9-]+)/) ?? [])[1]
    const dIds = ((draftText.match(/选中零件 capabilityIds:([^\\\n]+)/) ?? [])[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    let eArgs = {}
    try { eArgs = JSON.parse(emitArgs.endsWith('…') ? '{}' : emitArgs) } catch {}
    const eIds = Array.isArray(eArgs.capabilityIds) ? eArgs.capabilityIds : []
    const idsChanged = dIds.length > 0 && eIds.length > 0 && JSON.stringify([...dIds].sort()) !== JSON.stringify([...eIds].sort())
    const nameChanged = dName !== undefined && typeof eArgs.name === 'string' && eArgs.name !== dName
    const personaChanged = typeof eArgs.persona === 'string' && draftText.includes('persona 草案') && !draftText.includes(eArgs.persona.slice(0, 60))
    redPen = (idsChanged ? 'ids' : '') + (nameChanged ? ' name' : '') + (personaChanged ? ' persona' : '')
    redPen = redPen.trim() === '' ? '照抄' : redPen.trim()
  }
  return {
    arm, id, verdict, wall: r.seconds ?? 0,
    auxOut: aux.out, auxReason: aux.reason,
    mainOut: mu.outputTokens ?? 0, mainReason: mu.reasoningTokens ?? 0,
    clarify: r.clarifications ?? 0, nudge: r.nudges ?? 0,
    emits: calls('emit_preset'), verifies: calls('verify_preset'),
    asks: calls('ask_catalog'), searches: calls('search_catalog'),
    drafts: calls('draft_assembly'), matches: calls('match_catalog'),
    vigilante, redPen,
  }
}

const arms = pairs.map((p) => { const [label, dir] = p.split('='); return { label, data: loadDir(dir) } })
const ids = [...new Set(arms.flatMap((a) => [...a.data.keys()]))].sort()
const rows = []
for (const id of ids) for (const a of arms) if (a.data.has(id)) rows.push(row(a.label, id, a.data.get(id)))

const k = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
const lines = []
lines.push('| 场景 | 臂 | 验收 | 墙钟s | 辅助(出/思) | 主agent(出/思) | 反问 | 接续 | 阶段1调用 | 重发 | 红笔 |')
lines.push('|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of rows) {
  const stage1 = r.matches > 0 ? `match×${r.matches}` : r.drafts > 0 ? `draft×${r.drafts}` : r.searches > 0 ? `search×${r.searches}` : '—'
  const stage1b = r.asks > 0 ? `${stage1}+ask×${r.asks}` : stage1
  lines.push(`| ${r.id} | ${r.arm} | ${r.verdict} | ${r.wall} | ${k(r.auxOut)}/${k(r.auxReason)} | ${k(r.mainOut)}/${k(r.mainReason)} | ${r.clarify} | ${r.nudge} | ${stage1b} | ${r.emits} | ${r.redPen ?? '—'} |`)
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length === 0 ? 0 : s[Math.floor(s.length / 2)] }
lines.push('')
for (const a of arms) {
  const rs = rows.filter((r) => r.arm === a.label)
  const pass = rs.filter((r) => r.verdict === 'PASS').length
  const refused = rs.filter((r) => r.verdict === 'REFUSED').length
  const sum = (f) => rs.reduce((x, r) => x + (f(r) ?? 0), 0)
  lines.push(`${a.label}:${pass} PASS + ${refused} 拒装 / ${rs.length} · 墙钟中位 ${median(rs.map((r) => r.wall))}s Σ${sum((r) => r.wall)}s · 辅助思 Σ${k(sum((r) => r.auxReason))} · 主思 Σ${k(sum((r) => r.mainReason))} · 义警 Σ${sum((r) => r.vigilante)} · ask Σ${sum((r) => r.asks)} · search Σ${sum((r) => r.searches)}`)
}
const md = lines.join('\n')
console.log(md)
if (outFile) writeFileSync(outFile, md + '\n')
