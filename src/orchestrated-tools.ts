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
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  AUX_CALL_TIMEOUT_MS, PROBE_SKETCH_EXAMPLES, PROBE_TURN_BUDGET_MS, addUsage, deriveProbePlan, parseModelJson,
  probePayloadViolation, runFrontendGate, runProbe, runScenario, sanitizeMarks, usageDetail,
  type AuxUsage, type ProbePlan, type ProbeResult,
} from './verify.js'
import { validateArchProbe } from './arch-spec.js'
import { rankCapabilities } from './capability-index.js'
import { DEFAULT_FRONTEND_TEMPLATE, FRONTEND_ROUTE, emitFrontend } from './frontend.js'
import { execFileSync, spawn as spawnPart } from 'node:child_process'
import { loadRecipe, materializeApp, runAppSelftest } from './recipe.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const MATCH_TOOL_NAME = 'match_catalog'
export const EMIT_TOOL_NAME = 'emit_preset'
export const VERIFY_TOOL_NAME = 'verify_preset'
export const DRAFT_TOOL_NAME = 'draft_assembly'
export const ASK_TOOL_NAME = 'ask_catalog'
export const SEARCH_TOOL_NAME = 'search_catalog'
export const VERIFY_SHARED_TOOL_NAME = 'verify_shared_data'

/**
 * BARE 消融模式(ROADMAP v2 P0,Boris 减法纪律):DSH_ASSEMBLER_BARE=1 时全部
 * 契约散文归零(基线判据/接力棒/范例/检查点文本),只留代码闸与事实输出——
 * 我们的 CLAUDE_CODE_SIMPLE。用途:换模型代的消融轮(BARE vs 现契约,8 场景
 * 战役)裁定每捆散文的真实边际;"没有这些 prompt 模型反而更聪明"要用数据核实,
 * 不靠信仰。
 */
export function bareMode(): boolean {
  return process.env.DSH_ASSEMBLER_BARE === '1'
}

/** 散文开关:BARE 下返回空串。事实(检索行/判决/证据/路径/价签)不过这个门。 */
function prose(t: string): string {
  return bareMode() ? '' : t
}

/**
 * 契约到期制(P0):每条散文常量登记其"适用模型代"。换模型时这些默认全部
 * 到期,消融轮重裁去留——为当代模型写的散文不许无限期活到下一代(Boris:
 * 三个月前为某模型做的东西到下一个模型可能完全不迁移)。单测钉:每条导出
 * 散文必须在此登记。
 */
export const CONTRACT_GENERATION = 'deepseek-v4'
export const CONTRACT_TAGS: Record<string, string> = {
  BASELINE_RULE: 'deepseek-v4',
  MINIMAL_SET_RULE: 'deepseek-v4',
  FRONTEND_FACT: 'deepseek-v4',
  RECIPE_FACT: 'deepseek-v4',
  SCAFFOLD_BATON: 'deepseek-v4',
  ARCHITECTURE_CONTRACT: 'deepseek-v4',
  PROBE_SKETCH_EXAMPLES: 'deepseek-v4',
}

// ── 承重契约句(集中定义:单测钉住它们,契约改动掉了哪句立刻红)────────────
// 超配病根定性为 context 缺口(2026-08-23 用户裁定):不设阈值不说教,把决策
// 需要的事实放在决策发生的地方。三句分别补三个缺口:基线(何时才需要零件)、
// 价格(每件的每轮税)、最小集(least-privilege 框架,先例:over-privileged
// tool selection 文献 + 工具过多致准确率下滑的实测阈值 10-15 件)。

/** 基线判据:零件的边界——LLM 自己能稳定做的不装。 */
export const BASELINE_RULE =
  'MOUNT-OR-NOT BASELINE: parts exist for real-world I/O (files, network, processes, persistence) and hard deterministic computation. '
  + 'What the delivered agent\'s own LLM does reliably (date arithmetic, formatting, text transformation, simple parsing) needs NO part — '
  + 'mounting one anyway is over-privilege, and research shows accuracy measurably degrades past ~10-15 mounted tools (tool-name confusion). '
  + 'BUT: **能做 ≠ 该走会话**. If a judgment is BULK or HIGH-FREQUENCY — translating every paragraph of a chapter, classifying every row on '
  + 'entry, summarising on each page load — routing it through conversation turns makes the product unusable (measured 2026-08-25: a '
  + 'bilingual reader translated chapters through chat turns; the user\'s verdict was 完全不好用). Mount ai-call so the page can call the '
  + 'AI service face directly (route ai-thin: one completion, no session), and let the page cache the result. The baseline rule is about '
  + 'CAPABILITY, this one is about THROUGHPUT — both must hold.'

/** 最小覆盖集:从 match prompt 移植出来的那条纪律,现在住在检索/发射契约里。 */
export const MINIMAL_SET_RULE =
  'Keep the mounted set MINIMAL (least privilege): the smallest covering set for the architecture — every mounted part is a real process '
  + 'plus its tool manual in EVERY turn of the delivered agent\'s prompt, forever.'

/** 前端物理事实:多装模板不是权衡,是死件。 */
export const FRONTEND_FACT = '每 preset 仅首个 frontend 模板生效——选恰好一个交互形状。'

/** 配方物理事实:app 图纸不进 preset,零对话 token 税——检索行价签用。 */
export const RECIPE_FACT = '独立 app 图纸:emit_app 实例化成独立进程交付物(不占任何 agent 的对话 token),verify_app 独立验收。'

/**
 * 写手席接力棒(scaffold 族配方专用):骨架落地后主 agent 就是写手——流程知识
 * 靠结果接力棒传,不靠 agent 读 docs(接力棒断链实录:通用接力棒直奔 verify,
 * 得到"骨架态 SKIPPED",写手不知道中间该写页)。
 */
export const SCAFFOLD_BATON =
  '【接力棒·写手席】骨架已就位,YOU are now the page writer. NEXT: (1) READ <targetDir>/WRITE-ME.md — it lists the exact vocabulary '
  + '(13 shadcn components), the SDK API, the PAGE-SPEC exam format, and two golden examples in examples/. '
  + '(2) WRITE PAGE-SPEC.yml first (every action tagged face/wire/local; face carries sql+effect, wire carries probe+marks — the examiner '
  + 'runs YOUR exam verbatim), then write src/pages/*.tsx. Free zone is ONLY PAGE-SPEC.yml and src/pages/ — everything else is hash-locked. '
  + 'Column names come from the paired preset\'s equipment DDL — copy them, never invent. Do NOT run npm/vite yourself. '
  + '(3) verify_app {"targetDir": "<targetDir>"} — five gates incl. the behavior exam; FAIL comes back with evidence, fix surgically, '
  + '同一 app 连续 3 次 FAIL 后停手上报. (4) deploy_app {"targetDir", "presetId"} publishes the built dist into the preset, same-origin. '
  + '(5) Report the page URL and what was examined, honestly.'

/**
 * 架构契约(2026-08-23 深夜,xhs 实测用户投诉后加):两个病一起治——
 * ① 确认检查点原住 match 契约,match 降为备用阀后检查点失传(契约句搬家必丢
 *   东西,当日第三案),现在钉死在检索契约里且点名 ask_user_question(软措辞
 *   无效是当日另一实证);② "design the architecture yourself"一句软话产出
 *   5 行一句话清单,骨架六维 + 深度线写死。
 */
export const ARCHITECTURE_CONTRACT =
  'WORKFLOW CONTRACT — (0) SHAPE ROUTING before anything: judge the requirement\'s shape and SAY it. 应用型 (interaction-dense, '
  + 'deterministic UI/data flows; AI is a component) → FIRST search via:"recipe" entries (complete verified app blueprints: emit_app '
  + 'materializes, verify_app examines). LANE TIE-BREAK when a recipe AND a preset+frontend would both work (they overlap now that presets have service faces): 交出去的/纯页面型/要脱离 host 独立跑 → RECIPE (self-contained process, zero conversation tax); 要留对话口/多张脸共一本账/要挂 agent 能力(工具、无人值守) → PRESET (双面交付:页面直连服务脸 + wire 会话). SAY which lane you picked and why in one line — silently taking the preset path for a requirement a recipe covers is the failure this tie-break exists to prevent (measured 2026-08-25: 3/3 recipe-shaped needs went preset-only). No recipe fits → assemble the service form: bytes/files flow through service parts (直传端点), '
  + 'the model only where judgment lives — and when neither recipes nor parts cover the app shape, honestly recommend direct coding instead of assembling; '
  + '个人即时型 (the user wants it done NOW, conversationally) → offer to just do it yourself in this session — minting an agent is NOT the '
  + 'default for personal immediate needs; 无人值守/他人使用/交付型 → that is what minting is for. '
  + '(1) ARCHITECTURE FIRST, to review depth: 用途 (purpose); capability list where EACH entry carries a why and is '
  + 'concrete enough to search (storage/retrieval/export included; a capability the catalog may lack still gets designed and flagged); '
  + 'data model (tables + key fields); workflow (how turns flow: who initiates, what gets reviewed, how state moves); interface shape; '
  + 'boundary & delivery semantics (what the agent does vs what stays human). A list of five one-liners is a sketch, NOT an architecture. '
  + '(2) PRESENT IT AND STOP: call ask_user_question (options like 按此装配/我要调整) and WAIT for approval — do NOT search, emit, or verify '
  + 'before the user approves. The presentation MUST include every gap the catalog cannot cover, each with its disposition as a USER choice: '
  + '现场造件 (a gap work order; you build it through the induction pipeline) / 降级方案 (state exactly what degrades) / 砍掉. '
  + 'Silently downgrading a gap the user never saw is the failure this checkpoint exists to prevent. '
  + '(3) Only then search per need. Gaps agreed at the checkpoint MUST be passed to emit_preset as missing/missingEntries — that is what turns '
  + 'them into work orders. (4) ASSEMBLER RESOURCES ARE TOOL-SURFACE ONLY: the catalog, presets, recipes and knowledge live OUTSIDE your shell sandbox — read a preset with read_preset (persona/装备 DDL/BOM/faces), ingest docs with add_knowledge, submit a part you wrote with submit_part (it installs, runs YOUR smoke, probes listTools independently, and registers only on a clean pass). If a shell command is denied because a path is outside the workspace, that is the sandbox working as designed: **stop, do not retry with escalated permissions** — either use the tool for that job, or hand the user a work order saying exactly what is needed (measured 2026-08-25: two scenarios burned 30 minutes each on escalation retries and delivered nothing). Knowledge packs go through the add_knowledge TOOL (tool surface — works from any session). Never hand-edit capabilities.yml or index/catalog.yml — that bypasses the quality gate '
  + '(live case: a bypassed gate hid a process-hang '
  + 'defect and a copied-from-another-part smoke test).'

/**
 * 探针草图范例(⑦出题辅助,范例优先于规则):先例 Anthropic Tool Use Examples
 * 实测复杂参数准确率 72%→90% 靠的是给 1-5 个真实示例而不是更多规则。定义移居
 * verify.ts(编排者出题与考官回退推导共用同一份——s23 实测回退推导没吃范例时
 * 出过 base64 怪题);此处 re-export 保住既有引用与契约钉。
 */
