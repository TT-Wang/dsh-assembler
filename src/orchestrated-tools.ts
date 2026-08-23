/**
 * 编排模式(B 臂):assembler 退成"零件专家",编排智力归主 agent。
 *
 * A/B 实验设计定稿见 docs/ab-orchestrated-mode.md(用户裁定 2026-08-23):
 * assembler 是插件,插件就该做一项工作——它的一项工作是**零件专业**:
 *
 *   match_catalog  唯一的智力工作:架构需求 → 零件映射(它是唯一认识零件库的人)
 *   emit_preset    哑工具:确定性印刷 + 全部闸门,零智力(cordis 物理:serverName
 *                  代际哈希必须由确定性代码执行,主 agent 手写文件一次就撞代际)
 *   verify_preset  独立考官:黑盒探针,主 agent 可调、可拿证据,不能判卷;
 *                  **不自动重试**——FAIL 带证据返回,外科决策归主 agent
 *
 * 架构 spec、persona、stateSchema、命名、缺件处置、重试策略全归主 agent(编排者)。
 * 流程契约走两条腿:工具描述(教流程)+ 结果尾部的接力棒段落(决策点上的新鲜
 * 契约,市场战役 F6 证明比工具描述里的陈年一句可靠)。
 *
 * flag:DSH_ASSEMBLER_MODE=orchestrated 才注册这三件,且**不注册** assemble/
 * assemble_solution(两臂互斥,A/B 数据才干净)。验收机器与 A 臂共用同一套
 * (runProbe/runScenario/validateArchProbe/marksPresent)——两臂同一张考卷。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import yaml from 'js-yaml'
import {
  catalogChain, catalogIdsHash, collectRequiredSecrets, emitPreset, federateMcpTools,
  installKnowledgePacks, installStateEquipment, knowledgeLocatorText, loadCatalog,
  personaFromPresetText, presetSha, reconcileCapabilityIds, renderPartsLock, resolvePersonaText,
  sameConceptOnDisk, sanitizePresetName, screenParams, writeGapWorkOrders, writePresetFile,
  loadVerifyLedger, saveVerifyLedger, carryDecision, VERIFY_CARRY_TTL_MS, lintPersona,
  type CapabilityEntry, type Catalog, type Config, type MissingDraft,
} from './index.js'
import {
  AUX_CALL_TIMEOUT_MS, PROBE_TURN_BUDGET_MS, addUsage, deriveProbePlan, parseModelJson,
  runFrontendGate, runProbe, runScenario, sanitizeMarks, usageDetail,
  type AuxUsage, type ProbePlan, type ProbeResult,
} from './verify.js'
import { validateArchProbe } from './arch-spec.js'
import { rankCapabilities } from './capability-index.js'
import { DEFAULT_FRONTEND_TEMPLATE, FRONTEND_ROUTE, emitFrontend } from './frontend.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const MATCH_TOOL_NAME = 'match_catalog'
export const EMIT_TOOL_NAME = 'emit_preset'
export const VERIFY_TOOL_NAME = 'verify_preset'
export const DRAFT_TOOL_NAME = 'draft_assembly'
export const ASK_TOOL_NAME = 'ask_catalog'
export const SEARCH_TOOL_NAME = 'search_catalog'

/**
 * 装配器与主 agent 的配合形态(host 级环境变量,一臂一台 host,互不污染):
 *  pipeline     A 臂现状:assemble/assemble_solution 一条龙(默认)。
 *  orchestrated B 臂:主 agent 画图纸,match_catalog 映射 + 哑发射 + 独立考官。
 *  draft        C 臂"提案审阅制":draft_assembly 一次调用出完整方案书(架构+选型+
 *               persona+schema+探针草图),主 agent 红笔审阅后发射验收。
 *  dialogue     D 臂"对话式专家":B 的三工具 + ask_catalog 自由问答。
 *  search       F 臂"纯检索制":search_catalog 机械检索(零 LLM),选型智力
 *               全归主 agent,发射验收照旧。
 */
export type AssemblerMode = 'pipeline' | 'orchestrated' | 'draft' | 'dialogue' | 'search'

export function assemblerMode(): AssemblerMode {
  const m = process.env.DSH_ASSEMBLER_MODE
  return m === 'orchestrated' || m === 'draft' || m === 'dialogue' || m === 'search' ? m : 'pipeline'
}

/** 兼容旧名:B 臂判定。 */
export function orchestratedMode(): boolean {
  return assemblerMode() === 'orchestrated'
}

// ── 共享小件 ────────────────────────────────────────────────────────────────

function presetRootOf(config: Config): string {
  return config.presetRoot ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.agent-presets')
}

/** 本地时间戳(与 assemble 的直播台同款:给盯着屏幕的人看,不用 UTC)。 */
function stamp(): string {
  const d = new Date()
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

/** 往 preset 的 progress.log 追加一行(装配直播台轮询这份文件)。失败静默。 */
function progressAppend(dir: string, line: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'progress.log'), `${stamp()} ${line}\n`)
  } catch { /* 直播是加速器不是必需品 */ }
}

