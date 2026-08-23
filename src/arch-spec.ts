/**
 * 实验(flag 门控,不进正常工具面):A/B 对照"选型优先" vs "架构优先"。
 *
 * 用户提的架构问题:做一个 agent 最重要的第一步是先定整体架构出 spec,再选型、
 * 再补缺口;而现在 assembler 是"选型优先"(一上来就锚定目录挑能力)。这个模块
 * 拿真实 ctx.llm 跑两条路,产出可比对的结果,用证据决定值不值得改主脊柱:
 *
 *  A 选型优先(现状):llmMapRequirement —— 需求 + 目录 → 一次调用出选型 + 缺口。
 *  B 架构优先(原型):
 *    1) deriveArchSpec —— 需求(不给目录)→ 架构 spec:这个 agent 要做什么、
 *       架构上需要哪些**通用描述**的能力、数据模型、工作流、接口。不看目录 = 不偏置。
 *    2) mapSpecToCatalog —— 把 spec 的能力逐条映射到目录:命中的选中,没有的进缺口。
 *       缺口 = spec 需求 − 目录覆盖(派生的、完整的)。
 *
 * 对照维度:选中集差异(B 多选/漏选了什么)、缺口差异(B 是否发现 A 漏掉的架构需求)。
 */
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { AUX_CALL_TIMEOUT_MS, parseModelJson } from './verify.js'
import { llmMapRequirement, loadCatalog, federateMcpTools, type Catalog, type CapabilityEntry, type Config } from './index.js'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 一次原始 LLM JSON 调用(与 llmMapRequirement 同款 flash + 档位纪律)。 */
async function callJson(ctx: Context, prompt: string, model: { provider?: string; model?: string }, config?: Config): Promise<Record<string, unknown>> {
  const selection = (ctx.get('agentDefaultModel') as { currentSelection?: () => { provider?: string } | undefined } | undefined)?.currentSelection?.()
  const request: GenerateOptions = {
    provider: model.provider ?? config?.provider ?? selection?.provider ?? 'deepseek-official',
    model: model.model ?? config?.model ?? 'deepseek-v4-flash',
    ...(config?.auxReasoningEffort !== undefined ? { reasoningEffort: config.auxReasoningEffort as GenerateOptions['reasoningEffort'] } : {}),
    messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })],
    ...(AUX_CALL_TIMEOUT_MS > 0 ? { signal: AbortSignal.timeout(AUX_CALL_TIMEOUT_MS) } : {}),
  }
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(`experiment: model call ${finish.kind}`)
  let text = ''
  for (const block of assembler.message().content) if (block.type === 'text') text += block.text
  return parseModelJson(text)
}

export interface ArchSpec {
  purpose: string
  capabilities: Array<{ name: string; why: string }>
  dataModel: string
  workflow: string
  interfaces: string
  /**
   * 架构师顺手写的验收探针草图(真瓶颈打法 B:确定性构造探针)。
   * 架构师本来就在想 workflow,多写这四个字段边际成本几秒,却能把之后整段
   * ~160s 的探针推导 LLM 调用整个省掉——装配侧只做机械校验(validateArchProbe),
   * 不合格就回退 LLM 推导,不冒质量险。与 stateSchema 同款"装配时预思考"。
   */
  probe?: {
    kind: 'scenario' | 'single'
    /** scenario:轮1 建中心记录的完整指令(数据全内嵌,自给自足)。 */
    createTask?: string
    /** scenario:轮2 按 token 取回并报告的指令(不复述其余字段)。 */
    retrieveTask?: string
    /** 架构师发明的独特 token(如 INV-7781),两轮指令都要含它。 */
    token?: string
    /** single:一轮任务指令。 */
    task?: string
    /** 验收标记(1-3 个,内容型)。 */
    marks?: string[]
  }
}