export { PROBE_SKETCH_EXAMPLES } from './verify.js'

/**
 * 装配器与主 agent 的配合形态(host 级环境变量 DSH_ASSEMBLER_MODE):
 *  search       **默认**(2026-08-23 身份裁定 + 四臂实测):装配器 = 零件生态的
 *               搜索引擎。search_catalog 机械检索(零 LLM,BM25 加权,带价签)+
 *               match_catalog 备用精排阀 + 哑发射 + 独立考官。四臂对跑:Σ墙钟比
 *               B 快 40%,辅助思考 114.5k→7.8k,质量不掉(forms-bcdf-8.md)。
 *  pipeline     旧一条龙(assemble/assemble_solution),自动化/回归后备,显式开。
 *  orchestrated B 臂(match 映射,无 search)——战役复现用。
 *  draft        C 臂提案审阅——已判负结果(红笔率 0/8),留档复现用。
 *  dialogue     D 臂对话专家——已判死重(ask Σ0),目录过数千条复议。
 */
export type AssemblerMode = 'pipeline' | 'orchestrated' | 'draft' | 'dialogue' | 'search' | 'off'

export function assemblerMode(): AssemblerMode {
  const m = process.env.DSH_ASSEMBLER_MODE
  if (m === 'pipeline' || m === 'orchestrated' || m === 'draft' || m === 'dialogue' || m === 'search' || m === 'off') return m
  return 'search'
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
  // 段序即缓存工程(§09:静态前缀=缓存):目录+规则是字节稳定的大头,放最前;
  // 每次不同的 needs/dataModel/requirement 全部沉尾。
  const prompt = [
    'You are the CATALOG EXPERT of an agent-assembly system. The ORCHESTRATOR (the calling agent) already designed this agent\'s architecture; your ONLY job is to map each architectural need onto the parts catalog. You do NOT write personas, schemas, names, or UIs — the orchestrator does.',
    '',
    'Catalog:',
    tagsIndex,
    '',
    'Rules:',
    '- Respond with JSON only: {"coverage":[{"need":"...","capabilityId":"..."|null,"gap":"..."}],"extraIds":[...],"missingEntries":[...]}',
    '- coverage MUST have exactly one row per architectural need (listed at the end of this prompt), in the same order. capabilityId is the ONE catalog id that covers the need; when NOTHING covers it, capabilityId is null and "gap" is a GENERIC one-line description of the missing capability.',
    `- Every capabilityId must come from this exact set: ${ids.join(', ')}`,
    '- GAP DISCIPLINE: before marking any need null, exhaustively check the catalog for an existing part covering it under another name — persistent state/ledgers → the SQLite parts; saving/reading workspace files → the filesystem parts; searching/citing imported docs → the kb/fs-search entries; document output → the docx/pdf/excel parts. Mark a gap ONLY when nothing plausibly covers it, and NEVER invent vendor-specific ids — describe the missing capability generically.',
    '- A need mentioning 网页/页面/看板/面板 usually means the DELIVERED web UI — cover it with EXACTLY ONE via:"frontend" template id whose interaction SHAPE fits (form submission → form desk; records & queries → data desk; metrics overview → dashboard; plain conversation → chat console). Do NOT select browser-automation/http parts for it; those are only for the AGENT itself visiting EXTERNAL sites. When the Interfaces line implies a UI but no need row says so, put the frontend id in extraIds instead.',
    '- extraIds: catalog ids needed beyond the listed needs — a domain persona/baseline entry that clearly matches this agent\'s domain, or the frontend template per the rule above. Empty array when none.',
    '- For every null coverage row, add one entry to "missingEntries": {id, via, description, tags, tool?, mount?} — id kebab-case; via "package" | "harness" | "mcp"; when you know a harness plugin package providing it, set mount.name, else omit mount. Empty array when nothing is missing.',
    '',
    'Architectural needs (from the orchestrator\'s spec — coverage rows follow THIS order):',
    need,
    spec.dataModel !== '' ? `Data model: ${spec.dataModel}` : '',
    spec.interfaces !== '' ? `Interfaces: ${spec.interfaces}` : '',
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
    throw new Error('emit_preset 需要 "capabilityIds":你从检索/映射结果里定下的零件 id 清单(组装决策归你)')
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

// ── 自检包(P0:验证双轨的自验证半边)────────────────────────────────────────
// Bun 重写的教训:模型长跑的前提是手里有自己的测试套件。考官的探针从"一次性
// 考卷"升级为交付物随行的体检包:PASS 时把探针计划落进 preset(selfcheck.json),
// 交付后的 agent/用户改 persona、升零件,可自跑同卷体检——独立验收台账照旧,
// 自检不替代考官,只是把验证手段交到交付物自己手里。

/** ProbePlan → verify_preset 可直接吃的草图(2 轮场景/单轮可表示;其余 null)。 */
export function planToSketch(plan: ProbePlan): Record<string, unknown> | null {
  if (plan.kind === 'single') return { kind: 'single', task: plan.probe.task, marks: plan.probe.mustInclude }
  if (plan.scenario.turns.length === 2) {
    const [t1, t2] = plan.scenario.turns
    return { kind: 'scenario', createTask: t1.prompt, retrieveTask: t2.prompt, token: t1.mustInclude[0] ?? '', marks: t2.mustInclude }
  }
  return null
}

/** 体检包渲染(纯函数,单测覆盖)。 */
export function renderSelfCheck(opts: { presetId: string; presetSha256: string; plan: ProbePlan; verifiedAt: string }): string {
  const sketch = planToSketch(opts.plan)
  return JSON.stringify({
    version: 1,
    presetId: opts.presetId,
    presetSha256: opts.presetSha256,
    verifiedAt: opts.verifiedAt,
    generation: CONTRACT_GENERATION,
    plan: opts.plan,
    rerun: { tool: VERIFY_TOOL_NAME, args: { presetId: opts.presetId, reverify: true, ...(sketch !== null ? { probe: sketch } : {}) } },
    note: '交付物随行体检包:改 persona/升零件后重跑同卷自检;独立验收台账(last-verify.json)仍以考官为准。',
  }, null, 2) + '\n'
}

// ── 工具 1:match_catalog ────────────────────────────────────────────────────

export function matchCatalogToolDefinition(ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: MATCH_TOOL_NAME,
    description:
      'EXPERT LLM mapping of a whole architecture spec onto the parts catalog. Input: your architecture spec. Output: per need, a capability id or a GAP.'
      + prose(' The LAST-RESORT escalation, not the normal path. '
        + 'When search_catalog is available, searching + your own judgment IS the selection path: do NOT call this for requirements you can '
        + 'decide from search results (this is a 60-180s full-effort LLM call). Call it at most ONCE per assembly, and only when ≥2 '
        + 'differently-phrased searches per still-uncovered need left you genuinely stuck or with conflicting candidates. '
        + 'Design the spec FIRST, show the user. It does NOT write personas/schemas/names and does NOT assemble — after it returns, YOU decide and call emit_preset, then verify_preset. '
        + 'Never invent capability ids yourself: ids come from search results or from this mapping.'),
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
          + prose([
            '',
            '【接力棒——编排者是你,匹配到此为止】',
            '- 组装决策归你,现在做:写 persona(角色/语气/工具纪律/跨轮持久化约束/该领域的安全合规边界;写成随时可判的约束,禁止"第一步…第二步…"编舞);数据要跨会话留存则设计 stateSchema(只许幂等 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS,英文列名、合理主键,按你 spec 的 dataModel 一比一落表);给 preset 起 kebab-case 名。',
            '- 然后调 emit_preset(name, requirement, capabilityIds, persona[, stateSchema][, params][, missing, missingEntries])发射;发射后必须调 verify_preset 独立验收——你不能自己宣布 agent 可用。',
            ...(outcome.missing.length > 0 ? ['- 缺口处置归你:或先照工单造件入库再装(emit 后 gaps/ 有施工单),或先装配、把缺口如实告知用户。'] : []),
            '- 注意:若选中零件自带目录手写 persona(域验证过的安全文本),发射时它优先于你写的。',
          ].join('\n'))
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
      'The DUMB deterministic printer: prints your assembly decisions (name, capabilityIds, persona, stateSchema, params) into a mountable preset with every gate intact.'
      + prose(' YOU already made the assembly decisions (capabilityIds from search/match — you may add/remove; persona YOU wrote; stateSchema YOU designed when state must persist; the preset name). '
        + 'Gates: secret-shaped params refused, YAML parse gate, idempotent-DDL double-execution gate, persona lint, byte-deterministic serverNames, BOM (parts.lock.yml), gap work-orders. '
        + 'It makes NO decisions and runs NO verification — after it returns you MUST call verify_preset. '
        + 'NEVER hand-write or edit preset files yourself (the host pins mounted server names to file bytes; a hand edit collides its own generation) — '
        + 'any change means calling emit_preset again with the same name.'),
    parameters: {
      name: { type: 'string', description: 'kebab-case preset id YOU chose, e.g. "expense-tracker"', required: true },
      requirement: { type: 'string', description: 'what this agent is for (goes into the BOM and roster description)', required: true },
      capabilityIds: {
        type: 'array',
        description: 'final capability ids to mount (start from match_catalog\'s list; adding ids not in the catalog fails loudly)',
        items: { type: 'string' },
        required: true,
      },
      persona: {
        type: 'string',
        description:
          'the system persona YOU wrote for this agent.'
          + prose(' SKELETON — cover each dimension that applies: ① 角色与辖区 (what it is and is NOT for); '
            + '② 语气 and answer language; ③ 工具纪律 (which tool for which job); ④ 持久化约束 when state parts are mounted (跨轮事实必须写入账本/文件,不依赖记忆); '
            + '⑤ 安全合规边界 — MANDATORY for medical/legal/finance/collections domains (what it must never do, e.g. 绝不诊断开药/绝不联系第三方); '
            + '⑥ 拒答范围 (out-of-scope requests it declines). Judgeable constraints only — never numbered procedures.'),
        required: true,
      },
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
      // 前端硬闸:一个 preset 只有首个 frontend 模板生效——≥2 个不是权衡是死件,
      // 错误就按错误处理(F 臂实测 HR 装了 3 个模板)。context 补全治大半,这是兜底。
      const feIds = ids.filter((cid) => catalog.capabilities.find((c) => c.id === cid)?.via === 'frontend')
      if (feIds.length >= 2) {
        throw new Error(`emit_preset: 选了 ${String(feIds.length)} 个 frontend 模板(${feIds.join(', ')}),但${FRONTEND_FACT}挑一个交互形状最贴的重新调用。`)
      }
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
        + prose([
          '',
          '【接力棒】',
          `- 发射完成 ≠ 可用。立即调 verify_preset {"presetId": "${id}"} 独立验收,并附上你按主工作流设计的探针草图(草图过机械闸 = 验收推导 0s;不给则考官满档自行推导,贵且慢)。`,
          `- 出题范例(照这个形状写):${PROBE_SKETCH_EXAMPLES}`,
          '- 红线:绝不手改 preset 目录下的任何文件(host 按字节代际挂载,手改必撞名);要改选型/persona/schema,一律重调 emit_preset 同名重发。',
        ].join('\n'))
    },
  })
}