/** B 臂账本:每次工具调用一行(A/B 分析的数据面)。写失败绝不影响工具。 */
function appendOrchLedger(record: Record<string, unknown>): void {
  try {
    const dir = join(REPO, 'ledger')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'orchestrated.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`)
  } catch (error: unknown) {
    console.error(`[assembler] orchestrated ledger write failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** jobs 直播(assemble-tool 同款形态):长工具把 phase 滚进 host 的活通道。 */
function startJob(ctx: Context, kind: string, label: string): {
  phase: (line: string) => void
  settle: (status: 'completed' | 'failed', detail?: string) => void
  lines: string[]
} {
  const lines: string[] = []
  let pending: string[] = []
  let done: ((o: { status: 'completed' | 'failed'; detail?: string }) => void) | undefined
  const jobs = ctx.get('jobs') as undefined | {
    start(spec: { kind: string; label: string; run: () => { cancel: () => void; done: Promise<{ status: 'completed' | 'failed'; detail?: string }>; readOutput: () => string } }): unknown
  }
  try {
    jobs?.start({
      kind,
      label,
      run: () => ({
        cancel: () => { done?.({ status: 'completed', detail: '进度跟踪被终止(工具仍在完成)' }); done = undefined },
        done: new Promise((resolve) => { done = resolve }),
        readOutput: () => {
          const out = pending.join('\n')
          pending = []
          return out === '' ? '' : `${out}\n`
        },
      }),
    })
  } catch { /* jobs 是叙事通道,不是构建依赖 */ }
  return {
    phase: (line: string): void => { lines.push(line); pending.push(line) },
    settle: (status, detail): void => { done?.({ status, ...(detail !== undefined ? { detail } : {}) }); done = undefined },
    lines,
  }
}

/** 与 llmMapRequirement 同款的辅助调用纪律(flash 钉模型、档位归 auxReasoningEffort)。 */
async function callAux(ctx: Context, label: string, prompt: string, config: Config, onUsage?: (u: AuxUsage) => void): Promise<Record<string, unknown>> {
  const selection = (ctx.get('agentDefaultModel') as { currentSelection?: () => { provider?: string } | undefined } | undefined)?.currentSelection?.()
  const request: GenerateOptions = {
    provider: config.provider ?? selection?.provider ?? 'deepseek-official',
    model: config.model ?? 'deepseek-v4-flash',
    ...(config.auxReasoningEffort !== undefined ? { reasoningEffort: config.auxReasoningEffort as GenerateOptions['reasoningEffort'] } : {}),
    messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })],
    ...(AUX_CALL_TIMEOUT_MS > 0 ? { signal: AbortSignal.timeout(AUX_CALL_TIMEOUT_MS) } : {}),
  }
  const assembler = new BlockAssembler()
  const usage: AuxUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 }
  for await (const chunk of ctx.llm.stream(request)) {
    addUsage(usage, chunk)
    assembler.push(chunk)
  }
  onUsage?.(usage)
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new Error(`${label}: model call ${finish.kind}: ${finish.failure.message}`)
  }
  let text = ''
  for (const block of assembler.message().content) if (block.type === 'text') text += block.text
  return parseModelJson(text)
}

/** 自由文本辅助调用(D 臂问答用):同一套纪律,但不解析 JSON,原文返回。 */
async function callAuxText(ctx: Context, label: string, prompt: string, config: Config, onUsage?: (u: AuxUsage) => void): Promise<string> {
  const selection = (ctx.get('agentDefaultModel') as { currentSelection?: () => { provider?: string } | undefined } | undefined)?.currentSelection?.()
  const request: GenerateOptions = {
    provider: config.provider ?? selection?.provider ?? 'deepseek-official',
    model: config.model ?? 'deepseek-v4-flash',
    ...(config.auxReasoningEffort !== undefined ? { reasoningEffort: config.auxReasoningEffort as GenerateOptions['reasoningEffort'] } : {}),
    messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })],
    ...(AUX_CALL_TIMEOUT_MS > 0 ? { signal: AbortSignal.timeout(AUX_CALL_TIMEOUT_MS) } : {}),
  }
  const assembler = new BlockAssembler()
  const usage: AuxUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 }
  for await (const chunk of ctx.llm.stream(request)) {
    addUsage(usage, chunk)
    assembler.push(chunk)
  }
  onUsage?.(usage)
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new Error(`${label}: model call ${finish.kind}: ${finish.failure.message}`)
  }
  let text = ''
  for (const block of assembler.message().content) if (block.type === 'text') text += block.text
  return text.trim()
}

// ── match_catalog:纯件(单测覆盖)────────────────────────────────────────────

/** 主 agent 递进来的架构 spec(deriveArchSpec 同形;capabilities 也容忍纯字符串)。 */
export interface OrchSpec {
  capabilities: Array<{ name: string; why: string }>
  dataModel: string
  workflow: string
  interfaces: string
}

/** 宽进严出:字符串数组/{name,why} 混合都收,归一成 OrchSpec;没有能力清单 = null。 */
export function normalizeSpecInput(raw: unknown): OrchSpec | null {
  const o = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const caps: Array<{ name: string; why: string }> = []
  for (const c of Array.isArray(o.capabilities) ? o.capabilities : []) {
    if (typeof c === 'string' && c.trim() !== '') caps.push({ name: c.trim(), why: '' })
    else if (c !== null && typeof c === 'object') {
      const name = String((c as Record<string, unknown>).name ?? '').trim()
      if (name !== '') caps.push({ name, why: String((c as Record<string, unknown>).why ?? '').trim() })
    }
  }
  if (caps.length === 0) return null
  return {
    capabilities: caps,
    dataModel: String(o.dataModel ?? '').trim(),
    workflow: String(o.workflow ?? '').trim(),
    interfaces: String(o.interfaces ?? '').trim(),
  }
}

/**
 * 匹配 prompt:llmMapRequirement 的瘦身版——**只出映射**。persona/name/stateSchema/
 * 前端形状选择的智力全删(归主 agent),保留的每条规则都是战役实证:GAP DISCIPLINE
 * (F14 缺口误报比漏报贵)、UI≠browser(F3)、逐条覆盖或标缺口(架构优先的核心)。
 */
export function buildMatchPrompt(requirement: string, spec: OrchSpec, catalog: Catalog): { prompt: string; ids: string[] } {
  const usable = catalog.capabilities.filter((c) => c.config?.enabled !== false)
  const ids = usable.map((c) => c.id)
  const tagsIndex = usable.map((c) => `${c.id}: ${c.tags.join(', ')} — ${c.description}`).join('\n')
  const need = spec.capabilities.map((c, i) => `${String(i + 1)}. ${c.name}${c.why !== '' ? ` — ${c.why}` : ''}`).join('\n')
  const prompt = [
    'You are the CATALOG EXPERT of an agent-assembly system. The ORCHESTRATOR (the calling agent) already designed this agent\'s architecture; your ONLY job is to map each architectural need onto the parts catalog. You do NOT write personas, schemas, names, or UIs — the orchestrator does.',
    '',
    'Architectural needs (from the orchestrator\'s spec):',
    need,
    spec.dataModel !== '' ? `Data model: ${spec.dataModel}` : '',
    spec.interfaces !== '' ? `Interfaces: ${spec.interfaces}` : '',
    '',
    'Catalog:',
    tagsIndex,
    '',
    'Rules:',
    '- Respond with JSON only: {"coverage":[{"need":"...","capabilityId":"..."|null,"gap":"..."}],"extraIds":[...],"missingEntries":[...]}',
    '- coverage MUST have exactly one row per architectural need above, in the same order. capabilityId is the ONE catalog id that covers the need; when NOTHING covers it, capabilityId is null and "gap" is a GENERIC one-line description of the missing capability.',
    `- Every capabilityId must come from this exact set: ${ids.join(', ')}`,
    '- GAP DISCIPLINE: before marking any need null, exhaustively check the catalog for an existing part covering it under another name — persistent state/ledgers → the SQLite parts; saving/reading workspace files → the filesystem parts; searching/citing imported docs → the kb/fs-search entries; document output → the docx/pdf/excel parts. Mark a gap ONLY when nothing plausibly covers it, and NEVER invent vendor-specific ids — describe the missing capability generically.',
    '- A need mentioning 网页/页面/看板/面板 usually means the DELIVERED web UI — cover it with EXACTLY ONE via:"frontend" template id whose interaction SHAPE fits (form submission → form desk; records & queries → data desk; metrics overview → dashboard; plain conversation → chat console). Do NOT select browser-automation/http parts for it; those are only for the AGENT itself visiting EXTERNAL sites. When the Interfaces line implies a UI but no need row says so, put the frontend id in extraIds instead.',
    '- extraIds: catalog ids needed beyond the listed needs — a domain persona/baseline entry that clearly matches this agent\'s domain, or the frontend template per the rule above. Empty array when none.',
    '- For every null coverage row, add one entry to "missingEntries": {id, via, description, tags, tool?, mount?} — id kebab-case; via "package" | "harness" | "mcp"; when you know a harness plugin package providing it, set mount.name, else omit mount. Empty array when nothing is missing.',
    '',
    `Requirement (context only — the needs list above is authoritative): ${requirement}`,
  ].filter((s) => s !== '').join('\n')
  return { prompt, ids }
}

export interface MatchOutcome {
  coverage: Array<{ need: string; capabilityId: string | null; gap?: string }>
  capabilityIds: string[]
  missing: string[]
  missingEntries: MissingDraft[]
  extraIds: string[]
}

/** 单个 id 的容错调和:调和不上返回 null(→ 该行按缺口处理),绝不炸整次匹配。 */
function tryReconcileOne(id: string, catalogIds: readonly string[]): string | null {
  try {
    return reconcileCapabilityIds([id], catalogIds)[0] ?? null
  } catch {
    return null
  }
}

/**
 * 匹配响应的机械整形:逐行调和 id(机械近似修复,同 reconcileCapabilityIds 纪律)、
 * 调和不上的行降级为缺口、missing 从 null 行派生(单一事实源)、missingEntries
 * 过形状闸。纯函数,单测覆盖。
 */
export function parseMatchResponse(parsed: Record<string, unknown>, catalogIds: readonly string[], needs: readonly string[]): MatchOutcome {
  const rows = Array.isArray(parsed.coverage) ? parsed.coverage as Array<Record<string, unknown>> : []
  const coverage: MatchOutcome['coverage'] = []
  for (const [i, row] of rows.entries()) {
    const need = String(row.need ?? needs[i] ?? '').trim()
    if (need === '') continue
    const rawId = typeof row.capabilityId === 'string' && row.capabilityId.trim() !== '' ? row.capabilityId.trim() : null
    const hit = rawId === null ? null : tryReconcileOne(rawId, catalogIds)
    const gap = String(row.gap ?? '').trim()
    coverage.push({
      need,
      capabilityId: hit,
      // 模型给了 id 但目录里没有 → 这行如实降级成缺口(id 是编的,当选中就是雪花)。
      ...(hit === null ? { gap: gap !== '' ? gap : need } : {}),
    })
  }
  // 模型漏行(coverage 少于需求数):漏掉的需求按缺口补齐——逐条覆盖或标缺口,
  // 绝不静默丢(架构优先的全部意义就在这条)。
  for (let i = coverage.length; i < needs.length; i++) {
    coverage.push({ need: needs[i], capabilityId: null, gap: needs[i] })
  }
  const extraIds = (Array.isArray(parsed.extraIds) ? parsed.extraIds as unknown[] : [])
    .map((x) => tryReconcileOne(String(x), catalogIds))
    .filter((x): x is string => x !== null)
  const capabilityIds = [...new Set([
    ...coverage.map((r) => r.capabilityId).filter((x): x is string => x !== null),
    ...extraIds,
  ])]
  const missing = coverage.filter((r) => r.capabilityId === null).map((r) => r.gap ?? r.need)
  const missingEntries: MissingDraft[] = (Array.isArray(parsed.missingEntries) ? parsed.missingEntries as Array<Record<string, unknown>> : [])
    .filter((e) => typeof e.id === 'string' && e.id !== '' && typeof e.description === 'string'
      && (e.via === 'package' || e.via === 'harness' || e.via === 'mcp'))
    .map((e) => ({
      id: String(e.id),
      via: e.via as MissingDraft['via'],
      description: String(e.description),
      tags: Array.isArray(e.tags) ? (e.tags as unknown[]).map(String) : [],
      ...(typeof e.tool === 'string' ? { tool: e.tool } : {}),
      ...(e.mount !== null && typeof e.mount === 'object' && typeof (e.mount as Record<string, unknown>).name === 'string'
        ? { mount: { name: String((e.mount as Record<string, unknown>).name), ...(typeof (e.mount as Record<string, unknown>).config === 'object' && (e.mount as Record<string, unknown>).config !== null ? { config: (e.mount as Record<string, unknown>).config as Record<string, unknown> } : {}) } }
        : {}),
    }))
  return { coverage, capabilityIds, missing, missingEntries, extraIds }
}

// ── emit_preset:纯件(单测覆盖)──────────────────────────────────────────────

export interface EmitArgs {
  name: string
  requirement: string
  capabilityIds: string[]
  persona: string
  stateSchema?: string
  params: Record<string, string>
  missing: string[]
  missingEntries: MissingDraft[]
  fresh: boolean
  /** 方案共享库(多 agent 班子):绝对路径;每台 agent 的 SQLite 默认库钉到同一份。 */
  sharedDb?: string
}

/**
 * emit_preset 入参的机械校验(哑工具的第一道门):缺什么直接报错让编排者补,
 * 绝不替它猜。persona 必填是刻意的——组装决策归主 agent,没有 persona 的调用
 * 就是没做完组装决策。
 */
export function validateEmitArgs(raw: unknown): EmitArgs {
  const a = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const name = typeof a.name === 'string' ? a.name.trim() : ''
  if (name === '' || sanitizePresetName(name) === '') {
    throw new Error('emit_preset 需要 "name":kebab-case 的 preset 名(组装决策归你——名字你定)')
  }
  const requirement = typeof a.requirement === 'string' ? a.requirement.trim() : ''
  if (requirement === '') {
    throw new Error('emit_preset 需要 "requirement":这个 agent 是干什么的(进 BOM 与 roster 描述)')
  }
  const capabilityIds = (Array.isArray(a.capabilityIds) ? a.capabilityIds : []).map(String).filter((s) => s.trim() !== '')
  if (capabilityIds.length === 0) {
    throw new Error('emit_preset 需要 "capabilityIds":match_catalog 给出的零件 id 清单(可增删——组装决策归你)')
  }
  const persona = typeof a.persona === 'string' ? a.persona.trim() : ''
  if (persona === '') {
    throw new Error('emit_preset 需要 "persona":你为这个 agent 写的 system persona(角色/语气/工具纪律/持久化约束/安全边界;写成随时可判的约束,禁止"第一步…第二步…"编舞)')
  }
  const params: Record<string, string> = {}
  if (a.params !== null && typeof a.params === 'object') {
    for (const [k, v] of Object.entries(a.params as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params[k] = String(v)
    }
  }
  const missingEntries: MissingDraft[] = (Array.isArray(a.missingEntries) ? a.missingEntries as Array<Record<string, unknown>> : [])
    .filter((e) => typeof e.id === 'string' && typeof e.description === 'string'
      && (e.via === 'package' || e.via === 'harness' || e.via === 'mcp'))
    .map((e) => ({
      id: String(e.id), via: e.via as MissingDraft['via'], description: String(e.description),
      tags: Array.isArray(e.tags) ? (e.tags as unknown[]).map(String) : [],
      ...(typeof e.tool === 'string' ? { tool: e.tool } : {}),
      ...(e.mount !== null && typeof e.mount === 'object' && typeof (e.mount as Record<string, unknown>).name === 'string'
        ? { mount: { name: String((e.mount as Record<string, unknown>).name) } } : {}),
    }))
  const missing = (Array.isArray(a.missing) ? a.missing : []).map(String).filter((s) => s.trim() !== '')
  const sharedDb = typeof a.sharedDb === 'string' ? a.sharedDb.trim() : ''
  if (sharedDb !== '' && !sharedDb.startsWith('/')) {
    throw new Error('emit_preset: "sharedDb" 必须是绝对路径(相对路径会解析进零件进程 cwd,五台 preset 的表混进同一个错文件——实测教训)')
  }
  return {
    name, requirement, capabilityIds, persona,
    ...(typeof a.stateSchema === 'string' && a.stateSchema.trim() !== '' ? { stateSchema: a.stateSchema } : {}),
    params,
    missing: missing.length > 0 ? missing : missingEntries.map((e) => e.description),
    missingEntries,
    fresh: a.fresh === true,
    ...(sharedDb !== '' ? { sharedDb } : {}),
  }
}

// ── verify_preset:纯件(单测覆盖)────────────────────────────────────────────

/** 编排者递来的探针草图,归一成 validateArchProbe 吃的形状;kind 缺省按字段推断。 */
export function normalizeProbeSketch(raw: unknown): { kind: 'scenario' | 'single'; createTask?: string; retrieveTask?: string; token?: string; task?: string; marks?: string[] } | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const marks = Array.isArray(o.marks) ? (o.marks as unknown[]).map(String) : undefined
  const kind = o.kind === 'single' || o.kind === 'scenario'
    ? o.kind
    : (typeof o.createTask === 'string' && o.createTask !== '' ? 'scenario' : 'single')
  return {
    kind,
    ...(typeof o.createTask === 'string' ? { createTask: o.createTask } : {}),
    ...(typeof o.retrieveTask === 'string' ? { retrieveTask: o.retrieveTask } : {}),
    ...(typeof o.token === 'string' ? { token: o.token } : {}),
    ...(typeof o.task === 'string' ? { task: o.task } : {}),
    ...(marks !== undefined ? { marks } : {}),
  }
}

// ── 工具 1:match_catalog ────────────────────────────────────────────────────

export function matchCatalogToolDefinition(ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: MATCH_TOOL_NAME,
    description:
      'ORCHESTRATED ASSEMBLY step 2 of 4 (you are the orchestrator; this assembler only knows the parts catalog). '
      + 'Step 1 is YOURS: when the user asks to build an agent, first design its architecture IN THE CONVERSATION — '
      + 'purpose, the FULL list of capabilities it architecturally needs (generic descriptions with why, storage/retrieval/export included), '
      + 'data model, main workflow, interfaces — and show it to the user so they can correct it BEFORE assembly. '
      + 'Then call this tool with that spec: it maps EACH architectural need onto the parts catalog and returns, per need, '
      + 'a capability id or a GAP. It does NOT write personas/schemas/names and does NOT assemble anything — '
      + 'after it returns, YOU make the assembly decisions and call emit_preset, then verify_preset. '
      + 'Never invent capability ids yourself: this catalog is the assembler\'s territory.',
    parameters: {
      requirement: {
        type: 'string',
        description: 'The user\'s full natural-language requirement for the agent (context for the mapping).',
        required: true,
      },
      spec: {
        type: 'object',
        additionalProperties: false,
        description: 'Your architecture spec for this agent (design it FIRST, without looking at any catalog).',
        properties: {
          capabilities: {
            type: 'array',
            description: 'FULL list of architectural needs, each {name, why} with a GENERIC description (e.g. "persist records across sessions"). Be exhaustive — a need you omit here can never be flagged as a gap.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', description: 'generic capability description', required: true },
                why: { type: 'string', description: 'why this agent needs it' },
              },
            },
          },
          dataModel: { type: 'string', description: 'entities + key fields it must keep, one or two lines' },
          workflow: { type: 'string', description: 'the main flow across turns, one or two lines' },
          interfaces: { type: 'string', description: 'what humans/systems interact through (UI shape, file drop, API), one line' },
        },
        required: true,
      },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown): Promise<string> => {
      const a = args as { requirement?: unknown; spec?: unknown } | null
      const requirement = typeof a?.requirement === 'string' ? a.requirement.trim() : ''
      const spec = normalizeSpecInput(a?.spec)
      if (requirement === '' || spec === null) {
        throw new Error('match_catalog needs {"requirement": "...", "spec": {"capabilities": [{"name","why"}...], "dataModel", "workflow", "interfaces"}} — design the architecture first (that is your job), then bring it here for mapping.')
      }
      const t0 = Date.now()
      const job = startJob(ctx, 'match-catalog', `目录匹配(${String(spec.capabilities.length)} 项架构需求)`)
      try {
        const catalog = await federateMcpTools(loadCatalog(config.catalogPath ?? join(REPO, 'capabilities.yml')))
        job.phase(`零件联邦就绪:${String(catalog.capabilities.length)} 条可装配`)
        const { prompt, ids } = buildMatchPrompt(requirement, spec, catalog)
        job.phase('目录匹配推理中(仅"需求→零件"映射,无 persona/schema)…')
        let usage: AuxUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 }
        const parsed = await callAux(ctx, MATCH_TOOL_NAME, prompt, config, (u) => { usage = u })
        const outcome = parseMatchResponse(parsed, ids, spec.capabilities.map((c) => c.name))
        const elapsed = Math.round((Date.now() - t0) / 1000)
        job.settle('completed', `${String(outcome.capabilityIds.length)} 零件 / ${String(outcome.missing.length)} 缺口`)
        appendOrchLedger({
          tool: MATCH_TOOL_NAME, requirement, needs: spec.capabilities.length,
          selected: outcome.capabilityIds, missing: outcome.missing, elapsedSeconds: elapsed,
          usage: { out: usage.outputTokens, reason: usage.reasoningTokens, cache: usage.cacheReadTokens },
          catalogSize: catalog.capabilities.length,
        })
        const byId = new Map(catalog.capabilities.map((c) => [c.id, c]))
        const rows = outcome.coverage.map((r, i) => r.capabilityId !== null
          ? `  ${String(i + 1)}. ${r.need} → ${r.capabilityId}(${byId.get(r.capabilityId)?.via ?? '?'})`
          : `  ${String(i + 1)}. ${r.need} → 【缺口】${r.gap ?? ''}`).join('\n')
        const extraLine = outcome.extraIds.length > 0 ? `\n额外零件(域基线/前端模板):${outcome.extraIds.join(', ')}` : ''
        const detail = usageDetail(usage)
        return `目录匹配完成:${String(spec.capabilities.length)} 项架构需求 → ${String(outcome.capabilityIds.length)} 个零件 / ${String(outcome.missing.length)} 项缺口(${String(elapsed)}s${detail !== '' ? `,${detail}` : ''})\n`
          + `覆盖明细:\n${rows}${extraLine}\n`
          + `选中零件 capabilityIds:${outcome.capabilityIds.join(', ')}\n`
          + (outcome.missingEntries.length > 0 ? `缺件草案 missingEntries:${JSON.stringify(outcome.missingEntries)}\n` : '')
          + [
            '',
            '【接力棒——编排者是你,匹配到此为止】',
            '- 组装决策归你,现在做:写 persona(角色/语气/工具纪律/跨轮持久化约束/该领域的安全合规边界;写成随时可判的约束,禁止"第一步…第二步…"编舞);数据要跨会话留存则设计 stateSchema(只许幂等 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS,英文列名、合理主键,按你 spec 的 dataModel 一比一落表);给 preset 起 kebab-case 名。',
            '- 然后调 emit_preset(name, requirement, capabilityIds, persona[, stateSchema][, params][, missing, missingEntries])发射;发射后必须调 verify_preset 独立验收——你不能自己宣布 agent 可用。',
            ...(outcome.missing.length > 0 ? ['- 缺口处置归你:或先照工单造件入库再装(emit 后 gaps/ 有施工单),或先装配、把缺口如实告知用户。'] : []),
            '- 注意:若选中零件自带目录手写 persona(域验证过的安全文本),发射时它优先于你写的。',
          ].join('\n')
      } catch (error: unknown) {
        job.settle('failed', error instanceof Error ? error.message.slice(0, 120) : String(error))
        throw error
      }
    },
  })
}

// ── 工具 2:emit_preset ──────────────────────────────────────────────────────

export function emitPresetToolDefinition(ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: EMIT_TOOL_NAME,
    description:
      'ORCHESTRATED ASSEMBLY step 3 of 4: the DUMB deterministic printer. YOU already made the assembly decisions '
      + '(capabilityIds from match_catalog — you may add/remove; persona YOU wrote; stateSchema YOU designed when state must persist; the preset name). '
      + 'This tool only prints them into a mountable preset with every gate intact: secret-shaped params refused, YAML parse gate, '
      + 'idempotent-DDL double-execution gate, persona lint, byte-deterministic serverNames, BOM (parts.lock.yml), gap work-orders. '
      + 'It makes NO decisions and runs NO verification — after it returns you MUST call verify_preset. '
      + 'NEVER hand-write or edit preset files yourself (the host pins mounted server names to file bytes; a hand edit collides its own generation) — '
      + 'any change means calling emit_preset again with the same name.',
    parameters: {
      name: { type: 'string', description: 'kebab-case preset id YOU chose, e.g. "expense-tracker"', required: true },
      requirement: { type: 'string', description: 'what this agent is for (goes into the BOM and roster description)', required: true },
      capabilityIds: {
        type: 'array',
        description: 'final capability ids to mount (start from match_catalog\'s list; adding ids not in the catalog fails loudly)',
        items: { type: 'string' },
        required: true,
      },
      persona: { type: 'string', description: 'the system persona YOU wrote for this agent (role, tone, tool discipline, durability constraint when state parts are mounted, domain safety boundaries; judgeable constraints only — never numbered procedures)', required: true },
      stateSchema: { type: 'string', description: 'optional idempotent SQLite DDL (only CREATE TABLE/INDEX IF NOT EXISTS) pre-building this agent\'s tables; required in practice whenever a SQLite part is selected — design it from your data model' },
      params: { type: 'object', additionalProperties: true, description: 'optional NON-SECRET deployment parameters (flat string map, e.g. {"timezone":"Asia/Shanghai"}); secret-shaped keys are refused by design — credentials go to host env' },
      missing: { type: 'array', items: { type: 'string' }, description: 'optional: the gap descriptions from match_catalog (recorded in the BOM so re-assembly notices when the catalog grows)' },
      missingEntries: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'optional: match_catalog\'s missingEntries verbatim — each becomes a gap work-order under the preset\'s gaps/' },
      fresh: { type: 'boolean', description: 'set true ONLY to overwrite an existing preset of the SAME NAME that carries a DIFFERENT concept (the tool refuses silently repurposing a name)' },
      sharedDb: { type: 'string', description: 'ADVANCED, multi-agent suites only: ABSOLUTE path of a shared SQLite database file; every suite member emitted with the same path reads/writes one ledger. Include the shared tables (idempotent DDL) in EACH member\'s stateSchema — they materialize on first open.' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown): Promise<string> => {
      const t0 = Date.now()
      const input = validateEmitArgs(args)
      const screened = screenParams(input.params)
      const catalogPath = config.catalogPath ?? join(REPO, 'capabilities.yml')
      const catalog = await federateMcpTools(loadCatalog(catalogPath))
      const catalogIds = catalog.capabilities.filter((c) => c.config?.enabled !== false).map((c) => c.id)
      // 调和闸:主 agent 传来的 id 走同一条机械修复;全都不存在 → 大声失败。
      const ids = reconcileCapabilityIds(input.capabilityIds, catalogIds)
      const presetRoot = presetRootOf(config)
      const id = sanitizePresetName(input.name)
      const dir = join(presetRoot, id)
      // 同名占用裁决(A 臂同款三选一,治 F1 静默铸 -2 病):同概念 → 原地重发;
      // 异概念 → 没有 fresh 就拒绝。
      if (existsSync(join(dir, 'agent.cordis.yml'))) {
        const sameConcept = sameConceptOnDisk({ name: id, requirement: input.requirement, params: screened.accepted, presetRoot })
        if (!sameConcept && !input.fresh) {
          throw new Error(
            `emit_preset: preset 名「${id}」已存在,且承载的是另一个需求。三选一:换名字;确定覆盖旧概念就传 "fresh": true;或先问用户。绝不静默铸「${id}-2」。`,
          )
        }
      }
      mkdirSync(dir, { recursive: true })
      progressAppend(dir, `══ emit_preset ${id}(编排模式:发射归我,决策归编排者)══`)
      const byId = new Map(catalog.capabilities.map((c) => [c.id, c]))
      const selected = ids.map((cid) => byId.get(cid)).filter((c): c is CapabilityEntry => c !== undefined)
      const knowledge = installKnowledgePacks(selected, dir, dirname(catalogPath))
      if (knowledge.length > 0) progressAppend(dir, `知识包已随 preset 安装:${knowledge.map((k) => k.id).join('、')}`)
      const equipment = installStateEquipment({
        ...(input.stateSchema !== undefined ? { stateSchema: input.stateSchema } : {}),
        selected,
        dir,
        ...(input.sharedDb !== undefined ? { sharedDb: input.sharedDb } : {}),
      })
      if (equipment !== null) progressAppend(dir, '装备已发射:预建数据库 schema(equipment/init.sql,双次执行门 PASS)')
      const req = {
        capabilityIds: ids,
        params: screened.accepted,
        missing: input.missing,
        rationale: '编排模式:选型映射来自 match_catalog,组装决策来自编排者',
        persona: input.persona,
        ...(input.stateSchema !== undefined ? { stateSchema: input.stateSchema } : {}),
        missingEntries: input.missingEntries,
      }
      const template = readFileSync(config.templatePath ?? join(REPO, 'presets', 'agent-template.yml'), 'utf8')
      const preset = emitPreset(req, catalog, template, id, knowledgeLocatorText(knowledge) + (equipment?.personaText ?? ''), equipment?.extraServerEnv, join(dir, 'workspace'))
      writePresetFile(join(dir, 'agent.cordis.yml'), preset)
      writeFileSync(join(dir, 'preset.yml'), yaml.dump({ name: id, description: input.requirement.replace(/\s+/g, ' ').trim().slice(0, 140) }, { lineWidth: -1 }))
      progressAppend(dir, `preset 已发射:${id}`)
      // 前端:选中 via:'frontend' 用其模板,否则兜底聊天台(每台 agent 都有脸)。
      let frontendInfo: { template: string; url?: string; path: string } | null = null
      try {
        const feCap = selected.find((c) => c.via === 'frontend')
        const fe = emitFrontend({ template: (feCap?.config?.template as string | undefined) ?? DEFAULT_FRONTEND_TEMPLATE, presetDir: dir, presetId: id, requirement: input.requirement, workdir: join(dir, 'workspace') })
        mkdirSync(join(dir, 'workspace'), { recursive: true })
        mkdirSync(join(dir, 'kb'), { recursive: true })
        const port = (ctx.get?.('webServer') as { port?: number } | undefined)?.port
        frontendInfo = {
          template: fe.template,
          path: join(dir, 'frontend', 'index.html'),
          ...(port !== undefined ? { url: `http://127.0.0.1:${String(port)}${FRONTEND_ROUTE}/${id}` } : {}),
        }
        if (fe.changed) progressAppend(dir, `前端已就位:${fe.template}`)
      } catch (error: unknown) {
        console.error(`[assembler] 前端发射失败(发射照常):${error instanceof Error ? error.message : String(error)}`)
      }
      const gapOrders = writeGapWorkOrders({ presetDir: dir, presetId: id, requirement: input.requirement, missingEntries: input.missingEntries })
      if (gapOrders.length > 0) progressAppend(dir, `缺件工单已落盘:${String(gapOrders.length)} 份 → ${join(dir, 'gaps')}/`)
      const requiredSecrets = collectRequiredSecrets(selected, catalog['mcp-servers'] ?? {})
      // BOM:与 A 臂同一台账语义(emitter 代号、缺口、目录指纹全记)。
      const index = catalogChain(catalogPath).flatMap((layer) => {
        const indexPath = join(dirname(layer), 'index', 'catalog.yml')
        if (!existsSync(indexPath)) return []
        const parsedIdx = yaml.load(readFileSync(indexPath, 'utf8'))
        return Array.isArray(parsedIdx) ? parsedIdx as Parameters<typeof renderPartsLock>[0]['index'] : []
      })
      const mcpServersAll = catalog['mcp-servers'] ?? {}
      const hostMounted = Object.keys(mcpServersAll).filter((sv) => mcpServersAll[sv].hostMounted === true)
      const personaFindings = lintPersona(personaFromPresetText(preset) ?? resolvePersonaText(input.persona, selected), selected, hostMounted)
      writeFileSync(join(dir, 'parts.lock.yml'), renderPartsLock({
        presetId: id, requirement: input.requirement, selected, presetText: preset, index,
        personaFindings, params: screened.accepted, requiredSecrets, knowledge,
        ...(equipment !== null ? { equipment: equipment.files } : {}),
        missing: input.missing, catalogIdsHash: catalogIdsHash(catalog),
      }))
      const elapsed = Math.round((Date.now() - t0) / 1000)
      progressAppend(dir, `发射完成(${String(elapsed)}s)——等待独立验收(verify_preset)`)
      appendOrchLedger({
        tool: EMIT_TOOL_NAME, presetId: id, requirement: input.requirement,
        capabilityIds: ids, missing: input.missing, elapsedSeconds: elapsed,
        personaLint: personaFindings.length, gaps: gapOrders.length,
      })
      const secretLines = requiredSecrets.length > 0
        ? `\n所需凭证:${requiredSecrets.map((sec) => `${sec.env}${sec.configured ? '(已配置)' : sec.optional === true ? '(可选,未配则降级)' : '(待配置)'}`).join(';')}(凭证配到 host 环境变量,绝不进装配参数)`
        : ''
      return `preset「${id}」已发射:${ids.join(', ')}(${String(elapsed)}s)\n`
        + `preset 文件:${join(dir, 'agent.cordis.yml')}\n`
        + (frontendInfo !== null ? `前端页面:${frontendInfo.url ?? frontendInfo.path}(模板 ${frontendInfo.template})\n` : '')
        + (equipment !== null ? '装备:预建数据库 schema(equipment/init.sql,双次执行门 PASS)\n' : '')
        + (input.stateSchema !== undefined && equipment === null ? '注意:stateSchema 未落装备(未选 SQLite 零件,或 DDL 未过双次执行门——详见 host 日志)\n' : '')
        + (knowledge.length > 0 ? `知识包:${knowledge.map((k) => `${k.id}(${String(k.docs)} 篇)`).join(';')}\n` : '')
        + (gapOrders.length > 0 ? `缺件工单:${String(gapOrders.length)} 份 → ${join(dir, 'gaps')}/\n` : '')
        + (screened.rejected.length > 0 ? `参数被拒:${screened.rejected.map((r) => `${r.key}(${r.reason})`).join(';')}\n` : '')
        + (personaFindings.length > 0 ? `persona 检查:${personaFindings.map((f) => f.detail).join(';')}\n` : '')
        + secretLines
        + [
          '',
          '【接力棒】',
          `- 发射完成 ≠ 可用。立即调 verify_preset {"presetId": "${id}"} 独立验收(可附上你按主工作流设计的探针草图)。`,
          '- 红线:绝不手改 preset 目录下的任何文件(host 按字节代际挂载,手改必撞名);要改选型/persona/schema,一律重调 emit_preset 同名重发。',
        ].join('\n')
    },
  })
}