/** B-1:需求 → 架构 spec(不给目录,避免偏置)。 */
export async function deriveArchSpec(ctx: Context, requirement: string, model: { provider?: string; model?: string }, config?: Config): Promise<ArchSpec> {
  const prompt = [
    'You are an agent ARCHITECT. A user describes an agent they want. Design its architecture FIRST — do NOT think about any existing parts catalog, think about what this agent fundamentally NEEDS.',
    'Respond with JSON only: {"purpose":"...","capabilities":[{"name":"...","why":"..."}],"dataModel":"...","workflow":"...","interfaces":"...","probe":{...}}',
    '- purpose: one line, what this agent is for.',
    '- capabilities: the FULL list of distinct capabilities this agent architecturally needs, each a GENERIC description (e.g. "parse uploaded documents", "persist records across sessions", "search imported knowledge with citations", "generate a PDF report"). Be exhaustive — list everything the requirement implies, even the unglamorous ones (storage, retrieval, export). Do NOT reference any specific tool or library.',
    '- dataModel: what state it must keep (entities + key fields), one or two lines.',
    '- workflow: the main flow across turns, one or two lines.',
    '- interfaces: what humans/other systems interact with it through (a UI shape, a file drop, an API), one line.',
    '- probe: a SMOKE-TEST sketch for the workflow\'s happy path, so acceptance needs no separate design pass. Two shapes:',
    '  {"kind":"scenario","createTask":"...","retrieveTask":"...","token":"...","marks":["..."]} when the workflow keeps state across turns: invent a distinctive token (e.g. INV-7781); createTask = one instruction (in the requirement\'s language) that CREATES the workflow\'s central record carrying the token, with ALL data values invented inline (the probe runs in an EMPTY workspace with NOBODY to ask — never reference pre-existing files or expect human input); retrieveTask = one instruction that retrieves/uses that record BY the token WITHOUT restating its other fields, and reports one specific stored value.',
    '  {"kind":"single","task":"...","marks":["..."]} for pure compute/transform agents with no cross-turn state.',
    '  marks: 1-3 content-bearing strings that appear in the reply IFF it truly worked — verbatim tokens or stored values. NEVER: invented dates/date-ranges as facts, refusal wording, formatted numbers (1000.00 when 1000 is stored), UI/page words, or long verbatim body text when output goes to a file (mark the filename/confirmation instead). Size tasks to finish in ~2 minutes; batch flavors use 2-3 items max.',
    '',
    `Requirement: ${requirement}`,
  ].join('\n')
  const j = await callJson(ctx, prompt, model, config)
  const rawProbe = j.probe !== null && typeof j.probe === 'object' ? j.probe as Record<string, unknown> : undefined
  return {
    purpose: String(j.purpose ?? ''),
    capabilities: Array.isArray(j.capabilities) ? (j.capabilities as Array<Record<string, unknown>>).map((c) => ({ name: String(c.name ?? ''), why: String(c.why ?? '') })).filter((c) => c.name !== '') : [],
    dataModel: String(j.dataModel ?? ''),
    workflow: String(j.workflow ?? ''),
    interfaces: String(j.interfaces ?? ''),
    ...(rawProbe !== undefined ? {
      probe: {
        kind: rawProbe.kind === 'single' ? 'single' as const : 'scenario' as const,
        ...(typeof rawProbe.createTask === 'string' ? { createTask: rawProbe.createTask } : {}),
        ...(typeof rawProbe.retrieveTask === 'string' ? { retrieveTask: rawProbe.retrieveTask } : {}),
        ...(typeof rawProbe.token === 'string' ? { token: rawProbe.token } : {}),
        ...(typeof rawProbe.task === 'string' ? { task: rawProbe.task } : {}),
        ...(Array.isArray(rawProbe.marks) ? { marks: (rawProbe.marks as unknown[]).map(String) } : {}),
      },
    } : {}),
  }
}

/**
 * 架构探针草图的机械校验闸:合格 → 直接构造 ProbePlan(省掉整段 LLM 探针推导);
 * 任何一条不过 → null(调用方回退 LLM 推导)。校验的每一条都是战役里真踩过的坑:
 * 标记消毒(代码碎片/过短)、token 自给自足(两轮指令都得含它,轮1 造它轮2 用它)、
 * 取回轮不许复述标记值(否则 agent 照抄指令就能假 PASS,共享探针同款教训)。
 */
export function validateArchProbe(probe: NonNullable<ArchSpec['probe']>, sanitize: (marks: unknown[]) => string[]): import('./verify.js').ProbePlan | null {
  const marks = sanitize(probe.marks ?? [])
  if (marks.length === 0) return null
  if (probe.kind === 'single') {
    const task = (probe.task ?? '').trim()
    if (task.length < 10) return null
    return { kind: 'single', probe: { task, mustInclude: marks } }
  }
  const createTask = (probe.createTask ?? '').trim()
  const retrieveTask = (probe.retrieveTask ?? '').trim()
  const token = (probe.token ?? '').trim()
  // 15:自给自足的建档指令(含内嵌数据)不可能更短——更短的多半是残缺草图。
  if (createTask.length < 15 || retrieveTask.length < 10 || token.length < 3) return null
  // token 自给自足:轮1 造它、轮2 按它取——两轮都必须真含 token。
  if (!createTask.includes(token) || !retrieveTask.includes(token)) return null
  // 取回轮不许把标记值(除 token 本身)复述在指令里:否则照抄即假 PASS。
  for (const m of marks) {
    if (m !== token && retrieveTask.toLowerCase().includes(m.toLowerCase())) return null
  }
  return {
    kind: 'scenario',
    scenario: {
      goal: '架构直构:主工作流建档→取回(token 连续性)',
      turns: [
        { prompt: createTask, mustInclude: [token] },
        { prompt: retrieveTask, mustInclude: marks },
      ],
    },
  }
}

