/**
 * assemble_solution —— 多 agent 方案交付的 agent 工具。
 *
 * assemble 单发工具装一个 agent;这个工具装一整套班子:接受 agent 清单,逐个
 * 走同一条装配脊柱,最后从工件汇总一份 HANDOVER 交付说明书。市场战役 FDE 级
 * 实测(f01):没有它,主 agent 面对"四个分工 agent 的班子"只能揉成一个巨型
 * 单体,多 agent 分工与交付文档全落不了地。
 *
 * 进度经 jobs 通道直播(与 assemble 同款):方案装配动辄数分钟,jobs 是 host
 * 唯一的活通道,每个子 agent 的装配 phase 都往那里滚。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { assembleSolution } from './solution.js'
import type { Config } from './index.js'

export const SOLUTION_TOOL_NAME = 'assemble_solution'

export function solutionToolDefinition(ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: SOLUTION_TOOL_NAME,
    description:
      'Assemble a MULTI-AGENT SOLUTION: several agents that divide the work, plus a HANDOVER delivery document. '
      + 'Call this — NOT assemble — when the user asks for a SET/TEAM/SUITE of agents (e.g. "一套运营 agent 班子", '
      + '"a suite of agents: one for X, one for Y, one for Z", "整套方案"). Each agent in the list is assembled and '
      + 'independently verified on the same pipeline as assemble; a solution.yml manifest and a HANDOVER.md '
      + '(per-agent verdicts, shared tables, credential checklist, supply-chain BOM) are written. '
      + 'Do NOT cram several distinct roles into one assemble call — split them into this tool\'s agents list. '
      + 'AFTER it returns, relay to the user: each agent\'s id + verdict + frontend URL, the HANDOVER path, and any '
      + 'credentials still to configure. On any FAIL, report it and wait for the user — do not edit presets or retry blindly.',
    parameters: {
      name: {
        type: 'string',
        description: 'A short kebab-case slug naming the whole solution/suite, e.g. "ecommerce-ops-suite". Becomes the solution folder name.',
      },
      client: {
        type: 'string',
        description: 'Optional client/organization name for the HANDOVER document header.',
      },
      agents: {
        type: 'array',
        description:
          'The agents that make up this solution, each an object {id, requirement}. id is a short kebab-case slug for that ONE agent; '
          + 'requirement is the full natural-language spec for that ONE agent (write each as if it were a standalone assemble requirement). '
          + 'Split the user\'s suite into 2+ focused agents — one role per entry.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'kebab-case preset id for this one agent, e.g. "cs-agent"', required: true },
            requirement: { type: 'string', description: 'full requirement for this one agent', required: true },
          },
        },
      },
      sharedSchema: {
        type: 'string',
        description:
          'Optional SHARED SQLite DDL (idempotent: only CREATE TABLE/INDEX IF NOT EXISTS) defining tables that ALL agents '
          + 'in the suite read and write together — use this when the request says the agents "share the same data" '
          + '(e.g. 共享同一套商品/订单数据). Define the common tables (products, orders, …) here ONCE; every agent\'s SQLite '
          + 'default DB is pinned to one shared solution database, so what one agent writes another can read. '
          + 'Each agent still gets its own extra tables from its own assembly. English column names, sensible keys.',
      },
      params: {
        type: 'object',
        additionalProperties: true,
        description:
          'Optional NON-SECRET deployment parameters (flat string map) applied to EVERY agent in the solution, '
          + 'e.g. {"timezone": "Asia/Shanghai"}. Never pass credentials — secret-shaped keys are refused by design.',
      },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown): Promise<string> => {
      const a = args as { name?: unknown; client?: unknown; agents?: unknown; params?: unknown; sharedSchema?: unknown } | null
      const name = typeof a?.name === 'string' ? a.name.trim() : ''
      if (name === '') throw new Error('assemble_solution needs {"name": "<suite-slug>", "agents": [...]}')
      const rawAgents = Array.isArray(a?.agents) ? a.agents : []
      const agents = rawAgents
        .map((x) => x as { id?: unknown; requirement?: unknown })
        .filter((x) => typeof x.id === 'string' && x.id.trim() !== '' && typeof x.requirement === 'string' && x.requirement.trim() !== '')
        .map((x) => ({ id: (x.id as string).trim(), requirement: (x.requirement as string).trim() }))
      if (agents.length < 2) {
        throw new Error('assemble_solution 至少要 2 个 agent(单个 agent 用 assemble)。agents 每项需 {id, requirement}。')
      }
      const params: Record<string, string> = {}
      if (a?.params !== null && typeof a?.params === 'object') {
        for (const [k, v] of Object.entries(a.params as Record<string, unknown>)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params[k] = String(v)
        }
      }

      // jobs 直播:方案装配是长任务,每个子 agent 的 phase 都往 jobs 通道滚。
      const jobs = ctx.get('jobs') as undefined | {
        start(spec: { kind: string; label: string; run: () => { cancel: () => void; done: Promise<{ status: 'completed' | 'failed'; detail?: string }>; readOutput?: () => string } }): unknown
      }
      const lines: string[] = []
      const onPhase = (line: string): void => { lines.push(line) }

      const client = typeof a?.client === 'string' ? a.client.trim() : undefined
      const sharedSchema = typeof a?.sharedSchema === 'string' && a.sharedSchema.trim() !== '' ? a.sharedSchema.trim() : undefined
      const spec = { name, ...(client !== undefined && client !== '' ? { client } : {}), ...(sharedSchema !== undefined ? { sharedSchema } : {}), ...(Object.keys(params).length > 0 ? { params } : {}), agents }

      let jobDone: ((o: { status: 'completed' | 'failed'; detail?: string }) => void) | undefined
      if (jobs !== undefined) {
        try {
          jobs.start({
            kind: 'assemble-solution',
            label: `装配方案 ${name}(${String(agents.length)} agent)`,
            run: () => ({
              cancel: () => { /* 方案装配不中途取消:半套班子比不装更难交付 */ },
              done: new Promise((resolve) => { jobDone = resolve }),
              readOutput: () => lines.join('\n'),
            }),
          })
        } catch { /* 没有 jobs 插件就静默直装 */ }
      }

      try {
        const result = await assembleSolution(ctx, spec, config, onPhase)
        jobDone?.({ status: result.ok ? 'completed' : 'failed', detail: `${String(result.agents.filter((r) => r.verdict === 'PASS').length)}/${String(result.agents.length)} PASS` })
        return renderSolutionResult(result)
      } catch (error: unknown) {
        jobDone?.({ status: 'failed', detail: error instanceof Error ? error.message.slice(0, 120) : String(error) })
        throw error
      }
    },
  })
}

