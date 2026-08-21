/**
 * 方案包(solution)——FDE 的多 agent 交付单元,作为 agent 工具暴露。
 *
 * 一个 preset 是一个 agent;一次真实交付常常是**几个分工明确的 agent + 共享
 * 数据 + 部署参数 + 凭证清单 + 一份交付说明书**。市场战役 FDE 级(f01 电商
 * 运营班子)实测暴露:主 agent 只有单发 assemble 工具时,面对"装一套四个
 * agent 的班子"只能把四份职责揉进一个 30 能力的巨型 preset——多 agent 分工、
 * 共享数据契约、HANDOVER 文档全部落不了地。这个工具把 solution.mjs 的 CLI
 * 能力搬进 agent 可达面:接受 agent 清单,逐个走同一条装配脊柱(选型→发射→
 * 独立验收),最后从工件本身(每个 preset 的 parts.lock.yml)汇总出交付报告。
 *
 * 判据回照(DESIGN.md 三条,与 CLI 版一致):
 *  - 运行时:装配完即产出 preset 目录 + HANDOVER.md,装配器不在会话期在场 ✓
 *  - 步骤号:清单声明"有哪些 agent、各自要什么",不含执行顺序 ✓
 *  - 产物:solution.yml + preset 目录 + HANDOVER.md,全是静态工件 ✓
 *
 * 与 CLI 版的唯一区别:直接调进程内的 assemble()(不绕 wire 回环),因为工具
 * 本就跑在 host 进程里,回环只会平添一次会话握手与 20 分钟的墙钟猜测。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import yaml from 'js-yaml'
import type { Context } from '@deepseek-ai/cordis'
import { assemble, type Config } from './index.js'

/** 一个 agent 的交付结果:装配判决 + 关键产物指针。 */
export interface SolutionAgentResult {
  id: string
  requirement: string
  verdict: 'PASS' | 'FAIL' | 'SKIPPED' | 'ERRORED' | 'ERROR'
  verdictReason?: string
  presetPath?: string
  frontendUrl?: string
  parts: number
  gaps: number
  seconds: number
}

export interface SolutionResult {
  name: string
  client?: string
  agents: SolutionAgentResult[]
  handoverPath: string
  solutionPath: string
  ok: boolean
  failed: string[]
}

const presetRoot = (config: Config): string =>
  config.presetRoot ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.agent-presets')

/**
 * 装配一整套方案:逐个 agent 走 assemble(),从工件汇总 HANDOVER。
 *
 * 串行而非并行:同一进程内 assemble() 各自开探针会话,并行只是把探针的模型
 * 解码挤在一起争 CPU(法医:99% 墙钟是解码),收益有限却让直播台的行动链
 * 交错难读。方案交付不追求秒级,追求每个 agent 都有独立验收证据。
 */
export async function assembleSolution(
  ctx: Context,
  spec: {
    name: string
    client?: string
    params?: Record<string, string>
    agents: Array<{ id: string; requirement: string }>
  },
  config: Config,
  onPhase?: (line: string) => void,
): Promise<SolutionResult> {
  const root = presetRoot(config)
  const solutionDir = join(root, '_solutions', spec.name)
  mkdirSync(solutionDir, { recursive: true })

  const phase = (line: string): void => { try { onPhase?.(line) } catch { /* 直播是加速器 */ } }
  phase(`══ 方案「${spec.name}」开始:共 ${String(spec.agents.length)} 个 agent ══`)

  const results: SolutionAgentResult[] = []
  for (const [i, a] of spec.agents.entries()) {
    phase(`方案 agent ${String(i + 1)}/${String(spec.agents.length)}:装配「${a.id}」…`)
    const t0 = Date.now()
    try {
      const r = await assemble(ctx, a.requirement, config, {
        name: a.id,
        ...(spec.params !== undefined ? { params: spec.params } : {}),
        onPhase,
      })
      results.push({
        id: a.id,
        requirement: a.requirement,
        verdict: r.verification.status,
        ...(r.verification.reason !== undefined ? { verdictReason: r.verification.reason.slice(0, 200) } : {}),
        presetPath: r.presetPath,
        ...(r.frontend?.url !== undefined ? { frontendUrl: r.frontend.url } : {}),
        parts: r.capabilityIds.length,
        gaps: r.gapOrders.length,
        seconds: Math.round((Date.now() - t0) / 1000),
      })
      phase(`方案 agent「${a.id}」:${r.verification.status}(${String(Math.round((Date.now() - t0) / 1000))}s)`)
    } catch (error: unknown) {
      results.push({
        id: a.id,
        requirement: a.requirement,
        verdict: 'ERROR',
        verdictReason: error instanceof Error ? error.message.slice(0, 200) : String(error),
        parts: 0,
        gaps: 0,
        seconds: Math.round((Date.now() - t0) / 1000),
      })
      phase(`方案 agent「${a.id}」:ERROR ${error instanceof Error ? error.message.slice(0, 100) : ''}`)
    }
  }

  // 方案清单落盘(可 git、可在另一台机器重建的交付单元)。
  const solutionDoc = {
    name: spec.name,
    client: spec.client ?? '(未填)',
    version: '0.1.0',
    generatedAt: new Date().toISOString(),
    params: spec.params ?? {},
    agents: spec.agents.map((a) => ({ id: a.id, requirement: a.requirement })),
  }
  const solutionPath = join(solutionDir, 'solution.yml')
  writeFileSync(solutionPath, `# ${spec.name} —— 方案包清单(FDE 多 agent 交付单元)\n${yaml.dump(solutionDoc, { lineWidth: -1 })}`)

  const handoverPath = writeHandover(solutionDir, spec, results, root)
  phase(`══ 方案「${spec.name}」交付完成:${String(results.filter((r) => r.verdict === 'PASS').length)}/${String(results.length)} PASS · HANDOVER 已生成 ══`)

  const failed = results.filter((r) => ['FAIL', 'ERRORED', 'ERROR'].includes(r.verdict)).map((r) => r.id)
  return {
    name: spec.name,
    ...(spec.client !== undefined ? { client: spec.client } : {}),
    agents: results,
    handoverPath,
    solutionPath,
    ok: failed.length === 0,
    failed,
  }
}