// ── 工具 3:verify_preset ────────────────────────────────────────────────────

export function verifyPresetToolDefinition(ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: VERIFY_TOOL_NAME,
    description:
      'The INDEPENDENT examiner: runs a black-box acceptance probe against an emitted preset in a real session and returns the verdict with evidence. Optional probe sketch accepted.'
      + prose(' An agent that asks a human mid-probe FAILS (empty workspace, nobody attending). You may pass a probe sketch — '
        + 'you know the user\'s intent best — but the verdict is the examiner\'s: you cannot grade your own assembly, and this tool NEVER retries. '
        + 'On FAIL it returns the evidence (which turn, which missing mark, what the agent replied) and the surgical decision is YOURS: '
        + 'swap parts and re-emit, build the missing part first, tighten the persona, or report honestly to the user. '
        + 'Sketch by EXAMPLE (copy these shapes): ' + PROBE_SKETCH_EXAMPLES + ' '
        + 'Rules the examples embody: invent ALL data inline (empty workspace, nobody attending); the retrieve turn asks BY the token without '
        + 'restating stored values; marks are content-bearing — never invented dates as facts, never refusal wording, never UI/page words, '
        + 'never formatted numbers, never long body text that goes to a file; size each turn under ~2 minutes. '
        + 'A sketch that fails the mechanical gate falls back to the examiner\'s own derivation (slow, expensive). '
        + 'A PASS on unchanged bytes within 7 days is carried from the ledger (honestly labeled); pass reverify=true to force a fresh probe.'),
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
      // 不信调用者的口头转述——考官只认工件。lockParts 全记录:动用率映射要用
      // serverName(本 preset 代际的运行时名)/plane/tool 三个字段。
      let lockRequirement = ''
      let lockIds: string[] = []
      let lockParts: Array<{ capability: string; tool?: string; server?: string; serverName?: string; plane?: string }> = []
      try {
        const lock = (yaml.load(readFileSync(join(dir, 'parts.lock.yml'), 'utf8')) ?? {}) as { requirement?: unknown; parts?: Array<Record<string, unknown>> }
        lockRequirement = typeof lock.requirement === 'string' ? lock.requirement : ''
        lockParts = (Array.isArray(lock.parts) ? lock.parts : [])
          .map((p) => ({
            capability: String(p.capability ?? ''),
            ...(typeof p.tool === 'string' ? { tool: p.tool } : {}),
            ...(typeof p.server === 'string' ? { server: p.server } : {}),
            ...(typeof p.serverName === 'string' ? { serverName: p.serverName } : {}),
            ...(typeof p.plane === 'string' ? { plane: p.plane } : {}),
          }))
          .filter((p) => p.capability !== '')
        lockIds = lockParts.map((p) => p.capability)
      } catch { /* 无 lock:仍可验收(推导退化为按 preset 文本),但正常发射必有 lock */ }
      // 动用率映射:一个工具零件"被动用" = 探针会话里出现了它的运行时工具名。
      // 自装 mcp 行的运行时名带代际后缀(mcp__<serverName>__<tool>),host 平面
      // 与 package 工具用目录名原样。语义边界:探针只走主流程,未动用≠无用。
      const utilization = (used: Array<{ name: string; calls: number }> | undefined): { mounted: number; usedCount: number; unused: string[] } | null => {
        if (used === undefined) return null
        const usedNames = new Set(used.map((u) => u.name))
        const toolParts = lockParts.filter((p) => p.tool !== undefined)
        if (toolParts.length === 0) return null
        const unused: string[] = []
        let usedCount = 0
        for (const p of toolParts) {
          const t = p.tool ?? ''
          const candidates = new Set<string>([t])
          // mcp__<server>__<tool> 按双下划线切段(server/tool 内的连字符与单下划线不受影响);
          // 自装行的运行时名把 server 换成本代际 serverName。
          const seg = t.split('__')
          if (seg.length >= 3 && seg[0] === 'mcp' && p.serverName !== undefined) {
            candidates.add(`mcp__${p.serverName}__${seg.slice(2).join('__')}`)
          }
          const hit = [...candidates].some((c) => usedNames.has(c))
          if (hit) usedCount++
          else unused.push(p.capability)
        }
        return { mounted: toolParts.length, usedCount, unused }
      }
      const presetText = readFileSync(presetPath, 'utf8')
      const sha = presetSha(presetText)
      const contractPass = prose([
        '',
        '【接力棒】',
        '- 如实向用户转述验收结论与前端 URL;验收已入台账,同字节 7 天内重验将自动沿用。',
      ].join('\n'))
      const contractFail = prose([
        '',
        '【外科决策归你——考官不重试,证据在上】',
        '- 先诊断再动手:疑零件不匹配 → 调整 capabilityIds 重调 emit_preset(同名重发)再 verify_preset;疑缺件 → 先照 gaps/ 工单造件入库再重发重验;疑 persona 约束不足 → 改 persona 重发重验;修不了或拿不准 → 把失败原因与证据如实报给用户,等定夺。',
        '- 重试预算封顶:同一 preset 连续 3 次 FAIL 后必须停手上报用户——自愈死循环烧的是用户的钱(行业通行缓解就是重试限额,不要证明它是对的)。',
        '- 红线:禁止手改 preset 目录文件;禁止绕开 verify_preset 自行开会话"试一下就算过";禁止把 FAIL 转述成通过。',
      ].join('\n'))
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
        // 大载荷硬闸:任务里塞文件本体(≥200 连续 base64 形字符)直接报错并教
        // 夹具模式——LLM 逐字节复制 2KB base64 必抄坏(读书助手 e2e 实测 40 分钟
        // 三轮笔误),这不是质量问题是物理问题,回退推导也救不了它。
        if (sketch !== null && probePayloadViolation([sketch.createTask, sketch.retrieveTask, sketch.task])) {
          throw new Error(
            'verify_preset: 探针任务里内嵌了大载荷(≥200 连续 base64 形字符)——LLM 无法逐字节复制这种长度,必抄坏。'
            + '改用夹具模式:先把文件写进 preset 的 workspace(如 workspace/uploads/sample.epub),探针任务按相对路径引用它。',
          )
        }
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
        let selfCheckLine = ''
        if (verification.status === 'PASS') {
          try {
            const onDisk = readFileSync(presetPath, 'utf8')
            const summary = verification.kind === 'scenario' ? verification.scenario?.goal : verification.probe?.task
            const verifiedAt = new Date().toISOString()
            saveVerifyLedger(dir, {
              presetSha256: presetSha(onDisk), status: 'PASS',
              ...(verification.kind !== undefined ? { kind: verification.kind } : {}),
              verifiedAt,
              ...(typeof summary === 'string' && summary !== '' ? { summary: summary.slice(0, 120) } : {}),
            })
            // 自检包随 PASS 落盘:考官的卷子沉淀为交付物自己的测试套件。
            writeFileSync(join(dir, 'selfcheck.json'), renderSelfCheck({ presetId: id, presetSha256: presetSha(onDisk), plan, verifiedAt }))
            selfCheckLine = '\n自检包:selfcheck.json 已随 preset 落盘(改 persona/升零件后可重跑同卷体检)'
          } catch (error: unknown) {
            console.error(`[assembler] verify ledger write failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        const elapsed = Math.round((Date.now() - t0) / 1000)
        phase(`验收完成:${verification.status}(${String(elapsed)}s)`)
        // 动用率:实测证据回填(②context 的事后镜子)。字段名对齐 OTel GenAI
        // 的 execute_tool / gen_ai.tool.name,台账将来可直喂观测平台。
        const util = utilization(verification.toolsUsed)
        settleAndLedger({
          status: verification.status,
          ...(verification.kind !== undefined ? { kind: verification.kind } : {}),
          ...(verification.reason !== undefined ? { reason: verification.reason.slice(0, 200) } : {}),
          sketch: sketch !== null && sketchNote === '',
          derive: { out: deriveUsage.outputTokens, reason: deriveUsage.reasoningTokens },
          ...(verification.toolsUsed !== undefined ? { toolExecutions: verification.toolsUsed.map((u) => ({ 'gen_ai.tool.name': u.name, calls: u.calls })) } : {}),
          ...(util !== null ? { utilization: { mounted: util.mounted, used: util.usedCount } } : {}),
        }, verification.status === 'PASS' ? 'completed' : 'failed', verification.status)
        const utilLine = util === null ? '' : `\n动用率:${String(util.usedCount)}/${String(util.mounted)} 个工具零件被探针动用${util.unused.length > 0 ? `;未动用:${util.unused.slice(0, 12).join(', ')}${prose('(探针只走主流程,未动用≠无用——这是修剪线索:确认多余就调 emit_preset 去掉重发)')}` : ''}`
        const ladder = (verification.turns ?? [])
          .map((t) => `  第${String(t.index)}轮 ${t.pass ? '✓' : '✗'} 「${t.prompt.slice(0, 50)}」标记 [${t.mustInclude.join(', ')}]${t.pass ? '' : `;回复摘录「${t.reply.slice(0, 120)}」`}`)
          .join('\n')
        const detail = usageDetail(deriveUsage)
        const head = `验收 ${verification.status}(${String(elapsed)}s${detail !== '' ? `,推导 ${detail}` : ''})${sketchNote}`
        if (verification.status === 'PASS') {
          const evidence = verification.kind === 'scenario'
            ? `多轮场景「${verification.scenario?.goal.slice(0, 60) ?? ''}」共 ${String(verification.scenario?.turns.length ?? 0)} 轮逐轮通过\n${ladder}`
            : `探针「${verification.probe?.task.slice(0, 80) ?? ''}」通过;验收标记 [${verification.probe?.mustInclude.join(', ') ?? ''}]`
          return `${head} — ${evidence}${feLine}${utilLine}${selfCheckLine}${contractPass}`
        }
        const evidence = verification.kind === 'scenario'
          ? `${verification.reason ?? ''}\n${ladder}`
          : `${verification.reason ?? '回复未含验收标记'};探针「${verification.probe?.task.slice(0, 80) ?? ''}」;标记 [${verification.probe?.mustInclude.join(', ') ?? ''}]${verification.reply !== undefined ? `;回复摘录「${verification.reply.slice(0, 150)}」` : ''}`
        return `${head} — ${evidence}${feLine}${utilLine}${verification.status === 'FAIL' || verification.status === 'ERRORED' ? contractFail : contractPass}`
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
      'The parts-ecosystem SEARCH ENGINE (mechanical BM25-weighted lexical search: zero LLM, instant, deterministic). '
      + 'Search once per capability need; repeat with different phrasings.'
      + prose(' YOU are the selector — the assembler only supplies facts. '
        + ARCHITECTURE_CONTRACT + ' '
        + 'Per-need queries beat one big query; try synonyms — 持久存储/数据库/sqlite. Decide the ids yourself, then emit_preset and verify_preset. '
        + BASELINE_RULE + ' ' + MINIMAL_SET_RULE + ' '
        + 'Each result row carries the FACTS for that decision: a price tag (≈prompt-tokens its tool manual adds to EVERY turn of the '
        + 'delivered agent, and whether it spawns a process), credential needs, and evidence. '
        + 'Honesty rule: a need no search covers goes into emit_preset\'s missing/missingEntries as a GAP — never force an unrelated '
        + 'part, never invent ids. Lexical search misses paraphrases: try 2-3 phrasings before declaring a gap. '
        + 'THIS SEARCH IS THE SELECTION PATH — searching + your own judgment completes selection for ordinary requirements; results are '
        + 'designed to be decided on directly. match_catalog is a LAST-RESORT escalation with a hard budget: at most ONE call per assembly, '
        + 'and ONLY after ≥2 differently-phrased searches per still-uncovered need left you genuinely stuck (it costs a 60-180s full-effort '
        + 'LLM call — calling it on a requirement you could decide from search results wastes the user\'s time).'),
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
        // 配方不是 mcp server:凭证声明直挂条目(config.requiredSecrets)。
        const decl = c.via === 'recipe'
          ? c.config?.requiredSecrets
          : (() => { const sv = c.config?.server as string | undefined; return sv !== undefined ? servers[sv]?.requiredSecrets : undefined })()
        if (!Array.isArray(decl) || decl.length === 0) return ''
        return `;凭证:${(decl as Array<{ env?: string; optional?: boolean }>).map((s) => `${s.env ?? '?'}${s.optional === true ? '(可选)' : ''}`).join(',')}`
      }
      // 价签:工具说明书字节 → 估算 token(≈bytes/4;标"约");mcp 且非 host 挂载
      // = 交付会话要拉一个零件进程(同服务器多件共享一个)。
      const priceOf = (c: CapabilityEntry): string => {
        if (c.via === 'recipe') return `;${RECIPE_FACT}`
        if (c.via !== 'mcp') return c.via === 'frontend' ? `;${FRONTEND_FACT}` : ''
        const bytes = typeof c.config?.toolBytes === 'number' ? c.config.toolBytes : undefined
        const sv = c.config?.server as string | undefined
        const hostMounted = sv !== undefined && servers[sv]?.hostMounted === true
        const tax = bytes !== undefined ? `每轮约 ${String(Math.round(bytes / 4))} token` : '每轮 token 未标定'
        return `;价签:${tax}${hostMounted ? '(host 平面,无新进程)' : ',+1 进程(同服务器零件共享)'}`
      }
      // 服务面(P1):零件自带浏览器可直连的本机 HTTP 端点——数据流可不过模型。
      const serviceOf = (c: CapabilityEntry): string => {
        const sv = c.config?.server as string | undefined
        const announce = sv !== undefined ? servers[sv]?.serviceAnnounce : undefined
        return typeof announce === 'string' && announce !== '' ? `;服务面:浏览器可直连(经 ${announce} 工具发现端点,大文件/字节流走此通道不过模型)` : ''
      }
      appendOrchLedger({ tool: SEARCH_TOOL_NAME, query: query.slice(0, 120), hits: hits.length })
      if (hits.length === 0) {
        return `「${query}」检索 0 命中。${prose('换 2-3 种说法再试(同义词/英文词);仍无 → 这是真缺口,如实进 emit_preset 的 missing/missingEntries。')}`
      }
      const rows = hits.map((h, i) => `${String(i + 1)}. ${h.entry.id} [${h.entry.via}](分 ${String(h.score)})— ${h.entry.description.slice(0, 110)}${priceOf(h.entry)}${serviceOf(h.entry)}${secretOf(h.entry)}`).join('\n')
      return `「${query}」top ${String(hits.length)}:\n${rows}`
        + prose(`\n(BM25 词法排名,分数只是线索——选不选、选哪个由你判断。基线:交付 agent 的 LLM 自己能稳定做的不装零件;价签是它每轮 prompt 的固定税。UI 需求恰好配一个 via:frontend 模板、持久状态配存储零件。)`)
    },
  })
}

// ── verify_shared_data:多 agent 班子的共享数据考官(FDE 闭环的 B 面)────────

export function verifySharedDataToolDefinition(ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: VERIFY_SHARED_TOOL_NAME,
    description:
      'INDEPENDENT examiner for MULTI-AGENT suites sharing one SQLite database (presets emitted with the same absolute sharedDb path): '
      + 'proves that what one agent WRITES another agent can READ — real cross-preset sessions, black-box, no retry. '
      + 'YOU design the handoff (you know the shared schema): writerTask = an EXPLICIT insert instruction for the writer agent, carrying an '
      + 'invented KEY token (e.g. ORD-7788) AND an invented PAYLOAD string (e.g. HANDOFF-4821-OK) into real columns; '
      + 'readerTask = an EXPLICIT query instruction for a DIFFERENT agent to fetch that row BY the token and report the payload column. '
      + 'Mechanical gates: writerTask must contain both token and payload; readerTask must contain the token but NEVER the payload '
      + '(otherwise the reader could parrot the instruction — the copy gate); the examiner judges the reader\'s reply for the payload. '
      + 'PASS = data truly flows across the suite. Call after emitting all suite members. '
      + 'TWO-FACED deliveries (a recipe APP sharing the preset\'s db via DB_PATH): pass writerAppUrl or readerAppUrl instead of that side\'s '
      + 'preset id — the examiner then performs that side itself over the app\'s HTTP face, and the task for an app side is a single SQL '
      + 'statement (INSERT for writer / SELECT for reader; same token/payload gates apply). app↔agent handoff proven = the two faces truly '
      + 'share one ledger.',
    parameters: {
      writerId: { type: 'string', description: 'preset id of the WRITING agent (omit when writerAppUrl is given)' },
      readerId: { type: 'string', description: 'preset id of the READING agent (omit when readerAppUrl is given; must differ from writer side)' },
      writerAppUrl: { type: 'string', description: 'recipe app base URL (http://127.0.0.1:port) to WRITE through — writerTask must then be one SQL INSERT carrying token and payload' },
      readerAppUrl: { type: 'string', description: 'recipe app base URL to READ through — readerTask must then be one SQL SELECT keyed by token (payload must NOT appear)' },
      token: { type: 'string', description: 'invented KEY token both tasks reference, e.g. ORD-7788', required: true },
      payload: { type: 'string', description: 'invented PAYLOAD string the writer stores and the reader must report verbatim, e.g. HANDOFF-4821-OK', required: true },
      writerTask: { type: 'string', description: 'explicit instruction for the writer: insert a row into a REAL shared table with <token> in the key column and <payload> in a text column, fill other NOT NULL columns with placeholders, then reply done', required: true },
      readerTask: { type: 'string', description: 'explicit instruction for the reader: query the shared table for the row keyed <token> and report the payload column value verbatim; do not ask anyone', required: true },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown): Promise<string> => {
      const a = args as Record<string, unknown> | null
      const writerId = sanitizePresetName(String(a?.writerId ?? ''))
      const readerId = sanitizePresetName(String(a?.readerId ?? ''))
      const token = String(a?.token ?? '').trim()
      const payload = String(a?.payload ?? '').trim()
      const writerTask = String(a?.writerTask ?? '').trim()
      const readerTask = String(a?.readerTask ?? '').trim()
      const writerAppUrl = String(a?.writerAppUrl ?? '').trim()
      const readerAppUrl = String(a?.readerAppUrl ?? '').trim()
      const appMode = writerAppUrl !== '' || readerAppUrl !== ''
      if (writerAppUrl !== '' && !writerAppUrl.startsWith('http://127.0.0.1:')) throw new Error('verify_shared_data: writerAppUrl 必须是本机 app 地址(http://127.0.0.1:端口)')
      if (readerAppUrl !== '' && !readerAppUrl.startsWith('http://127.0.0.1:')) throw new Error('verify_shared_data: readerAppUrl 必须是本机 app 地址(http://127.0.0.1:端口)')
      if (writerAppUrl === '' && writerId === '') throw new Error('verify_shared_data: 写方要么给 writerId(agent)要么给 writerAppUrl(app)')
      if (readerAppUrl === '' && readerId === '') throw new Error('verify_shared_data: 读方要么给 readerId(agent)要么给 readerAppUrl(app)')
      if (!appMode && (writerId === '' || readerId === '' || writerId === readerId)) {
        throw new Error('verify_shared_data: writerId 与 readerId 必须是两个不同的已发射 preset id')
      }
      const presetRoot = presetRootOf(config)
      for (const id of [writerId, readerId].filter((x) => x !== '')) {
        if (!existsSync(join(presetRoot, id, 'agent.cordis.yml'))) {
          throw new Error(`verify_shared_data: preset「${id}」不存在——先用 emit_preset(带同一 sharedDb 绝对路径)发射全部班子成员`)
        }
      }
      // 机械闸(每条都是共享探针战役的真坑):token/payload 自给自足;取回轮
      // 不许携带 payload(照抄即假 PASS);标记消毒。
      if (token.length < 3 || payload.length < 4) throw new Error('verify_shared_data: token ≥3 字符、payload ≥4 字符(要够独特,别用 ok/done)')
      if (!writerTask.includes(token) || !writerTask.includes(payload)) {
        throw new Error('verify_shared_data: writerTask 必须同时包含 token 与 payload(写入指令要自给自足)')
      }
      if (!readerTask.includes(token)) throw new Error('verify_shared_data: readerTask 必须包含 token(按键取行)')
      if (readerTask.toLowerCase().includes(payload.toLowerCase())) {
        throw new Error('verify_shared_data: readerTask 不许出现 payload——读取方必须从库里取,照抄指令即假 PASS(照抄闸)')
      }
      const marks = sanitizeMarks([payload])
      if (marks.length === 0) throw new Error('verify_shared_data: payload 未过标记消毒(太短/纯符号)——换一个独特字符串')
      const port = (ctx.get?.('webServer') as { port?: number } | undefined)?.port
      const agentInvolved = writerAppUrl === '' || readerAppUrl === ''
      if (agentInvolved && port === undefined) {
        return '共享数据验收跳过:无 webServer 端口(headless?)——班子未经共享验收,不可当作打通。'
      }

      // ── 双面交付路径(③交接考扩展):app 侧由考官亲自经其 HTTP 面执行 SQL,
      //    agent 侧走单轮真会话探针;照抄闸对两种侧一视同仁。
      if (appMode) {
        const t0m = Date.now()
        const appSql = async (base: string, sql: string): Promise<Record<string, unknown>> => {
          const r = await fetch(`${base}/api/sql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql }), signal: AbortSignal.timeout(10_000) })
          const j = (await r.json()) as Record<string, unknown>
          if (typeof j.error === 'string') throw new Error(j.error)
          return j
        }
        const lines: string[] = []
        let failReason = ''
        try {
          if (writerAppUrl !== '') {
            const j = await appSql(writerAppUrl, writerTask)
            if (typeof j.changes !== 'number' || j.changes < 1) failReason = `app 写入 0 行(${JSON.stringify(j).slice(0, 120)})`
            else lines.push(`写入方(app 面):INSERT 落 ${String(j.changes)} 行`)
          } else {
            const { runScenario } = await import('./verify.js')
            const w = await runScenario(port as number, writerId, { goal: '双面交接考·写', turns: [{ prompt: `${writerTask}\n完成后回复里包含 ${token}。不要问任何人。`, mustInclude: [token] }] }, config.verifyTimeoutMs ?? PROBE_TURN_BUDGET_MS, undefined, join(presetRoot, writerId, 'workspace'))
            if (w.status !== 'PASS') failReason = `agent 写入轮未过:${w.reason ?? w.status}`
            else lines.push('写入方(会话面):真会话写入 ✓')
          }
          if (failReason === '') {
            if (readerAppUrl !== '') {
              const j = await appSql(readerAppUrl, readerTask)
              const hit = JSON.stringify(j.rows ?? []).includes(payload)
              if (!hit) failReason = `app 读回的行里没有 payload(rows=${JSON.stringify(j.rows ?? []).slice(0, 160)})`
              else lines.push(`读取方(app 面):按 ${token} 查得 payload ✓`)
            } else {
              const { runScenario } = await import('./verify.js')
              const r = await runScenario(port as number, readerId, { goal: '双面交接考·读', turns: [{ prompt: readerTask, mustInclude: marks }] }, config.verifyTimeoutMs ?? PROBE_TURN_BUDGET_MS, undefined, join(presetRoot, readerId, 'workspace'))
              if (r.status !== 'PASS') failReason = `agent 读取轮未过:${r.reason ?? r.status}`
              else lines.push('读取方(会话面):真会话按键取回并报出 payload ✓')
            }
          }
        } catch (error: unknown) {
          failReason = error instanceof Error ? error.message : String(error)
        }
        const pass = failReason === ''
        const elapsedM = Math.round((Date.now() - t0m) / 1000)
        appendOrchLedger({ tool: VERIFY_SHARED_TOOL_NAME, mode: 'two-faced', writer: writerAppUrl !== '' ? 'app' : writerId, reader: readerAppUrl !== '' ? 'app' : readerId, pass, reason: failReason.slice(0, 160), elapsedSeconds: elapsedM })
        return `双面交接验收 ${pass ? 'PASS' : 'FAIL'}(${String(elapsedM)}s)— ${pass ? '两张脸真的共享同一本账' : failReason}\n${lines.join('\n')}`
          + prose(pass ? '\n【接力棒】如实向用户转述:app 面与会话面读写同一份数据,交接已由独立考官证实。' : '\n【外科决策归你】常见病:app 的 DB_PATH 与 preset 的 sharedDb/装备默认库不是同一个绝对路径;表名/列名对不上;app 未启动。修正后重验;禁止把 FAIL 说成通过。')
      }

      // 非 app 路径必有 agent 参与,上方守卫已保证 port 存在;此行只为类型收窄。
      if (port === undefined) return '共享数据验收跳过:无 webServer 端口(headless?)。'
      const t0 = Date.now()
      const job = startJob(ctx, 'verify-shared-data', `共享数据验收 ${writerId}→${readerId}`)
      const phase = (line: string): void => {
        job.phase(line)
        progressAppend(join(presetRoot, writerId), line)
        progressAppend(join(presetRoot, readerId), line)
      }
      try {
        const { runSharedDataProbe } = await import('./verify.js')
        const result = await runSharedDataProbe(
          port,
          { writerId, writerTask, readerId, readerTask, mustInclude: marks },
          join(presetRoot, writerId, 'workspace'),
          join(presetRoot, readerId, 'workspace'),
          config.verifyTimeoutMs ?? PROBE_TURN_BUDGET_MS,
          phase,
        )
        const elapsed = Math.round((Date.now() - t0) / 1000)
        job.settle(result.pass ? 'completed' : 'failed', result.pass ? 'PASS' : 'FAIL')
        appendOrchLedger({ tool: VERIFY_SHARED_TOOL_NAME, writerId, readerId, pass: result.pass, reason: result.reason.slice(0, 160), elapsedSeconds: elapsed })
        const contract = prose(result.pass
          ? '\n【接力棒】如实向用户转述:共享数据验收 PASS——班子真的读写同一份账。'
          : '\n【外科决策归你——考官不重试】证据在上:先诊断(共享表没建?两台 preset 的 sharedDb 路径不一致?读取方查错表?),修正后重发相关 preset 再重验;修不了就如实报告用户。红线:禁止手改 preset 文件,禁止把 FAIL 说成通过。')
        return `共享数据验收 ${result.pass ? 'PASS' : 'FAIL'}(${String(elapsed)}s)— ${result.reason}`
          + (result.writerReply !== undefined ? `\n写入方回复摘录:「${result.writerReply.slice(0, 120)}」` : '')
          + (result.readerReply !== undefined ? `\n读取方回复摘录:「${result.readerReply.slice(0, 120)}」` : '')
          + contract
      } catch (error: unknown) {
        job.settle('failed', error instanceof Error ? error.message.slice(0, 120) : String(error))
        throw error
      }
    },
  })
}

