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
}

/** B-1:需求 → 架构 spec(不给目录,避免偏置)。 */
export async function deriveArchSpec(ctx: Context, requirement: string, model: { provider?: string; model?: string }, config?: Config): Promise<ArchSpec> {
  const prompt = [
    'You are an agent ARCHITECT. A user describes an agent they want. Design its architecture FIRST — do NOT think about any existing parts catalog, think about what this agent fundamentally NEEDS.',
    'Respond with JSON only: {"purpose":"...","capabilities":[{"name":"...","why":"..."}],"dataModel":"...","workflow":"...","interfaces":"..."}',
    '- purpose: one line, what this agent is for.',
    '- capabilities: the FULL list of distinct capabilities this agent architecturally needs, each a GENERIC description (e.g. "parse uploaded documents", "persist records across sessions", "search imported knowledge with citations", "generate a PDF report"). Be exhaustive — list everything the requirement implies, even the unglamorous ones (storage, retrieval, export). Do NOT reference any specific tool or library.',
    '- dataModel: what state it must keep (entities + key fields), one or two lines.',
    '- workflow: the main flow across turns, one or two lines.',
    '- interfaces: what humans/other systems interact with it through (a UI shape, a file drop, an API), one line.',
    '',
    `Requirement: ${requirement}`,
  ].join('\n')
  const j = await callJson(ctx, prompt, model, config)
  return {
    purpose: String(j.purpose ?? ''),
    capabilities: Array.isArray(j.capabilities) ? (j.capabilities as Array<Record<string, unknown>>).map((c) => ({ name: String(c.name ?? ''), why: String(c.why ?? '') })).filter((c) => c.name !== '') : [],
    dataModel: String(j.dataModel ?? ''),
    workflow: String(j.workflow ?? ''),
    interfaces: String(j.interfaces ?? ''),
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