/** 方案结果文本:给调用方 agent 逐个 agent 的判决 + 交付文档指针 + 行为契约。 */
export function renderSolutionResult(result: import('./solution.js').SolutionResult): string {
  const rows = result.agents.map((r) =>
    `  - ${r.id}: ${r.verdict}${r.gaps > 0 ? `(${String(r.gaps)} 缺件工单)` : ''}${r.frontendUrl !== undefined ? ` · ${r.frontendUrl}` : ''}${r.verdict !== 'PASS' && r.verdictReason !== undefined ? ` — ${r.verdictReason.slice(0, 100)}` : ''}`,
  ).join('\n')
  const passN = result.agents.filter((r) => r.verdict === 'PASS').length
  const anyGaps = result.agents.some((r) => r.gaps > 0)
  const contract = [
    '',
    '【给调用方 agent 的行为契约】',
    `- 如实向用户转述:每个 agent 的 id + 验收结论 + 前端 URL、HANDOVER 文档路径(${result.handoverPath})。`,
    ...(result.failed.length > 0 ? ['- 有 agent 未通过:如实报出失败的 agent 与原因,不要自行改 preset 或另装,等用户定夺。'] : []),
    ...(anyGaps ? ['- 有缺件工单:先转述、征得用户同意再照单施工(新零件走入库流水线)。'] : []),
    '- 待配置凭证见 HANDOVER 的「待配置凭证」表:凭证配到 host 环境变量,绝不进装配参数。',
  ].join('\n')
  return `方案「${result.name}」交付:${String(passN)}/${String(result.agents.length)} PASS\n`
    + `agent:\n${rows}\n`
    + `\n方案清单:${result.solutionPath}\n交付说明书:${result.handoverPath}\n`
    + contract + '\n'
}