// ── verify_trigger:触发面考官(无人值守形态的第四格)──────────────────────
export const VERIFY_TRIGGER_TOOL_NAME = 'verify_trigger'

export function verifyTriggerToolDefinition(ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: VERIFY_TRIGGER_TOOL_NAME,
    description:
      'INDEPENDENT examiner for the UNATTENDED form: fires one task at a preset the way cron-trigger would (real wire session + the '
      + 'unattended discipline header), then judges by EFFECT — polls the preset\'s sqlite service face until your assertion holds. '
      + 'The reply is never read: the verdict is whether the row actually landed.'
      + prose(' Design YOUR exam: task = an explicit instruction carrying an invented token (the agent must WRITE it somewhere real); '
        + 'effectSql = the SELECT that proves it landed; expect = the token. PASS = 触发→执行→落库 闭环成立. '
        + 'Call after emitting a preset that mounts cron-trigger (or any preset meant to run unattended). '
        + 'FAIL 带证据:没干活 / 表列名不对 / 面不可达——外科修复后重验,连续 3 次 FAIL 停手上报。'),
    parameters: {
      presetId: { type: 'string', description: 'preset to wake up (must be emitted; needs a sqlite state part for the effect assertion)', required: true },
      task: { type: 'string', description: 'the unattended task instruction, carrying an invented token the agent must persist', required: true },
      effectSql: { type: 'string', description: 'SELECT proving the effect landed (run against the preset\'s default db via its service face)', required: true },
      expect: { type: 'string', description: 'the token/string that must appear in the effect rows', required: true },
      timeoutMs: { type: 'number', description: 'effect polling budget, default 240000' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown): Promise<string> => {
      const a = args as Record<string, unknown> | null
      const presetId = sanitizePresetName(String(a?.presetId ?? ''))
      const task = String(a?.task ?? '').trim()
      const effectSql = String(a?.effectSql ?? '').trim()
      const expect = String(a?.expect ?? '').trim()
      if (presetId === '' || task === '' || effectSql === '' || expect === '') {
        throw new Error('verify_trigger 需要 presetId / task / effectSql / expect(考卷归你设计:任务里带口令,断言查它落没落)')
      }
      if (expect.length < 4) throw new Error('verify_trigger: expect ≥4 字符(要够独特,别用 ok/done)')
      if (!task.includes(expect)) throw new Error('verify_trigger: task 必须包含 expect 口令(任务指令要自给自足)')
      if (!/^\s*(SELECT|WITH)\b/i.test(effectSql)) throw new Error('verify_trigger: effectSql 必须是只读查询(考官不改数据)')
      const presetRoot = presetRootOf(config)
      const presetDir = join(presetRoot, presetId)
      if (!existsSync(join(presetDir, 'agent.cordis.yml'))) throw new Error(`verify_trigger: preset「${presetId}」不存在——先 emit_preset`)
      const port = (ctx.get?.('webServer') as { port?: number } | undefined)?.port
      if (port === undefined) return '触发面验收跳过:无 webServer 端口(headless?)——无人值守形态未经验收,不可当作打通。'

      // 服务脸自给自足(与行为考同款):不在场则考官自拉 sqlite 零件
      const readFace = (): { url: string; token: string } | null => {
        const p = join(presetDir, 'workspace', '.service.json')
        if (!existsSync(p)) return null
        try { return (JSON.parse(readFileSync(p, 'utf8')) as { sqlite?: { url: string; token: string } }).sqlite ?? null } catch { return null }
      }
      const alive = async (f: { url: string; token: string } | null): Promise<boolean> => {
        if (f === null) return false
        try { return (await fetch(`${f.url}/schema`, { headers: { 'x-service-token': f.token }, signal: AbortSignal.timeout(1500) })).ok } catch { return false }
      }
      const job = startJob(ctx, 'verify-trigger', `触发面验收 ${presetId}`)
      const phase = (line: string): void => { job.phase(line); progressAppend(presetDir, line) }
      let face = readFace()
      let part: ReturnType<typeof spawnPart> | null = null
      const t0 = Date.now()
      try {
        if (!(await alive(face))) {
          phase('服务脸不在场——考官自行拉起 sqlite 零件(效果断言要读同一本账)')
          const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            PART_WORKDIR: join(presetDir, 'workspace'),
            SQLITE_DEFAULT_DB: join(presetDir, 'workspace', 'data.db'),
          }
          if (existsSync(join(presetDir, 'equipment', 'init.sql'))) env.SQLITE_INIT_DDL_FILE = join(presetDir, 'equipment', 'init.sql')
          part = spawnPart('node', [join(REPO, 'generated', 'sqlite-query', 'index.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] })
          for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 250)); face = readFace(); if (await alive(face)) break }
        }
        if (!(await alive(face)) || face === null) {
          job.settle('failed', '服务脸不可达')
          return `触发面验收 FAIL:服务脸不可达(preset ${presetId} 挂了 sqlite 状态零件吗?)——效果断言无处可查。`
        }
        const { runTriggerProbe } = await import('./verify.js')
        const out = await runTriggerProbe(port, {
          presetId, task, presetDir, effectSql, expect,
          faceUrl: face.url, faceToken: face.token,
          ...(typeof a?.timeoutMs === 'number' ? { timeoutMs: a.timeoutMs } : {}),
          onPhase: phase,
        })
        job.settle(out.pass ? 'completed' : 'failed', out.pass ? 'PASS' : 'FAIL')
        appendOrchLedger({ tool: VERIFY_TRIGGER_TOOL_NAME, presetId, pass: out.pass, reason: out.reason.slice(0, 160), elapsedSeconds: out.elapsedSeconds })
        return `触发面验收 ${out.pass ? 'PASS' : 'FAIL'}(${String(out.elapsedSeconds)}s)— ${out.reason}`
          + (out.sessionId !== undefined ? `\n被唤醒的会话:${out.sessionId}` : '')
          + prose(out.pass
            ? '\n【接力棒】如实转述:无人值守闭环(唤醒→执行→落库)已由独立考官证实;定时表达式本身由 cron-trigger 零件自带质检。'
            : '\n【外科决策归你】常见病:persona 没写清"被唤醒后干什么"、表/列名与装备 DDL 对不上、没挂状态零件。修正后重验。')
      } finally {
        part?.kill('SIGTERM')
        void (Date.now() - t0)
      }
    },
  })
}