/**
 * 交付报告从工件长出来,不从记忆里:读每个 preset 的 parts.lock.yml,汇总
 * 交付了哪些 agent、各自验收结论、共享的零件 BOM、待配置凭证、知识包。
 */
export function writeHandover(
  solutionDir: string,
  spec: { name: string; client?: string; params?: Record<string, string> },
  results: SolutionAgentResult[],
  root: string,
): string {
  const allSecrets = new Map<string, { env: string; purpose?: string; configured?: boolean; optional?: boolean }>()
  const allParts = new Map<string, { part: string; repo?: string; rev?: string; service?: string; license?: string }>()
  const allKnowledge = new Map<string, { id: string; docs: number; source?: string; version?: string }>()
  const sharedTables = new Set<string>()

  for (const r of results) {
    const lockPath = join(root, r.id, 'parts.lock.yml')
    if (!existsSync(lockPath)) continue
    let lock: Record<string, unknown>
    try { lock = yaml.load(readFileSync(lockPath, 'utf8')) as Record<string, unknown> } catch { continue }
    for (const p of (lock.parts as Array<Record<string, unknown>> ?? [])) {
      if (p.via === 'knowledge') continue
      const key = (p.server ?? p.capability) as string
      if (!allParts.has(key)) {
        allParts.set(key, {
          part: key,
          ...(p.repo !== undefined ? { repo: p.repo as string, rev: p.rev as string } : {}),
          ...(p.service !== undefined ? { service: p.service as string } : {}),
          license: p.license as string | undefined,
        })
      }
    }
    for (const sec of (lock.requiredSecrets as Array<Record<string, unknown>> ?? [])) {
      if (!allSecrets.has(sec.env as string)) allSecrets.set(sec.env as string, sec as { env: string; purpose?: string; configured?: boolean; optional?: boolean })
    }
    for (const k of (lock.knowledge as Array<Record<string, unknown>> ?? [])) {
      if (!allKnowledge.has(k.id as string)) allKnowledge.set(k.id as string, k as { id: string; docs: number; source?: string; version?: string })
    }
    // 共享数据:各 agent 装备槽里的表名(equipment/init.sql 存在即读表名)。
    const eqPath = join(root, r.id, 'equipment', 'init.sql')
    if (existsSync(eqPath)) {
      try {
        const ddl = readFileSync(eqPath, 'utf8')
        for (const m of ddl.matchAll(/CREATE TABLE IF NOT EXISTS\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)/gi)) sharedTables.add(m[1])
      } catch { /* 读不到就不列 */ }
    }
  }

  const md = [
    `# ${spec.name} 交付报告`,
    '',
    `- 客户:${spec.client ?? '(未填)'}`,
    `- 生成时间:${new Date().toISOString()}`,
    `- agent 数:${String(results.length)}`,
    '',
    '## 交付的 agent',
    '',
    '| agent | 验收 | 零件数 | 缺件工单 | 前端 |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.verdict} | ${String(r.parts)} | ${r.gaps > 0 ? `${String(r.gaps)} 份` : '—'} | ${r.frontendUrl ?? '—'} |`),
    '',
    '## 每个 agent 的职责',
    '',
    ...results.map((r) => `- **${r.id}**:${r.requirement.replace(/\s+/g, ' ').trim().slice(0, 120)}`),
    '',
    '## 共享数据(各 agent 预建表)',
    '',
    sharedTables.size === 0 ? '(本方案无预建共享表)' : [...sharedTables].map((t) => `- \`${t}\``).join('\n'),
    '',
    '## 部署参数',
    '',
    Object.keys(spec.params ?? {}).length === 0 ? '(无)' : Object.entries(spec.params ?? {}).map(([k, v]) => `- \`${k}\` = ${v}`).join('\n'),
    '',
    '## 待配置凭证',
    '',
    allSecrets.size === 0 ? '(本方案不需要凭证)' : ['| 变量 | 用途 | 状态 |', '|---|---|---|', ...[...allSecrets.values()].map((s) => `| \`${s.env}\` | ${s.purpose ?? ''} | ${s.configured ? '已配置' : s.optional ? '可选' : '**待配置**'} |`)].join('\n'),
    '',
    '## 知识包',
    '',
    allKnowledge.size === 0 ? '(本方案不含知识包)' : ['| 包 | 篇数 | 来源 | 版本 |', '|---|---|---|---|', ...[...allKnowledge.values()].map((k) => `| ${k.id} | ${String(k.docs)} | ${k.source ?? ''} | ${k.version ?? ''} |`)].join('\n'),
    '',
    '## 供应链清单(BOM 汇总)',
    '',
    '| 零件 | 出处 | 许可 |',
    '|---|---|---|',
    ...[...allParts.values()].map((p) => {
      const origin = p.repo === 'first-party' ? '第一方(Node 内置薄壳)'
        : p.repo !== undefined ? `${p.repo}${p.rev !== undefined && p.rev !== 'v-' ? `@${p.rev}` : ''}`
          : p.service !== undefined ? p.service
            : '宿主自带能力'
      return `| ${p.part} | ${origin} | ${p.license ?? '-'} |`
    }),
    '',
  ].join('\n')

  const handoverPath = join(solutionDir, 'HANDOVER.md')
  writeFileSync(handoverPath, md)
  return handoverPath
}