// ── 工具 3:verify_preset ────────────────────────────────────────────────────

export function verifyPresetToolDefinition(ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: VERIFY_TOOL_NAME,
    description:
      'ORCHESTRATED ASSEMBLY step 4 of 4: the INDEPENDENT examiner. Runs a black-box acceptance probe against an emitted preset '
      + 'in a REAL session (empty workspace, nobody attending; an agent that asks a human mid-probe FAILS). You may pass a probe sketch — '
      + 'you know the user\'s intent best — but the verdict is the examiner\'s: you cannot grade your own assembly, and this tool NEVER retries. '
      + 'On FAIL it returns the evidence (which turn, which missing mark, what the agent replied) and the surgical decision is YOURS: '
      + 'swap parts and re-emit, build the missing part first, tighten the persona, or report honestly to the user. '
      + 'Sketch rules: invent ALL data inline; scenario shape = turn 1 CREATES the workflow\'s central record carrying an invented token '
      + '(e.g. INV-7781), turn 2 retrieves BY that token WITHOUT restating the stored values; marks are 1-3 content-bearing strings '
      + '(the token / a stored value) — never invented dates as facts, never refusal wording, never UI/page words, never formatted numbers, '
      + 'never long body text that goes to a file (mark the filename instead); size each turn under ~2 minutes. '
      + 'A sketch that fails the mechanical gate falls back to the examiner\'s own derivation. '
      + 'A PASS on unchanged bytes within 7 days is carried from the ledger (honestly labeled); pass reverify=true to force a fresh probe.',
    parameters: {
      presetId: { type: 'string', description: 'the emitted preset id to verify', required: true },
      probe: {
        type: 'object',
        additionalProperties: false,
        description: 'optional probe sketch. Scenario: {"kind":"scenario","createTask":"...","retrieveTask":"...","token":"INV-7781","marks":["..."]}. Single-turn: {"kind":"single","task":"...","marks":["..."]}.',
        properties: {
          kind: { type: 'string', description: '"scenario" (cross-turn state) or "single" (pure compute)' },
          createTask: { type: 'string', description: 'scenario turn 1: one self-sufficient instruction that CREATES the central record, all data invented inline, carrying the token' },
          retrieveTask: { type: 'string', description: 'scenario turn 2: retrieve/use the record BY the token without restating its stored values, and report one specific stored value' },
          token: { type: 'string', description: 'the distinctive invented token both turns carry, e.g. INV-7781' },
          task: { type: 'string', description: 'single-turn: the one instruction' },
          marks: { type: 'array', items: { type: 'string' }, description: '1-3 content-bearing acceptance strings that appear in the reply IFF it truly worked' },
        },
      },
      reverify: { type: 'boolean', description: 'force a fresh probe even when the ledger would carry a same-bytes PASS' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown): Promise<string> => {
      const a = args as { presetId?: unknown; probe?: unknown; reverify?: unknown } | null
      const id = sanitizePresetName(typeof a?.presetId === 'string' ? a.presetId : '')
      if (id === '') throw new Error('verify_preset needs {"presetId": "<emitted preset id>"}')
      const presetRoot = presetRootOf(config)
      const dir = join(presetRoot, id)
      const presetPath = join(dir, 'agent.cordis.yml')
      if (!existsSync(presetPath)) {
        throw new Error(`verify_preset: preset「${id}」不存在(${presetPath})——先用 emit_preset 发射`)
      }
      const t0 = Date.now()
      const job = startJob(ctx, 'verify-preset', `独立验收 ${id}`)
      const phase = (line: string): void => { job.phase(line); progressAppend(dir, line) }
      const settleAndLedger = (outcome: Record<string, unknown>, status: 'completed' | 'failed', detail: string): void => {
        job.settle(status, detail)
        appendOrchLedger({ tool: VERIFY_TOOL_NAME, presetId: id, elapsedSeconds: Math.round((Date.now() - t0) / 1000), ...outcome })
      }
      // lock 是考官的案卷:需求文本(推导回退用)与选型(工具面)都从盘上工件读,
      // 不信调用者的口头转述——考官只认工件。
      let lockRequirement = ''
      let lockIds: string[] = []
      try {
        const lock = (yaml.load(readFileSync(join(dir, 'parts.lock.yml'), 'utf8')) ?? {}) as { requirement?: unknown; parts?: Array<Record<string, unknown>> }
        lockRequirement = typeof lock.requirement === 'string' ? lock.requirement : ''
        lockIds = (Array.isArray(lock.parts) ? lock.parts : []).map((p) => String(p.capability ?? '')).filter((s) => s !== '')
      } catch { /* 无 lock:仍可验收(推导退化为按 preset 文本),但正常发射必有 lock */ }
      const presetText = readFileSync(presetPath, 'utf8')
      const sha = presetSha(presetText)
      const contractPass = [
        '',
        '【接力棒】',
        '- 如实向用户转述验收结论与前端 URL;验收已入台账,同字节 7 天内重验将自动沿用。',
      ].join('\n')
      const contractFail = [
        '',
        '【外科决策归你——考官不重试,证据在上】',
        '- 先诊断再动手:疑零件不匹配 → 调整 capabilityIds 重调 emit_preset(同名重发)再 verify_preset;疑缺件 → 先照 gaps/ 工单造件入库再重发重验;疑 persona 约束不足 → 改 persona 重发重验;修不了或拿不准 → 把失败原因与证据如实报给用户,等定夺。',
        '- 红线:禁止手改 preset 目录文件;禁止绕开 verify_preset 自行开会话"试一下就算过";禁止把 FAIL 转述成通过。',
      ].join('\n')
      try {
        // 增量验收:同字节 + 台账 PASS + 未过期 ⇒ 沿用(明说,绝不冒充新跑)。
        const carry = a?.reverify === true
          ? { carry: false, why: 'reverify 强制重验' }
          : carryDecision(loadVerifyLedger(dir), sha, Date.now(), config.verifyCarryTtlMs ?? VERIFY_CARRY_TTL_MS)
        if (carry.carry) {
          phase(`验收沿用:${carry.why}`)
          settleAndLedger({ status: 'PASS', carried: true }, 'completed', 'PASS(沿用)')
          return `验收 PASS(沿用)——${carry.why}。同字节不重探;强制重验传 {"reverify": true}。${contractPass}`
        }
        const port = (ctx.get?.('webServer') as { port?: number } | undefined)?.port
        if (port === undefined) {
          settleAndLedger({ status: 'SKIPPED', reason: 'headless' }, 'completed', 'SKIPPED')
          return `验收跳过:无 webServer 端口(headless?)——preset 已发射但未经验收,不可当作通过。${contractPass}`
        }
        const catalog = await federateMcpTools(loadCatalog(config.catalogPath ?? join(REPO, 'capabilities.yml')))
        const byId = new Map(catalog.capabilities.map((c) => [c.id, c]))
        const selected = lockIds.map((cid) => byId.get(cid)).filter((c): c is CapabilityEntry => c !== undefined && c.via !== 'frontend')
        const requiredSecrets = collectRequiredSecrets(
          lockIds.map((cid) => byId.get(cid)).filter((c): c is CapabilityEntry => c !== undefined),
          catalog['mcp-servers'] ?? {},
        )
        const missingSecrets = requiredSecrets.filter((sec) => !sec.configured && sec.optional !== true)
        if (missingSecrets.length > 0) {
          const names = missingSecrets.map((sec) => sec.env).join(', ')
          phase(`验收跳过:待配置凭证 ${names}`)
          settleAndLedger({ status: 'SKIPPED', reason: `待配置凭证:${names}` }, 'completed', 'SKIPPED(凭证)')
          return `验收跳过:待配置凭证 ${names}——装配正确但无法实调外部服务;把凭证配到 host 环境变量后重验即可。探针不对未配服务打假拳。${contractPass}`
        }
        // 探针计划:编排者草图优先(过机械闸),不合格/没给 → 考官自己推导。
        let plan: ProbePlan | null = null
        let sketchNote = ''
        const sketch = normalizeProbeSketch(a?.probe)
        if (sketch !== null) {
          plan = validateArchProbe(sketch, sanitizeMarks)
          if (plan !== null) phase('验收探针:编排者草图过机械闸,直接执行(推导 0s)')
          else {
            sketchNote = '(你的探针草图未过机械闸——token 两轮自足/取回轮不复述标记/长度与标记消毒,考官已自行推导)'
            phase('编排者探针草图未过机械闸,考官自行推导…')
          }
        }
        let deriveUsage: AuxUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 }
        if (plan === null) {
          if (selected.length === 0) {
            settleAndLedger({ status: 'ERRORED', reason: 'no lock parts' }, 'failed', 'ERRORED')
            return `验收未能进行:读不到 parts.lock.yml 的选型记录,且没有合格的探针草图。重发一次 emit_preset 或附上探针草图。${contractFail}`
          }
          phase('探针推导中(定单轮或多轮场景)…')
          plan = await deriveProbePlan(ctx, lockRequirement !== '' ? lockRequirement : `preset ${id}`, selected, { provider: config.provider, model: config.model, effort: config.auxReasoningEffort }, (u) => { deriveUsage = u })
        }
        const probeCwd = join(dir, 'workspace')
        mkdirSync(probeCwd, { recursive: true })
        mkdirSync(join(dir, 'kb'), { recursive: true })
        phase(plan.kind === 'scenario'
          ? `验收探针:多轮场景共 ${String(plan.scenario.turns.length)} 轮——探针会话可在侧栏实时旁观`
          : '验收探针:单轮——探针会话可在侧栏实时旁观')
        const timeoutMs = config.verifyTimeoutMs ?? PROBE_TURN_BUDGET_MS
        const verification: ProbeResult = plan.kind === 'scenario'
          ? await runScenario(port, id, plan.scenario, timeoutMs, phase, probeCwd)
          : await runProbe(port, id, plan.probe, timeoutMs, phase, probeCwd)
        // 前端验收(同一张考卷):页面可达门 + 会话环路门。
        let feLine = ''
        if (existsSync(join(dir, 'frontend', 'index.html'))) {
          try {
            const gate = await runFrontendGate(port, id, dir, { loop: true })
            feLine = gate.pass ? `\n前端验收:${gate.reason ?? 'PASS'}` : `\n前端验收:FAIL——${gate.reason ?? ''}`
            phase(gate.pass ? `前端验收:${gate.reason ?? 'PASS'}` : `前端验收:FAIL——${gate.reason ?? ''}`)
          } catch (error: unknown) {
            feLine = `\n前端验收:FAIL——${error instanceof Error ? error.message : String(error)}`
          }
        }
        if (verification.status === 'PASS') {
          try {
            const onDisk = readFileSync(presetPath, 'utf8')
            const summary = verification.kind === 'scenario' ? verification.scenario?.goal : verification.probe?.task
            saveVerifyLedger(dir, {
              presetSha256: presetSha(onDisk), status: 'PASS',
              ...(verification.kind !== undefined ? { kind: verification.kind } : {}),
              verifiedAt: new Date().toISOString(),
              ...(typeof summary === 'string' && summary !== '' ? { summary: summary.slice(0, 120) } : {}),
            })
          } catch (error: unknown) {
            console.error(`[assembler] verify ledger write failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        const elapsed = Math.round((Date.now() - t0) / 1000)
        phase(`验收完成:${verification.status}(${String(elapsed)}s)`)
        settleAndLedger({
          status: verification.status,
          ...(verification.kind !== undefined ? { kind: verification.kind } : {}),
          ...(verification.reason !== undefined ? { reason: verification.reason.slice(0, 200) } : {}),
          sketch: sketch !== null && sketchNote === '',
          derive: { out: deriveUsage.outputTokens, reason: deriveUsage.reasoningTokens },
        }, verification.status === 'PASS' ? 'completed' : 'failed', verification.status)
        const ladder = (verification.turns ?? [])
          .map((t) => `  第${String(t.index)}轮 ${t.pass ? '✓' : '✗'} 「${t.prompt.slice(0, 50)}」标记 [${t.mustInclude.join(', ')}]${t.pass ? '' : `;回复摘录「${t.reply.slice(0, 120)}」`}`)
          .join('\n')
        const detail = usageDetail(deriveUsage)
        const head = `验收 ${verification.status}(${String(elapsed)}s${detail !== '' ? `,推导 ${detail}` : ''})${sketchNote}`
        if (verification.status === 'PASS') {
          const evidence = verification.kind === 'scenario'
            ? `多轮场景「${verification.scenario?.goal.slice(0, 60) ?? ''}」共 ${String(verification.scenario?.turns.length ?? 0)} 轮逐轮通过\n${ladder}`
            : `探针「${verification.probe?.task.slice(0, 80) ?? ''}」通过;验收标记 [${verification.probe?.mustInclude.join(', ') ?? ''}]`
          return `${head} — ${evidence}${feLine}${contractPass}`
        }
        const evidence = verification.kind === 'scenario'
          ? `${verification.reason ?? ''}\n${ladder}`
          : `${verification.reason ?? '回复未含验收标记'};探针「${verification.probe?.task.slice(0, 80) ?? ''}」;标记 [${verification.probe?.mustInclude.join(', ') ?? ''}]${verification.reply !== undefined ? `;回复摘录「${verification.reply.slice(0, 150)}」` : ''}`
        return `${head} — ${evidence}${feLine}${verification.status === 'FAIL' || verification.status === 'ERRORED' ? contractFail : contractPass}`
      } catch (error: unknown) {
        settleAndLedger({ status: 'ERRORED', reason: error instanceof Error ? error.message.slice(0, 200) : String(error) }, 'failed', 'ERRORED')
        throw error
      }
    },
  })
}

// ── C 臂:draft_assembly(提案审阅制)────────────────────────────────────────

/** 方案书(C 臂一次调用的产物):架构 + 选型映射 + 组装决策草案,全部待主 agent 审阅。 */
export interface AssemblyDraft {
  spec: OrchSpec & { purpose: string }
  coverage: MatchOutcome['coverage']
  capabilityIds: string[]
  missing: string[]
  missingEntries: MissingDraft[]
  name: string
  persona: string
  stateSchema?: string
  probe: ReturnType<typeof normalizeProbeSketch>
}

/**
 * 方案书响应的机械整形(纯函数,单测覆盖):spec 宽进、coverage 走 match 同一套
 * id 调和 + 漏行补缺口、persona/name 字符串化、probe 走草图归一。任何字段缺失
 * 都不炸——审阅者(主 agent)看得见空洞,空洞本身就是要红笔的地方。
 */
export function parseDraftResponse(parsed: Record<string, unknown>, catalogIds: readonly string[]): AssemblyDraft {
  const specRaw = parsed.spec !== null && typeof parsed.spec === 'object' ? parsed.spec as Record<string, unknown> : {}
  const spec = normalizeSpecInput(specRaw) ?? { capabilities: [], dataModel: '', workflow: '', interfaces: '' }
  const needs = spec.capabilities.map((c) => c.name)
  const match = parseMatchResponse(parsed, catalogIds, needs)
  return {
    spec: { ...spec, purpose: String(specRaw.purpose ?? '').trim() },
    coverage: match.coverage,
    capabilityIds: match.capabilityIds,
    missing: match.missing,
    missingEntries: match.missingEntries,
    name: sanitizePresetName(String(parsed.name ?? '')),
    persona: String(parsed.persona ?? '').trim(),
    ...(typeof parsed.stateSchema === 'string' && parsed.stateSchema.trim() !== '' ? { stateSchema: parsed.stateSchema.trim() } : {}),
    probe: normalizeProbeSketch(parsed.probe),
  }
}

/** C 臂方案书 prompt:架构师 + 目录映射 + persona/schema/探针起草,合并成一次调用。 */
export function buildDraftPrompt(requirement: string, catalog: Catalog): { prompt: string; ids: string[] } {
  const usable = catalog.capabilities.filter((c) => c.config?.enabled !== false)
  const ids = usable.map((c) => c.id)
  const tagsIndex = usable.map((c) => `${c.id}: ${c.tags.join(', ')} — ${c.description}`).join('\n')
  const prompt = [
    'You are the assembly PROPOSAL DRAFTER of an agent-assembly system. Produce ONE complete assembly proposal for the requirement below. A senior ORCHESTRATOR will review and红笔 (amend) your draft — so be exhaustive and honest; a gap you hide is worse than a gap you flag.',
    '',
    'Work in TWO mental passes:',
    'PASS 1 — architecture, WITHOUT looking at the catalog: purpose; the FULL list of capabilities this agent architecturally needs (generic descriptions with why — storage, retrieval, export included); dataModel (entities + key fields); workflow (main flow across turns); interfaces (what humans interact through).',
    'PASS 2 — map every architectural need onto the catalog below, then draft the assembly decisions.',
    '',
    'Catalog:',
    tagsIndex,
    '',
    'Respond with JSON only:',
    '{"spec":{"purpose":"...","capabilities":[{"name":"...","why":"..."}],"dataModel":"...","workflow":"...","interfaces":"..."},',
    ' "coverage":[{"need":"...","capabilityId":"..."|null,"gap":"..."}], "extraIds":[...], "missingEntries":[...],',
    ' "name":"...", "persona":"...", "stateSchema":"...", "probe":{...}}',
    'Rules:',
    '- coverage: exactly one row per spec capability, in order; capabilityId from this exact set or null+gap: ' + ids.join(', '),
    '- GAP DISCIPLINE: before marking any need null, exhaustively check the catalog under other names — persistent state/ledgers → SQLite parts; workspace files → filesystem parts; searching imported docs → kb/fs-search; document output → docx/pdf/excel parts. NEVER invent vendor ids; describe missing capabilities generically. For every null row add one missingEntries item {id, via, description, tags, tool?, mount?}.',
    '- 网页/页面/看板 in the requirement usually means the DELIVERED web UI: cover it with EXACTLY ONE via:"frontend" template id whose interaction SHAPE fits (form desk / data desk / dashboard / chat console); never browser-automation for it. Put it in extraIds if no need row names it.',
    '- name: kebab-case slug naming what the agent IS (2-5 words).',
    '- persona: the agent\'s system persona — role, tone, answer in the requirement\'s language, tool discipline, durability constraint when state parts are selected ("跨轮事实必须写入账本/文件,不依赖记忆"), domain safety boundaries when the domain has them (medical/legal/finance). Judgeable constraints only — NEVER numbered procedures.',
    '- stateSchema: ONLY when a SQLite capability is selected — short idempotent DDL ("CREATE TABLE IF NOT EXISTS ..." / "CREATE INDEX IF NOT EXISTS ..." only), implementing exactly the dataModel entities. English column names, sensible keys. Omit otherwise.',
    '- probe: a smoke-test sketch of the MAIN workflow. Cross-turn state: {"kind":"scenario","createTask":"...","retrieveTask":"...","token":"...","marks":["..."]} — invent a distinctive token (e.g. INV-7781); createTask CREATES the central record carrying it with ALL data invented inline (empty workspace, nobody attending); retrieveTask retrieves BY the token WITHOUT restating stored values and reports one stored value. Pure compute: {"kind":"single","task":"...","marks":["..."]}. marks: 1-3 content-bearing strings — never invented dates as facts, never refusal wording, never UI words, never formatted numbers, never long body text that goes into a file. Size each turn under ~2 minutes.',
    '',
    `Requirement: ${requirement}`,
  ].join('\n')
  return { prompt, ids }
}

export function draftAssemblyToolDefinition(ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: DRAFT_TOOL_NAME,
    description:
      'PROPOSAL-REVIEW ASSEMBLY step 1 of 3 (you are the REVIEWING orchestrator; the assembler drafts, you red-pen). '
      + 'Call this with the user\'s full requirement: the assembler returns ONE complete assembly proposal — architecture spec, '
      + 'per-need catalog coverage (or gaps), preset name, persona, state schema, acceptance-probe sketch. '
      + 'Your job AFTER it returns: REVIEW it critically against what the user actually said — challenge the architecture '
      + '(missing needs? invented needs?), the persona (safety boundaries? durability constraint?), the schema, the gaps '
      + '(is a "gap" actually covered by some part? is a real need silently dropped?). Show the user the key points and let them '
      + 'correct the direction BEFORE assembly. Then call emit_preset with the (amended) fields, then verify_preset (the draft\'s '
      + 'probe sketch may be passed along). Rubber-stamping without review is the failure mode this flow exists to prevent.',
    parameters: {
      requirement: { type: 'string', description: 'the user\'s full natural-language requirement', required: true },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown): Promise<string> => {
      const requirement = String((args as { requirement?: unknown })?.requirement ?? '').trim()
      if (requirement === '') throw new Error('draft_assembly needs {"requirement": "..."}')
      const t0 = Date.now()
      const job = startJob(ctx, 'draft-assembly', '方案书起草')
      try {
        const catalog = await federateMcpTools(loadCatalog(config.catalogPath ?? join(REPO, 'capabilities.yml')))
        job.phase(`零件联邦就绪:${String(catalog.capabilities.length)} 条可装配`)
        const { prompt, ids } = buildDraftPrompt(requirement, catalog)
        job.phase('方案书起草中(架构+选型+persona+schema+探针,一次调用)…')
        let usage: AuxUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 }
        const parsed = await callAux(ctx, DRAFT_TOOL_NAME, prompt, config, (u) => { usage = u })
        const draft = parseDraftResponse(parsed, ids)
        const elapsed = Math.round((Date.now() - t0) / 1000)
        job.settle('completed', `${String(draft.capabilityIds.length)} 零件 / ${String(draft.missing.length)} 缺口`)
        appendOrchLedger({
          tool: DRAFT_TOOL_NAME, requirement, needs: draft.spec.capabilities.length,
          selected: draft.capabilityIds, missing: draft.missing, name: draft.name, elapsedSeconds: elapsed,
          usage: { out: usage.outputTokens, reason: usage.reasoningTokens, cache: usage.cacheReadTokens },
        })
        const byId = new Map(catalog.capabilities.map((c) => [c.id, c]))
        const rows = draft.coverage.map((r, i) => r.capabilityId !== null
          ? `  ${String(i + 1)}. ${r.need} → ${r.capabilityId}(${byId.get(r.capabilityId)?.via ?? '?'})`
          : `  ${String(i + 1)}. ${r.need} → 【缺口】${r.gap ?? ''}`).join('\n')
        const detail = usageDetail(usage)
        return `方案书(${String(elapsed)}s${detail !== '' ? `,${detail}` : ''})——以下全部是**草案**,等你红笔:\n`
          + `用途:${draft.spec.purpose}\n`
          + `数据模型:${draft.spec.dataModel}\n工作流:${draft.spec.workflow}\n接口:${draft.spec.interfaces}\n`
          + `覆盖明细:\n${rows}\n`
          + `建议 preset 名:${draft.name}\n`
          + `选中零件 capabilityIds:${draft.capabilityIds.join(', ')}\n`
          + (draft.missingEntries.length > 0 ? `缺件草案 missingEntries:${JSON.stringify(draft.missingEntries)}\n` : '')
          + `persona 草案:\n${draft.persona}\n`
          + (draft.stateSchema !== undefined ? `stateSchema 草案:\n${draft.stateSchema}\n` : '')
          + (draft.probe !== null ? `探针草图:${JSON.stringify(draft.probe)}\n` : '')
          + [
            '',
            '【接力棒——你是审阅人,不是传声筒】',
            '- 逐项挑刺再放行:架构漏了/多了什么?缺口是不是其实有零件能覆盖(或反过来,真需求被静默丢了)?persona 有没有该领域的安全边界与持久化约束?schema 是否与数据模型一比一?',
            '- 把架构要点给用户看一眼、允许当场改方向;然后带着(修订后的)字段调 emit_preset(name/requirement/capabilityIds/persona[/stateSchema][/missing,missingEntries]),再 verify_preset(可附探针草图)。',
            '- 橡皮图章是这个流程的头号失败模式:草案没有一处要改,本身就值得怀疑。',
          ].join('\n')
      } catch (error: unknown) {
        job.settle('failed', error instanceof Error ? error.message.slice(0, 120) : String(error))
        throw error
      }
    },
  })
}

// ── D 臂:ask_catalog(对话式零件专家)───────────────────────────────────────

export function askCatalogToolDefinition(ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: ASK_TOOL_NAME,
    description:
      'Free-form Q&A with the CATALOG EXPERT (knows every part: what it does, alternatives, credentials, limits). '
      + 'Use it when the requirement is AMBIGUOUS or NOVEL and you need to understand the parts landscape before deciding — '
      + '"有能读 mobi 的零件吗?"、"这两个 sqlite 零件差在哪?"、"发邮件的零件要什么凭证?". '
      + 'For ROUTINE requirements do NOT chat — go straight to match_catalog. Each question is one aux model call; '
      + 'batch related questions into one message. The expert answers about parts only; assembly decisions stay yours.',
    parameters: {
      question: { type: 'string', description: 'your question(s) about the parts catalog, batched into one message', required: true },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown): Promise<string> => {
      const question = String((args as { question?: unknown })?.question ?? '').trim()
      if (question === '') throw new Error('ask_catalog needs {"question": "..."}')
      const t0 = Date.now()
      const catalog = await federateMcpTools(loadCatalog(config.catalogPath ?? join(REPO, 'capabilities.yml')))
      const usable = catalog.capabilities.filter((c) => c.config?.enabled !== false)
      const tagsIndex = usable.map((c) => `${c.id} [${c.via}]: ${c.tags.join(', ')} — ${c.description}`).join('\n')
      const servers = catalog['mcp-servers'] ?? {}
      const secretLines = Object.entries(servers)
        .filter(([, cfg]) => Array.isArray(cfg.requiredSecrets) && (cfg.requiredSecrets as unknown[]).length > 0)
        .map(([sv, cfg]) => `${sv}: ${(cfg.requiredSecrets as Array<{ env?: string; optional?: boolean }>).map((s) => `${s.env ?? '?'}${s.optional === true ? '(可选)' : ''}`).join(', ')}`)
        .join('\n')
      const prompt = [
        'You are the CATALOG EXPERT of an agent-assembly system. Answer the orchestrator\'s question about the parts catalog below — concretely, citing part ids. Compare alternatives when asked. Say plainly when NOTHING covers something (never invent parts). Answer in the question\'s language, compact (this is a working conversation, not a report).',
        '',
        'Catalog:',
        tagsIndex,
        secretLines !== '' ? `\nParts requiring credentials (env vars, values live on the host):\n${secretLines}` : '',
        '',
        `Question: ${question}`,
      ].join('\n')
      let usage: AuxUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 }
      const answer = await callAuxText(ctx, ASK_TOOL_NAME, prompt, config, (u) => { usage = u })
      const elapsed = Math.round((Date.now() - t0) / 1000)
      appendOrchLedger({ tool: ASK_TOOL_NAME, question: question.slice(0, 200), elapsedSeconds: elapsed, usage: { out: usage.outputTokens, reason: usage.reasoningTokens, cache: usage.cacheReadTokens } })
      return `${answer}\n\n(零件专家答毕,${String(elapsed)}s。决策仍归你:清楚了就走 match_catalog → emit_preset → verify_preset。)`
    },
  })
}

// ── F 臂:search_catalog(纯机械检索)────────────────────────────────────────

export function searchCatalogToolDefinition(_ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: SEARCH_TOOL_NAME,
    description:
      'SEARCH-MODE ASSEMBLY: mechanical lexical search over the parts catalog (zero LLM, instant, deterministic). '
      + 'In this mode there is NO capability matcher — YOU are the selector. Flow: design the architecture yourself '
      + '(show the user), then search REPEATEDLY with different phrasings for each architectural need (per-need queries beat '
      + 'one big query; try synonyms — 持久存储/数据库/sqlite), pick the capability ids yourself, then emit_preset and verify_preset. '
      + 'Honesty rule: a need no search can cover goes into emit_preset\'s missing/missingEntries as a GAP — never force an '
      + 'unrelated part and never invent ids. Lexical search misses paraphrases: try 2-3 phrasings before declaring a gap.',
    parameters: {
      query: { type: 'string', description: 'one search query — a capability need in natural language (Chinese or English); repeat the tool for each need', required: true },
      limit: { type: 'number', description: 'max results (default 10)' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown): Promise<string> => {
      const a = args as { query?: unknown; limit?: unknown } | null
      const query = String(a?.query ?? '').trim()
      if (query === '') throw new Error('search_catalog needs {"query": "..."}')
      const limit = typeof a?.limit === 'number' && a.limit >= 1 && a.limit <= 30 ? Math.floor(a.limit) : 10
      const catalog = await federateMcpTools(loadCatalog(config.catalogPath ?? join(REPO, 'capabilities.yml')))
      const hits = rankCapabilities(catalog.capabilities, query, limit)
      const servers = catalog['mcp-servers'] ?? {}
      const secretOf = (c: CapabilityEntry): string => {
        const sv = c.config?.server as string | undefined
        const decl = sv !== undefined ? servers[sv]?.requiredSecrets : undefined
        if (!Array.isArray(decl) || decl.length === 0) return ''
        return `;凭证:${(decl as Array<{ env?: string; optional?: boolean }>).map((s) => `${s.env ?? '?'}${s.optional === true ? '(可选)' : ''}`).join(',')}`
      }
      appendOrchLedger({ tool: SEARCH_TOOL_NAME, query: query.slice(0, 120), hits: hits.length })
      if (hits.length === 0) {
        return `「${query}」检索 0 命中。换 2-3 种说法再试(同义词/英文词);仍无 → 这是真缺口,如实进 emit_preset 的 missing/missingEntries。`
      }
      const rows = hits.map((h, i) => `${String(i + 1)}. ${h.entry.id} [${h.entry.via}](分 ${String(h.score)})— ${h.entry.description.slice(0, 110)}${secretOf(h.entry)}`).join('\n')
      return `「${query}」top ${String(hits.length)}:\n${rows}\n(机械词法排名,分数只是线索——选不选、选哪个由你判断;别忘了 UI 需求配一个 via:frontend 模板、持久状态配存储零件。)`
    },
  })
}