// ── 配方车道:emit_app(哑实例化)+ verify_app(app 独立考官)──────────────────
// 配方 = app 形态的 preset(via:'recipe',recipes/<id>/):完整可跑项目模板 +
// 声明式参数槽 + 写死在清单里的自测考卷。分工与 preset 车道同构——实例化是
// 确定性印刷(零 LLM),验收是独立考官自己拉起 app 黑盒考(不依赖 DSH host)。
// 对照系(penguin-harness)把配方夹在 skill 散文里、builder 自测自报;我们的
// 配方过入库门、进 BOM、被独立考官验——同一招式,装在供应链上。

export const EMIT_APP_TOOL_NAME = 'emit_app'
export const VERIFY_APP_TOOL_NAME = 'verify_app'

export function emitAppToolDefinition(_ctx: Context, _config: Config): ToolDefinition {
  return defineTool({
    name: EMIT_APP_TOOL_NAME,
    description:
      'DUMB app materializer for via:"recipe" catalog entries (deterministic, zero LLM): copies the recipe\'s complete runnable template, '
      + 'injects params via app.config.json (template bytes stay pristine), copies the corpus into the app\'s corpus/ (self-contained '
      + 'deliverable), runs the recipe\'s deterministic ingest, and writes recipe.lock.yml (provenance + params + pending secrets).'
      + prose(' Recipe APPS are standalone processes — they never mount into a preset and cost ZERO tokens in any agent\'s prompt. '
        + 'YOU choose the recipe and author the params (that is selection intelligence); this tool only prints. '
        + 'SELFTEST_QUESTION/SELFTEST_MARKER params are the acceptance exam: pick a factual question the corpus definitely answers and a '
        + 'short fact-word from the corpus text (never a politeness word) — verify_app asks the REAL question black-box. '
        + 'Secrets NEVER go into params or files (machine-gated): the app reads them from its launch environment; missing ones are listed '
        + 'in the result as pending. After emitting, ALWAYS call verify_app — an unverified app is not a deliverable.'),
    parameters: {
      recipeId: { type: 'string', description: 'recipe id from the catalog (via:"recipe" entry\'s config.recipe, e.g. rag-qa)', required: true },
      name: { type: 'string', description: 'kebab-case app name; default target is ~/apps/<name>', required: true },
      targetDir: { type: 'string', description: 'absolute target directory (optional; default ~/apps/<name>; refuses non-empty unless fresh)' },
      params: { type: 'object', additionalProperties: true, description: 'recipe param slots as a flat string map (missing required ones come back as an actionable list); secret-shaped keys are refused by design', required: true },
      corpusDir: { type: 'string', description: 'absolute path of the document set to copy into the app (recipes that take a corpus)' },
      schemaFile: { type: 'string', description: 'absolute path of an idempotent DDL file copied in as schema.sql (record-shape recipes; the app-side twin of a preset\'s equipment DDL). For a two-faced delivery pass DB_PATH in params instead, pointing at the preset\'s workspace/data.db' },
      fresh: { type: 'boolean', description: 'true = wipe a non-empty targetDir and re-materialize (同址重印)' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown): Promise<string> => {
      const a = args as { recipeId?: unknown; name?: unknown; targetDir?: unknown; params?: unknown; corpusDir?: unknown; fresh?: unknown }
      const recipeId = String(a.recipeId ?? '').trim()
      const name = sanitizePresetName(String(a.name ?? ''))
      if (recipeId === '' || name === '') throw new Error('emit_app 需要 recipeId 与 kebab-case 的 name')
      const params: Record<string, string> = {}
      if (a.params !== null && typeof a.params === 'object') {
        for (const [k, v] of Object.entries(a.params as Record<string, unknown>)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params[k] = String(v)
        }
      }
      const targetDir = typeof a.targetDir === 'string' && a.targetDir.trim() !== '' ? a.targetDir.trim() : join(homedir(), 'apps', name)
      const t0 = Date.now()
      const result = materializeApp({
        recipeId,
        targetDir,
        params,
        ...(typeof a.corpusDir === 'string' && a.corpusDir.trim() !== '' ? { corpusDir: a.corpusDir.trim() } : {}),
        ...(typeof (a as { schemaFile?: unknown }).schemaFile === 'string' && ((a as { schemaFile?: string }).schemaFile ?? '').trim() !== '' ? { schemaFile: ((a as { schemaFile?: string }).schemaFile ?? '').trim() } : {}),
        ...(a.fresh === true ? { fresh: true } : {}),
      })
      appendOrchLedger({ tool: EMIT_APP_TOOL_NAME, recipe: recipeId, app: name, targetDir: result.targetDir, elapsedSeconds: Math.round((Date.now() - t0) / 1000) })
      const pending = result.pendingSecrets.filter((sm) => !sm.configured)
      return [
        `app 已实例化:${result.targetDir}(配方 ${result.recipe}@v${String(result.version)},模板哈希 ${result.templateHash})`,
        ...(result.corpus !== null ? [`语料:${String(result.corpus.files)} 个文件 / ${String(result.corpus.bytes)} 字节 → corpus/`] : []),
        ...(result.chunks !== null ? [`索引:${String(result.chunks)} 块(ingest 已在装配时跑完,交付即就绪)`] : []),
        ...(pending.length > 0
          ? [`待配凭证:${pending.map((sm) => `${sm.env}(${sm.purpose})`).join(';')} —— 值只进启动环境变量,不落文件`]
          : ['凭证:所需环境变量当前均已配置']),
        loadRecipe(recipeId).lockPaths !== undefined
          ? prose(SCAFFOLD_BATON.replace(/<targetDir>/g, result.targetDir))
          : prose(`【接力棒】立即 ${VERIFY_APP_TOOL_NAME} {"targetDir": "${result.targetDir}"} 独立验收——未验收的 app 不是交付物。启动方式:cd ${result.targetDir} && npm start`),
      ].filter((l) => l !== '').join('\n')
    },
  })
}

export function verifyAppToolDefinition(_ctx: Context, _config: Config): ToolDefinition {
  return defineTool({
    name: VERIFY_APP_TOOL_NAME,
    description:
      'INDEPENDENT examiner for recipe apps: boots the app itself from its directory (own process, free port), runs the recipe\'s '
      + 'declarative exam black-box over real HTTP (health + REAL question through the full retrieval+AI chain, source must resolve to a '
      + 'real corpus file AND a working link), then kills the process. Verdict PASS / FAIL / SKIPPED with per-check evidence.'
      + prose(' No retry loops inside — a FAIL comes back with which check broke and what the app actually returned, so the fix is surgical '
        + '(wrong corpus → re-emit with the right corpusDir; wrong marker → re-emit with a fact-word the corpus contains; app edited by hand '
        + '→ inspect the diff). Missing credential ≠ failure: the AI half reports SKIPPED with the env name while the retrieval half must '
        + 'still pass (interface-first credential contract). 同一 app 连续 3 次 FAIL 后停手上报,不要无脑重验。'),
    parameters: {
      targetDir: { type: 'string', description: 'the app directory emit_app produced (holds recipe.lock.yml)', required: true },
      wirePort: { type: 'number', description: 'host port for behavior-exam wire actions (scaffold deliveries; omit → wire actions report SKIPPED)' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown): Promise<string> => {
      const a = args as { targetDir?: unknown; wirePort?: unknown }
      const targetDir = String(a.targetDir ?? '').trim()
      if (targetDir === '' || !targetDir.startsWith('/')) throw new Error('verify_app 需要绝对路径 targetDir(emit_app 结果里的 app 目录)')
      const t0 = Date.now()
      const wirePort = typeof a.wirePort === 'number' ? a.wirePort : (_ctx.get?.('webServer') as { port?: number } | undefined)?.port
      const result = await runAppSelftest(targetDir, { ...(wirePort !== undefined ? { wirePort } : {}) })
      appendOrchLedger({ tool: VERIFY_APP_TOOL_NAME, targetDir, verdict: result.status, elapsedSeconds: Math.round((Date.now() - t0) / 1000) })
      const lines = result.checks.map((c) => `- [${c.status}] ${c.check}:${c.evidence}`)
      const head = result.status === 'PASS'
        ? `app 验收 PASS(${String(result.elapsedSeconds)}s,黑盒真跑)`
        : result.status === 'SKIPPED'
          ? `app 验收 SKIPPED(接口半边已核实,AI 半边待凭证;${String(result.elapsedSeconds)}s)`
          : `app 验收 FAIL(${String(result.elapsedSeconds)}s)`
      return [head, ...lines].join('\n')
    },
  })
}

// ── deploy_app:构建产物发布进 preset(写手席交付流第 4 步)────────────────────
// static-deploy 零件是给"交付出去的 agent 自建自发"用的(挂在 preset 里);
// 主 agent 在装配现场没有它的工具面,发布这步由本 host 面工具承接,闸门同款:
// preset 必须存在、dist/index.html 必须在、路径守卫。发布 = 确定性拷贝,印刷机职权。
export const DEPLOY_APP_TOOL_NAME = 'deploy_app'

export function deployAppToolDefinition(_ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: DEPLOY_APP_TOOL_NAME,
    description:
      'Publish a scaffold app\'s BUILT dist/ into its paired preset\'s frontend/ (served same-origin at /assembler/ui/<presetId>). '
      + 'Deterministic copy with gates: preset must exist, dist/index.html must exist (run verify_app first — its build gate produces dist), '
      + 'paths guarded.'
      + prose(' Call ONLY after verify_app PASS — publishing an unexamined page defeats the entire lane. '
        + 'After deploying, report the URL and the exam verdict to the user honestly.'),
    parameters: {
      targetDir: { type: 'string', description: 'the scaffold app directory (holds dist/ after verify_app\'s build gate)', required: true },
      presetId: { type: 'string', description: 'the paired preset id to publish into', required: true },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown): Promise<string> => {
      const a = args as { targetDir?: unknown; presetId?: unknown }
      const targetDir = String(a.targetDir ?? '').trim()
      const presetId = sanitizePresetName(String(a.presetId ?? ''))
      if (targetDir === '' || !targetDir.startsWith('/')) throw new Error('deploy_app 需要绝对路径 targetDir')
      if (presetId === '') throw new Error('deploy_app 需要 presetId')
      const dist = join(resolve(targetDir), 'dist')
      if (!existsSync(join(dist, 'index.html'))) {
        throw new Error(`deploy_app: ${dist}/index.html 不存在——先 verify_app(它的构建门产出 dist),PASS 后再发布`)
      }
      const presetRoot = presetRootOf(config)
      const presetDir = join(presetRoot, presetId)
      if (!existsSync(join(presetDir, 'agent.cordis.yml'))) {
        throw new Error(`deploy_app: preset「${presetId}」不存在——前端要发布进一个已发射的 preset`)
      }
      const target = join(presetDir, 'frontend')
      rmSync(target, { recursive: true, force: true })
      cpSync(dist, target, { recursive: true })
      const port = (_ctx.get?.('webServer') as { port?: number } | undefined)?.port
      const url = port !== undefined ? `http://127.0.0.1:${String(port)}/assembler/ui/${presetId}` : `/assembler/ui/${presetId}`
      appendOrchLedger({ tool: DEPLOY_APP_TOOL_NAME, presetId, targetDir, url })
      return `已发布:${dist} → ${target}\n页面:${url}${prose('\n【接力棒】向用户如实报告页面 URL 与验收结论;页面动作的行为考证据在 verify_app 的结果里。')}`
    },
  })
}