/** B-2:把架构 spec 的能力映射到目录 → 选中 + 缺口(缺口 = spec 需求 − 目录覆盖)。 */
export async function mapSpecToCatalog(ctx: Context, spec: ArchSpec, catalog: Catalog, model: { provider?: string; model?: string }, config?: Config): Promise<{ capabilityIds: string[]; missing: string[] }> {
  const usable = catalog.capabilities.filter((c: CapabilityEntry) => c.config?.enabled !== false)
  const ids = usable.map((c: CapabilityEntry) => c.id)
  const tagsIndex = usable.map((c: CapabilityEntry) => `${c.id}: ${c.tags.join(', ')} — ${c.description}`).join('\n')
  const need = spec.capabilities.map((c, i) => `${String(i + 1)}. ${c.name} — ${c.why}`).join('\n')
  const prompt = [
    'You map an agent\'s ARCHITECTURAL capability needs onto a parts catalog. For EACH needed capability, either find the catalog id that covers it, or mark it MISSING.',
    '',
    'The agent architecturally needs (from its spec):',
    need,
    `Data model: ${spec.dataModel}`,
    '',
    'Catalog:',
    tagsIndex,
    '',
    'Rules:',
    '- Respond with JSON only: {"capabilityIds":[...],"missing":[...]}',
    `- capabilityIds must ONLY use ids from this exact set: ${ids.join(', ')}`,
    '- Go through EVERY needed capability above. If a catalog part covers it (possibly under another name — persistent state → SQLite parts; save/read files → filesystem parts; search/cite docs → kb/fs-search; document output → docx/pdf/excel), select that id. If NOTHING covers it, add a GENERIC description to "missing". Every architectural need must end up either selected or missing — none silently dropped.',
    '- Also select a state-keeping part if the data model needs persistence, and exactly one via:"frontend" template if an interface/UI is implied.',
  ].join('\n')
  const j = await callJson(ctx, prompt, model, config)
  const capabilityIds = Array.isArray(j.capabilityIds) ? (j.capabilityIds as unknown[]).map(String).filter((id) => ids.includes(id)) : []
  const missing = Array.isArray(j.missing) ? (j.missing as unknown[]).map(String) : []
  return { capabilityIds: [...new Set(capabilityIds)], missing }
}

/** 一次完整 A/B 对照:同一需求跑选型优先 + 架构优先,产出可比对结果。 */
export async function runSpecExperiment(ctx: Context, requirement: string, catalog: Catalog, config?: Config): Promise<{
  requirement: string
  selectionFirst: { capabilityIds: string[]; missing: string[] }
  archFirst: { spec: ArchSpec; capabilityIds: string[]; missing: string[] }
  diff: { onlyInArch: string[]; onlyInSelection: string[]; gapsOnlyInArch: number; gapsOnlyInSelection: number }
}> {
  const model = { provider: config?.provider, model: config?.model }
  const a = await llmMapRequirement(ctx, requirement, catalog, model, config)
  const spec = await deriveArchSpec(ctx, requirement, model, config)
  const b = await mapSpecToCatalog(ctx, spec, catalog, model, config)
  const setA = new Set(a.capabilityIds)
  const setB = new Set(b.capabilityIds)
  return {
    requirement,
    selectionFirst: { capabilityIds: a.capabilityIds, missing: a.missing },
    archFirst: { spec, capabilityIds: b.capabilityIds, missing: b.missing },
    diff: {
      onlyInArch: b.capabilityIds.filter((id) => !setA.has(id)),
      onlyInSelection: a.capabilityIds.filter((id) => !setB.has(id)),
      gapsOnlyInArch: b.missing.length,
      gapsOnlyInSelection: a.missing.length,
    },
  }
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 实验工具定义(flag 门控注册)。传 requirement,返回 A/B 对照的 JSON 文本。 */
export function specExperimentToolDefinition(ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: 'spec_experiment',
    description: 'EXPERIMENT ONLY: for one requirement, run selection-first (current) vs architecture-first (spec then map) and return the comparison. Pass {"requirement": "..."}.',
    parameters: {
      requirement: { type: 'string', description: 'the agent requirement to A/B test', required: true },
    },
    output: { schema: { type: 'string' as const }, render: (_a: unknown, v: string) => [{ type: 'text' as const, text: v }] },
    execute: async (args: unknown): Promise<string> => {
      const requirement = String((args as { requirement?: unknown })?.requirement ?? '').trim()
      if (requirement === '') throw new Error('spec_experiment needs {"requirement": "..."}')
      const catalog = await federateMcpTools(loadCatalog(config.catalogPath ?? join(REPO, 'capabilities.yml')))
      const r = await runSpecExperiment(ctx, requirement, catalog, config)
      return JSON.stringify(r, null, 2)
    },
  })
}