// ── add_knowledge:知识包入库(工具面版,治"沙箱够不着造件管道")────────────────
// 病史(2026-08-25 泛化战役 A1):契约让 agent 走 scripts/index-add.mjs 收知识包,
// 而那条管道住在装配器仓库里、会话 bash 沙箱够不着 → agent 花 15 分钟提权重试、
// 走不到验收。修法不是放宽沙箱(真实用户同样受限),是**把管道搬上工具面**:
// 工具在 host 进程里跑,天生跨沙箱;质检门(检索命中)一分不减。
export const ADD_KNOWLEDGE_TOOL_NAME = 'add_knowledge'

export function addKnowledgeToolDefinition(_ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: ADD_KNOWLEDGE_TOOL_NAME,
    description:
      'Ingest a DOCUMENT SET as a knowledge pack (via:"knowledge" catalog entry) so presets can mount it — the tool-surface twin of '
      + 'the induction CLI, so it works from any session regardless of shell sandbox. Copies the docs into the catalog, runs the '
      + 'RETRIEVAL GATE (your probe questions must find their expected verbatim snippets — a pack whose facts cannot be retrieved is '
      + 'rejected), and registers the capability entry.'
      + prose(' YOU write the probes: 2-4 real questions this document set answers, each with a verbatim snippet that MUST appear in '
        + 'the docs (a fact word, not a polite phrase). Gate failure comes back naming which snippet was not found — fix the snippet or '
        + 'the docs, do not weaken the probe. After it registers, search_catalog finds it and emit_preset can mount it (the pack is '
        + 'copied into the preset\'s kb/ — deliverables stay self-contained).'),
    parameters: {
      docsDir: { type: 'string', description: 'absolute path of the directory holding the documents (.md/.txt/.markdown)', required: true },
      id: { type: 'string', description: 'kebab-case pack id (e.g. acme-manual)', required: true },
      description: { type: 'string', description: 'what this pack is, in the words a selector would search for (goes into the catalog entry)', required: true },
      tags: { type: 'array', items: { type: 'string' }, description: 'search tags (domain words, both Chinese and English)' },
      probes: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'retrieval gate: [{question, mustInclude:["逐字片段"]}] — 2-4 entries; the snippets must literally appear in the docs',
        required: true,
      },
      source: { type: 'string', description: 'provenance note (where these docs came from)' },
      version: { type: 'string', description: 'pack version, default today' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown): Promise<string> => {
      const a = args as Record<string, unknown> | null
      const docsDir = String(a?.docsDir ?? '').trim()
      const id = String(a?.id ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
      const description = String(a?.description ?? '').trim()
      const probes = Array.isArray(a?.probes) ? a.probes as Array<Record<string, unknown>> : []
      if (docsDir === '' || !docsDir.startsWith('/')) throw new Error('add_knowledge 需要 docsDir(文档目录的绝对路径)')
      if (id === '') throw new Error('add_knowledge 需要 id(kebab-case 包名)')
      if (description === '') throw new Error('add_knowledge 需要 description(选型器要靠它检索到这包知识)')
      if (probes.length === 0) throw new Error('add_knowledge 需要 probes:检索门考题 [{question, mustInclude:["逐字片段"]}]——没有考题的知识包不许入库')
      if (!existsSync(docsDir)) throw new Error(`add_knowledge: 文档目录不存在:${docsDir}`)

      const repoRoot = REPO
      const packDir = join(repoRoot, 'knowledge', id)
      const docsOut = join(packDir, 'docs')
      mkdirSync(docsOut, { recursive: true })

      // 收文档(与 CLI 同口径:文本类,扁平化文件名,记字节)
      const exts = new Set(['.md', '.txt', '.markdown'])
      const collect = (dir: string, acc: string[] = []): string[] => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith('.')) continue
          const p = join(dir, e.name)
          if (e.isDirectory()) collect(p, acc)
          else if (exts.has(p.slice(p.lastIndexOf('.')).toLowerCase())) acc.push(p)
        }
        return acc
      }
      const docs = collect(docsDir)
      if (docs.length === 0) throw new Error(`add_knowledge: ${docsDir} 里没有 .md/.txt/.markdown 文档`)
      let totalBytes = 0
      for (const d of docs) {
        const rel = d.slice(docsDir.replace(/\/$/, '').length + 1).replace(/[/\\]/g, '__')
        const bytes = readFileSync(d)
        writeFileSync(join(docsOut, rel), bytes)
        totalBytes += bytes.length
      }

      // 检索门:考题的逐字片段必须真能在文档里找到(找不到 = 这包知识对 agent 不可用)
      const corpus = readdirSync(docsOut).map((f: string) => ({ name: f, text: readFileSync(join(docsOut, f), 'utf8').toLowerCase() }))
      const results = probes.map((p) => {
        const marks = (Array.isArray(p.mustInclude) ? p.mustInclude : []).map(String)
        const hits = marks.map((m) => {
          const doc = corpus.find((c: { name: string; text: string }) => c.text.includes(m.toLowerCase()))
          return { mark: m, found: doc !== undefined, in: doc?.name ?? null }
        })
        return { question: String(p.question ?? ''), hits, pass: marks.length > 0 && hits.every((h) => h.found) }
      })
      const failed = results.filter((r) => !r.pass)
      if (failed.length > 0) {
        rmSync(packDir, { recursive: true, force: true })
        throw new Error(`add_knowledge: 检索门未过(${failed.length}/${results.length} 条考题检不出预期片段),知识包已丢弃——`
          + failed.map((r) => `「${r.question.slice(0, 30)}」缺:${r.hits.filter((h) => !h.found).map((h) => h.mark).join('/')}`).join(';')
          + prose(' 修片段或补文档,不要削弱考题。'))
      }

      const meta = {
        id, kind: 'knowledge', client: null,
        source: typeof a?.source === 'string' ? a.source : docsDir,
        version: typeof a?.version === 'string' ? a.version : new Date().toISOString().slice(0, 10),
        license: '(客户资料:以合同为准)',
        docCount: docs.length, totalBytes,
        scaffoldedAt: new Date().toISOString(),
      }
      writeFileSync(join(packDir, '.knowledge-meta.json'), JSON.stringify(meta, null, 2) + '\n')
      writeFileSync(join(packDir, 'probes.json'), JSON.stringify({ probes: probes.map((p) => ({ question: p.question, mustInclude: p.mustInclude })) }, null, 2) + '\n')
      mkdirSync(join(repoRoot, 'index', 'reports'), { recursive: true })
      writeFileSync(join(repoRoot, 'index', 'reports', `knowledge-${id}.json`), JSON.stringify({ id, kind: 'knowledge', verifiedAt: new Date().toISOString(), probes: results }, null, 2) + '\n')

      // 登记能力条目(幂等:同 id 不重复追加)
      const capsPath = config.catalogPath ?? join(repoRoot, 'capabilities.yml')
      const caps = readFileSync(capsPath, 'utf8')
      const capId = `kb-${id}`
      let registered = false
      if (!new RegExp(`^  - id: ${capId}$`, 'm').test(caps)) {
        const tags = (Array.isArray(a?.tags) ? a.tags as unknown[] : []).map((t) => JSON.stringify(String(t))).join(', ')
        const entry = `  - id: ${capId}\n    via: knowledge\n    description: ${JSON.stringify(description)}\n    tags: [${tags}]\n    config:\n      pack: ${JSON.stringify(id)}\n`
        writeFileSync(capsPath, caps.replace(/\n*$/, '\n') + entry)
        registered = true
      }
      appendOrchLedger({ tool: ADD_KNOWLEDGE_TOOL_NAME, id, docs: docs.length, bytes: totalBytes, probes: results.length })
      return `知识包 ${id} 已入库:${String(docs.length)} 份文档 / ${String(totalBytes)} 字节;检索门 ${String(results.length)}/${String(results.length)} 条考题命中`
        + `\n目录条目:${capId}${registered ? '(已登记)' : '(已存在)'}`
        + prose(`\n【接力棒】现在可以 ${EMIT_TOOL_NAME} 时把 "${capId}" 放进 capabilityIds——它会被拷进 preset 的 kb/,交付物自包含。`)
    },
  })
}

export const READ_PRESET_TOOL_NAME = 'read_preset'
export const SUBMIT_PART_TOOL_NAME = 'submit_part'

/**
 * 契约动作 ↔ 工具面 对照表(机械闸的数据源)。
 *
 * 铁律:**契约要求 agent 做的每个动作,都必须有一张够得着的工具面**——契约住在
 * prompt 里,而 agent 的 shell 关在会话沙箱里;凡是要碰装配器资源(目录/preset/
 * 配方/知识包)的动作,只要没有工具面,agent 就只能撞墙提权重试。实测代价:两道
 * 题各烧 30 分钟、颗粒无收(2026-08-25 泛化战役 B3/C3)。
 *
 * 加新动作进契约时,同时在这里登记它的工具;单测逐条断言工具真被注册、且契约
 * 里真点名了它——忘了配工具,测试当场红。
 */
export const CONTRACT_ACTIONS: ReadonlyArray<{ action: string; tool: string; why: string }> = [
  { action: '选型(检索零件)', tool: SEARCH_TOOL_NAME, why: '目录在装配器进程里,不在会话文件系统里' },
  { action: '发射 preset', tool: EMIT_TOOL_NAME, why: 'preset 目录在 $DSH_HOME 下,沙箱之外' },
  { action: '独立验收 preset', tool: VERIFY_TOOL_NAME, why: '要开真会话,只有 host 能开' },
  { action: '实例化 app(配方)', tool: EMIT_APP_TOOL_NAME, why: '配方模板在装配器仓库里' },
  { action: '独立验收 app', tool: VERIFY_APP_TOOL_NAME, why: '要拉起进程并黑盒考' },
  { action: '发布前端进 preset', tool: DEPLOY_APP_TOOL_NAME, why: '目标目录在沙箱外' },
  { action: '验收多 agent 共享数据', tool: VERIFY_SHARED_TOOL_NAME, why: '跨 preset 会话,只有 host 能开' },
  { action: '验收无人值守触发', tool: VERIFY_TRIGGER_TOOL_NAME, why: '要经 wire 唤醒并验落库效果' },
  { action: '收知识包进目录', tool: ADD_KNOWLEDGE_TOOL_NAME, why: '目录与知识区在仓库里,沙箱够不着(实测烧 15 分钟)' },
  { action: '读 preset 的装备 DDL/BOM/persona', tool: READ_PRESET_TOOL_NAME, why: '契约要求"列名照抄装备 DDL",但那目录沙箱读不到' },
  { action: '把自己写的零件收进目录', tool: SUBMIT_PART_TOOL_NAME, why: 'CLI 住在仓库里;沙箱够不着(实测两题各烧 30 分钟)' },
]

// ── 装配器资源只经装配器工具面读写(泛化战役的通用结论)────────────────────────
// 原则:装配器自己的资源(目录、preset、配方、知识包)住在会话沙箱之外,契约
// **不得指向文件路径**,一律经工具面读写。实测代价:契约点名 scripts/index-add.mjs,
// agent 照做 → 沙箱拒 → 86 次 bash 提权重试 → 整题颗粒无收(B3/C3 同病)。
// 下面两个工具补齐"读 preset"与"造零件"两条路。

export function readPresetToolDefinition(_ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: READ_PRESET_TOOL_NAME,
    description:
      'Read an emitted preset\'s artifacts: persona, equipment DDL (the table schema its pages must copy column names from), parts BOM, '
      + 'selfcheck plan, mounted service faces, and frontend info. The preset lives outside your shell sandbox — this tool is how you see it.'
      + prose(' Use before writing pages against a preset\'s database (column names come from the DDL, never invent), before re-emitting '
        + '(read the current persona first), and when reporting a delivery (BOM + verdict are the evidence).'),
    parameters: {
      presetId: { type: 'string', description: 'the preset id', required: true },
      include: { type: 'array', items: { type: 'string' }, description: 'optional subset: persona | ddl | bom | selfcheck | faces | frontend (default: all)' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown): Promise<string> => {
      const a = args as { presetId?: unknown; include?: unknown }
      const presetId = sanitizePresetName(String(a?.presetId ?? ''))
      if (presetId === '') throw new Error('read_preset 需要 presetId')
      const dir = join(presetRootOf(config), presetId)
      if (!existsSync(join(dir, 'agent.cordis.yml'))) throw new Error(`read_preset: preset「${presetId}」不存在(先 emit_preset,或核对名字)`)
      const want = Array.isArray(a?.include) && a.include.length > 0 ? new Set(a.include.map(String)) : null
      const on = (k: string): boolean => want === null || want.has(k)
      const out: string[] = [`preset ${presetId}(${dir})`]
      if (on('persona')) {
        const rows = yaml.load(readFileSync(join(dir, 'agent.cordis.yml'), 'utf8')) as Array<Record<string, any>> | null
        const persona = (rows ?? []).find((r) => r?.id === 'persona')?.config?.text
        out.push(`\n【persona】\n${typeof persona === 'string' ? persona : '(无)'}`)
      }
      if (on('ddl')) {
        const ddlPath = join(dir, 'equipment', 'init.sql')
        out.push(`\n【装备 DDL(表结构;列名照抄这里,别发明)】\n${existsSync(ddlPath) ? readFileSync(ddlPath, 'utf8') : '(该 preset 没有状态零件/装备)'}`)
      }
      if (on('bom')) {
        const bomPath = join(dir, 'parts.lock.yml')
        out.push(`\n【BOM】\n${existsSync(bomPath) ? readFileSync(bomPath, 'utf8').slice(0, 4000) : '(无)'}`)
      }
      if (on('selfcheck')) {
        const scPath = join(dir, 'selfcheck.json')
        out.push(`\n【自检包(随件考卷)】\n${existsSync(scPath) ? readFileSync(scPath, 'utf8').slice(0, 2000) : '(尚未验收通过)'}`)
      }
      if (on('faces')) {
        const svcPath = join(dir, 'workspace', '.service.json')
        out.push(`\n【服务脸(页面可直连的零件面)】\n${existsSync(svcPath)
          ? Object.entries(JSON.parse(readFileSync(svcPath, 'utf8')) as Record<string, { url?: string }>)
            .map(([k, v]) => `${k}: ${v.url ?? '?'}`).join('\n')
          : '(尚未开过会话——挂载后才有;页面里用 SDK 的 faces()/face(name) 取)'}`)
      }
      if (on('frontend')) {
        const fePath = join(dir, 'frontend', 'index.html')
        out.push(`\n【前端】${existsSync(fePath) ? `已发射(${statSync(fePath).size} 字节)· /assembler/ui/${presetId}` : '(无)'}`)
      }
      appendOrchLedger({ tool: READ_PRESET_TOOL_NAME, presetId })
      return out.join('\n')
    },
  })
}

export function submitPartToolDefinition(_ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: SUBMIT_PART_TOOL_NAME,
    description:
      'Submit a NEW PART you wrote (an MCP stdio server) into the catalog — the tool-surface twin of the induction CLI, because the '
      + 'catalog lives outside your shell sandbox. You supply the source; this tool writes it into the catalog, installs deps, runs YOUR '
      + 'smoke (exit 0 required), independently probes listTools, and registers it only if every gate passes. Nothing is registered on failure.'
      + prose(' 分工不变:写代码是你的活(你有全套 coding harness),执行与质检门是装配器的活。'
        + 'smoke 必须真调工具、断言真结果——照抄别的零件的 smoke 或只断言"没抛错"会让缺陷溜进目录(实录:一次被绕过的门藏了个进程悬挂缺陷)。'
        + 'FAIL 带冒烟原文返回,修好再交;连续 3 次不过就停手上报,不要盲改。'),
    parameters: {
      id: { type: 'string', description: 'kebab-case part id (becomes generated/<id>/)', required: true },
      indexJs: { type: 'string', description: 'the MCP stdio server source (index.js, ESM)', required: true },
      smokeMjs: { type: 'string', description: 'smoke.mjs — real calls with real assertions; exit non-zero on failure', required: true },
      dependencies: { type: 'object', additionalProperties: true, description: 'npm deps map, e.g. {"zod":"^3.23.0"} (@modelcontextprotocol/sdk is added automatically)' },
      meta: { type: 'object', additionalProperties: true, description: 'provenance: {repo, license, kind?:"service", service?, terms?, rateLimit?, requiredSecrets?:[{env,purpose}]}', required: true },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown): Promise<string> => {
      const a = args as Record<string, unknown> | null
      const id = String(a?.id ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
      const indexJs = String(a?.indexJs ?? '')
      const smokeMjs = String(a?.smokeMjs ?? '')
      const meta = (a?.meta ?? {}) as Record<string, unknown>
      if (id === '') throw new Error('submit_part 需要 id(kebab-case)')
      if (indexJs.trim() === '' || smokeMjs.trim() === '') throw new Error('submit_part 需要 indexJs 与 smokeMjs(没有冒烟的零件不许入库——验收永远归门,不归自述)')
      if (typeof meta.license !== 'string' || String(meta.license).trim() === '') throw new Error('submit_part 需要 meta.license(供应链出处:许可证必填)')
      const dir = join(REPO, 'generated', id)
      if (existsSync(join(dir, '.index-meta.json'))) throw new Error(`submit_part: 零件 ${id} 已存在——换 id,或先与用户确认是否取代旧件(装配器不静默覆盖既有零件)`)

      mkdirSync(dir, { recursive: true })
      const deps = { '@modelcontextprotocol/sdk': '^1.0.0', ...(a?.dependencies !== null && typeof a?.dependencies === 'object' ? a.dependencies as Record<string, string> : {}) }
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: `@dsh-index/${id}`, version: '0.0.1', type: 'module', private: true,
        description: String(meta.description ?? `MCP stdio server: ${id}`), dependencies: deps,
      }, null, 2) + '\n')
      writeFileSync(join(dir, 'index.js'), indexJs.endsWith('\n') ? indexJs : indexJs + '\n')
      writeFileSync(join(dir, 'smoke.mjs'), smokeMjs.endsWith('\n') ? smokeMjs : smokeMjs + '\n')
      writeFileSync(join(dir, '.index-meta.json'), JSON.stringify({
        id, pkg: meta.pkg ?? null, version: '0.0.1',
        repo: meta.repo ?? 'TT-Wang/dsh-assembler', license: meta.license,
        ...(meta.kind === 'service' ? { kind: 'service', service: meta.service ?? '', provider: meta.provider ?? '', terms: meta.terms ?? '', rateLimit: meta.rateLimit ?? '', network: true } : {}),
        ...(Array.isArray(meta.requiredSecrets) ? { requiredSecrets: meta.requiredSecrets } : {}),
        submittedByAgent: true, scaffoldedAt: new Date().toISOString(),
      }, null, 2) + '\n')

      const fail = (why: string): never => {
        rmSync(dir, { recursive: true, force: true })
        throw new Error(`submit_part: ${why}(零件已丢弃,目录未被污染)`)
      }
      try {
        execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error: unknown) {
        const e = error as { stderr?: string; stdout?: string }
        fail(`npm install 失败:${String(e.stderr ?? e.stdout ?? '').slice(-400)}`)
      }
      try {
        execFileSync('node', ['smoke.mjs'], { cwd: dir, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error: unknown) {
        const e = error as { stderr?: string; stdout?: string }
        fail(`冒烟未过——原文:\n${`${String(e.stdout ?? '')}\n${String(e.stderr ?? '')}`.trim().slice(-800)}`)
      }
      // 独立实探:不信 smoke 自报,从装配器自身依赖直连
      let tools: Array<{ name: string; description: string }> = []
      try {
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
        const c = new Client({ name: 'submit-part-probe', version: '0.0.1' })
        await c.connect(new StdioClientTransport({ command: 'node', args: [join(dir, 'index.js')], env: process.env as Record<string, string> }))
        tools = (await c.listTools()).tools.map((t) => ({ name: t.name, description: (t.description ?? '').replace(/\n[\s\S]*/, '').slice(0, 120) }))
        await c.close()
      } catch (error: unknown) {
        fail(`独立实探失败(listTools):${error instanceof Error ? error.message.slice(0, 300) : String(error)}`)
      }
      if (tools.length === 0) fail('listTools 为空——不是可用的 MCP server')

      mkdirSync(join(REPO, 'index', 'reports'), { recursive: true })
      writeFileSync(join(REPO, 'index', 'reports', `${id}.json`), JSON.stringify({ id, verifiedAt: new Date().toISOString(), node: process.version, smoke: 'pass', submittedByAgent: true, tools }, null, 2) + '\n')
      // 登记走既有 CLI(幂等命令,与人手入库同一条路——一个零件一种登记法)
      let registered: string
      try {
        const outText = execFileSync('node', [join(REPO, 'scripts', 'index-add.mjs'), 'register', id], { cwd: REPO, encoding: 'utf8', timeout: 60_000 })
        const j = JSON.parse(outText.trim().split('\n').pop() ?? '{}') as { ok?: boolean; registered?: string[]; error?: string }
        registered = j.ok === true ? `已登记(${(j.registered ?? []).join(', ') || '幂等无改动'})` : `登记未完成:${String(j.error ?? '').slice(0, 160)}`
      } catch (error: unknown) {
        registered = `已过门但登记未完成:${error instanceof Error ? error.message.slice(0, 160) : String(error)}(工件在 generated/${id},可手工 register)`
      }
      appendOrchLedger({ tool: SUBMIT_PART_TOOL_NAME, id, tools: tools.length })
      return `零件 ${id} 已过门入库:${String(tools.length)} 个工具(${tools.map((t) => t.name).join(', ')})\n冒烟 PASS · 独立实探 PASS · ${registered}`
        + prose(`\n【接力棒】现在 search_catalog 能检得它;要用就把它的能力 id 放进 emit_preset 的 capabilityIds。`)
    },
  })
}
