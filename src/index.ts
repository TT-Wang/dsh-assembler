/**
 * assemble — the vibe-assembly core, as a dsh plugin.
 *
 * Natural-language agent requirement → composed agent preset, by matching
 * against the capability catalog (capabilities.yml). The LLM does ONLY the
 * semantic mapping (requirement → capability ids); preset emission is
 * deterministic (catalog lookup + template fill), so the output is
 * auditable and replayable.
 *
 * The plugin exposes the capability twice: the `/assemble` command (human
 * shortcut) and the `assemble` tool (agent-native: the agent loop renders the
 * call with full trajectory — see assemble-tool.ts). Both write a new agent
 * preset under $DSH_HOME/.agent-presets/<id>/, which the roster picks up for
 * later sessions. Unlike the CLI prototype, model calls go through the host's
 * `ctx.llm` (provider/key from the host config), not a private fetch.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { BlockAssembler, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import yaml from 'js-yaml'
import { assembleToolDefinition } from './assemble-tool.js'
import { solutionToolDefinition } from './solution-tool.js'
import { askCatalogToolDefinition, assemblerMode, deployAppToolDefinition, draftAssemblyToolDefinition, emitAppToolDefinition, emitPresetToolDefinition, matchCatalogToolDefinition, searchCatalogToolDefinition, verifyAppToolDefinition, verifyPresetToolDefinition, verifyTriggerToolDefinition, verifySharedDataToolDefinition } from './orchestrated-tools.js'
import { specExperimentToolDefinition, deriveArchSpec, validateArchProbe } from './arch-spec.js'
import { shortlistCapabilities } from './capability-index.js'
import { AUX_CALL_TIMEOUT_MS, addUsage, deriveProbePlan, parseModelJson, runFrontendGate, runProbe, runScenario, sanitizeMarks, usageDetail, type AuxUsage, type ProbePlan, type ProbeResult } from './verify.js'
import { DEFAULT_FRONTEND_TEMPLATE, FRONTEND_ROUTE, emitFrontend, frontendRouteHandler } from './frontend.js'

export { FRONTEND_ROUTE, FRONTEND_TEMPLATES_DIR, DEFAULT_FRONTEND_TEMPLATE, emitFrontend, fillTemplate, listAssemblyProgress, listFrontendTemplates, resolveFrontendFile, frontendRouteHandler } from './frontend.js'
import { lintPersona, resolvePersonaText, type PersonaLintFinding } from './persona-lint.js'

export { lintPersona, resolvePersonaText, type PersonaLintFinding } from './persona-lint.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Harness preset id pattern (dsh-agent-presets PRESET_ID): lowercase alnum + hyphens, starts alnum. */
const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/

/** Longest preset id this assembler will emit (keeps paths and picker rows friendly). */
const MAX_PRESET_ID_LENGTH = 48

export interface Config {
  /** Run the assemble-then-verify probe after emitting (default true). */
  verify?: boolean
  /** Probe turn timeout in ms (default 300000). */
  verifyTimeoutMs?: number
  /**
   * How long a ledgered PASS may be carried forward for byte-identical preset
   * generations (default {@link VERIFY_CARRY_TTL_MS}). Service parts drift
   * server-side, so carried evidence expires like the federation cache does.
   */
  verifyCarryTtlMs?: number
  /** Catalog path (default: this package's capabilities.yml). */
  catalogPath?: string
  /** Preset template path (default: this package's presets/agent-template.yml). */
  templatePath?: string
  /** Provider route for the decomposition model call (default: host default). */
  provider?: string
  /** Model id for the decomposition call (default: host default). */
  model?: string
  /**
   * Reasoning effort for the assembler's OWN aux calls (selection + probe
   * derivation): 'off' | 'low' | 'high' | 'max'. 只辖装配器内部调用,与用户
   * 会话/探针 agent 的模型档位无关。
   *
   * 默认**不降档**(继承 connection 默认,通常 max)——这是刻意的产品判断:
   * 三臂 A/B 实测 off 把推导 61-90s 压到确定性 2-3s(思 0)且简单需求下场景
   * 照样成形,但选型/推导的质量在**复杂生产需求**上对降档的敏感度没有可信的
   * 测量手段(45 题 bench 全是浅题,off 全过也证明不了什么——不敏感的门不算门),
   * 所以生产默认保守。迭代/开发环路里明确配 'off' 换 30 倍装配器开销降幅。
   */
  auxReasoningEffort?: string
  /** Where assembled presets are written (default: $DSH_HOME/.agent-presets). */
  presetRoot?: string
}

export interface CapabilityEntry {
  id: string
  /**
   * 'frontend' 是第五种零件:人机交互面模板(frontends/<template>/),装配时
   * 填参发射进 preset 的 frontend/,由 /assembler/ui/<id> 同源伺服——性质上是
   * 装备(agent 不"调用"它,人用它操作 agent)。
   * 'recipe' 是第六种零件:独立 app 的组装图纸(recipes/<id>/,完整可跑项目
   * 模板+参数槽+自测考卷)。不进 preset:emit_app 实例化成独立进程的交付物,
   * verify_app 独立验收——app 形态的 preset 对位物。
   */
  via: 'package' | 'harness' | 'mcp' | 'knowledge' | 'frontend' | 'recipe'
  tool?: string
  description: string
  tags: string[]
  config?: Record<string, unknown> & {
    enabled?: boolean
    persona?: string
    baselineTools?: string[]
    presetRows?: Array<{ id: string; name: string; config?: Record<string, unknown> }>
    /** via:'frontend':frontends/ 下的模板目录名(缺省用条目 id)。 */
    template?: string
    /** via:'recipe':recipes/ 下的配方目录名。 */
    recipe?: string
    /** via:'recipe':凭证声明直挂条目(配方不是 mcp server,没有连接配置可挂)。 */
    requiredSecrets?: Array<{ env: string; purpose: string }>
  }
}

export interface Catalog {
  capabilities: CapabilityEntry[]
  /** Connection configs for MCP servers whose tools the assembler can select. */
  'mcp-servers'?: Record<string, Record<string, unknown>>
}

/** One missing-capability drafting suggestion produced by the matcher LLM. */
export interface MissingDraft {
  id: string
  via: 'package' | 'harness' | 'mcp' | 'knowledge'
  description: string
  tags: string[]
  /** Package tool name for `via: package` entries (e.g. `send_email`). */
  tool?: string
  /** Plugin package / tool-row name to mount, e.g. `@deepseek-ai/dsh-tool-fs-search`. */
  mount?: { name: string; config?: Record<string, unknown> }
}

interface AssembleRequest {
  capabilityIds: string[]
  /** Non-secret deployment parameters filling `{{param:key}}` slots. */
  params?: Record<string, string>
  missing: string[]
  rationale: string
  /** Generated persona text, used only when the catalog offers no persona. */
  persona?: string
  /**
   * Idempotent SQLite DDL pre-designing the agent's state tables (matcher-
   * drafted when a SQLite state capability is selected). 装配时想一次 schema,
   * 运行时零设计 — see installStateEquipment.
   */
  stateSchema?: string
  /** Draft capability entries for each missing item (see MissingDraft). */
  missingEntries?: MissingDraft[]
  /**
   * Suggested preset id (kebab-case slug) derived from the requirement, e.g.
   * "web-research-assistant". Used as the preset's directory id when the
   * caller did not name the preset explicitly.
   */
  name?: string
}

/** Depth limit for `extends` chains: a cycle would otherwise recurse forever. */
const MAX_CATALOG_LAYERS = 8

/**
 * Collapse preset rows contributed by more than one capability, first wins.
 *
 * A loader entry id must appear once in a preset; the host refuses the whole
 * preset otherwise ("duplicate loader entry id: tool-fs-search"). Two
 * capabilities legitimately wanting the same row is NORMAL — a knowledge pack
 * needs file search, and so does a content-search capability — and when both
 * get selected the preset must still mount. Provenance is not lost: the parts
 * lock records each capability's own `mounts`, so the BOM still shows that both
 * asked for this row.
 *
 * First wins on a config conflict rather than merging: a merged config is one
 * nobody wrote and nobody reviewed.
 */
export function dedupeRowsById<T extends { id: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>()
  const kept: T[] = []
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    kept.push(row)
  }
  return kept
}

/**
 * Read a catalog, applying its `extends:` base underneath it.
 *
 * A client catalog LAYERS over the public one rather than replacing it, the
 * same way a dsh profile stacks patches over its bundles. Without this, a
 * client whose own parts are public infrastructure could not be assembled at
 * all: pointing the assembler at `catalogs/<client>/capabilities.yml` showed
 * the client's policy and none of the shared parts, and the only way out was
 * to re-wrap the same public API once per client — exactly what the dedup gate
 * exists to prevent.
 *
 * The client layer wins on id collisions, so a client can override a shared
 * entry (a stricter persona, a different server command) by declaring the same
 * id. `extends` is relative to the file that declares it.
 */
/**
 * Every catalog file in an `extends` chain, base first.
 *
 * The BOM needs this because provenance lives in `index/catalog.yml` NEXT TO
 * each catalog, and a layered catalog therefore has a layered index. Reading
 * only the top layer's index emptied the handover's supply-chain column the
 * first time a client catalog extended the public one — the part rows were
 * there, with no repo, rev or licence against any of them, which is precisely
 * the column that table exists for.
 */
export function catalogChain(path: string, seen: readonly string[] = []): string[] {
  const here = resolve(path)
  if (seen.includes(here) || seen.length >= MAX_CATALOG_LAYERS) return [here]
  const raw = (yaml.load(readFileSync(here, 'utf8')) ?? {}) as { extends?: unknown }
  if (typeof raw.extends !== 'string' || raw.extends === '') return [here]
  return [...catalogChain(resolve(dirname(here), raw.extends), [...seen, here]), here]
}

export function loadCatalog(path: string, seen: readonly string[] = []): Catalog {
  const here = resolve(path)
  if (seen.includes(here)) {
    throw new Error(`catalog extends cycle: ${[...seen, here].map((p) => p.replace(REPO + '/', '')).join(' -> ')}`)
  }
  if (seen.length >= MAX_CATALOG_LAYERS) {
    throw new Error(`catalog extends chain deeper than ${MAX_CATALOG_LAYERS} layers — likely a mistake`)
  }
  const raw = (yaml.load(readFileSync(here, 'utf8')) ?? {}) as Partial<Catalog> & { extends?: unknown }
  // An empty `capabilities:` section parses to null, which is the NORMAL
  // state of a freshly created client catalog (parts registered, no static
  // entries yet). Normalizing here keeps every downstream `.map`/`.filter`
  // honest instead of crashing federation on a legitimately empty catalog.
  const own: Catalog = {
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities : [],
    'mcp-servers': (raw['mcp-servers'] ?? {}) as Record<string, Record<string, unknown>>,
  }
  if (typeof raw.extends !== 'string' || raw.extends === '') return own

  const base = loadCatalog(resolve(dirname(here), raw.extends), [...seen, here])
  const overridden = new Set(own.capabilities.map((c) => c.id))
  return {
    capabilities: [...base.capabilities.filter((c) => !overridden.has(c.id)), ...own.capabilities],
    'mcp-servers': { ...base['mcp-servers'], ...own['mcp-servers'] },
  }
}

export async function llmMapRequirement(
  ctx: Context,
  requirement: string,
  catalog: Catalog,
  model: { provider?: string; model?: string },
  config?: Config,
  onUsage?: (u: AuxUsage) => void,
  archSpec?: import('./arch-spec.js').ArchSpec,
  onShortlist?: (info: { total: number; kept: number }) => void,
): Promise<AssembleRequest> {
  const usableAll = catalog.capabilities.filter((c) => c.config?.enabled !== false)
  // 两阶段选型第一阶段(能力目录粗筛):**默认关**,DSH_ASSEMBLER_SHORTLIST=1 才开。
  // 诚实结论(2026-08-22 A/B 实测):粗筛把 267→91 候选,但选型时间**没变快**
  // (粗筛开 275s / 关 174s,更慢那次是运行间抖动)——选型是**推理绑定**,不是
  // 目录大小绑定(呼应"99% 是模型解码"取证),压缩输入治不了满档推理时间。粗筛
  // 保留在此当"小模型做零件发现"的规则版基础,但默认不开:它不提速、还有召回
  // 风险,不该误当提速。真正的提速杠杆在别处:重试轮(实测一轮 297s = 又一次
  // 选型+探针)、探针并行、以及降推理档(用户裁定生产不降)。
  const SHORTLIST_THRESHOLD = 100
  let usable = usableAll
  if (process.env.DSH_ASSEMBLER_SHORTLIST === '1' && usableAll.length > SHORTLIST_THRESHOLD) {
    const queries = archSpec !== undefined && archSpec.capabilities.length > 0
      ? [...archSpec.capabilities.map((c) => `${c.name} ${c.why}`), requirement]
      : [requirement]
    const sl = shortlistCapabilities(usableAll, queries)
    usable = usableAll.filter((c) => sl.ids.has(c.id))
    onShortlist?.({ total: usableAll.length, kept: usable.length })
  }
  const ids = usable.map((c) => c.id)
  const tagsIndex = usable.map((c) => `${c.id}: ${c.tags.join(', ')} — ${c.description}`).join('\n')
  // 架构优先(实验证明:选型优先对复杂 agent 三战三次报"0 缺口",静默丢弃真需求,
  // 含医疗导诊的安全缺口)。给了架构 spec 就把它的完整需求清单钉进 prompt,逼选型
  // 逐条"覆盖或标缺口、不许静默丢"——治"0 缺口"病,又不逼过度选型(仍取最小覆盖集)。
  const archBlock = archSpec !== undefined && archSpec.capabilities.length > 0
    ? [
        '',
        'ARCHITECTURE-FIRST — this agent was first designed WITHOUT the catalog. Its architectural needs are:',
        archSpec.capabilities.map((c, i) => `${String(i + 1)}. ${c.name}${c.why !== '' ? ` — ${c.why}` : ''}`).join('\n'),
        archSpec.dataModel !== '' ? `ARCHITECTURE DATA MODEL: ${archSpec.dataModel}` : '',
        archSpec.interfaces !== '' ? `ARCHITECTURE INTERFACES: ${archSpec.interfaces}` : '',
        'GO THROUGH EVERY architectural need above: each must end up EITHER covered by a selected catalog id OR listed in "missing" — NEVER silently dropped. Still keep the selection minimal (smallest covering set; do not over-mount), but completeness on the gap axis is mandatory: an unmet need you neither select nor flag is the exact failure this step exists to prevent.',
      ].join('\n')
    : ''
  // 段序即缓存工程(Prompt→App 工厂调研 §09:静态前缀 = 缓存,cache read ~0.1x;
  // 全行业 scaffold 锁栈的第一收益就是它):巨大而字节稳定的目录+规则放最前,
  // 每次都变的 archBlock/requirement 沉到尾部——此前 archBlock 插在目录前,
  // 一字之动废掉整段前缀缓存。
  const prompt = [
    'You are the capability matcher of a vibe-assembly system. A user describes an agent they want to build.',
    'Pick which capabilities from the catalog are needed, and say which needed capabilities are MISSING.',
    '',
    'Catalog:',
    tagsIndex,
    '',
    'Rules:',
    '- Respond with JSON only: {"capabilityIds": [...], "missing": [...], "missingEntries": [...], "persona": "...", "name": "...", "rationale": "..."}',
    `- capabilityIds must ONLY use ids from this exact set: ${ids.join(', ')}`,
    '- If the requirement asks for something the catalog cannot provide, list it in "missing" (e.g. "phone support", "payment").',
    // 市场战役 F14:matcher 把 sqlite 能覆盖的"持久状态"、fs-search 能覆盖的
    // "知识检索"报成缺口,还发明 vendor 名(agently-mail-*)——缺口误报比漏报
    // 更贵:每个缺口都会生成一份施工工单。
    '- GAP DISCIPLINE: before listing anything in "missing", exhaustively check the catalog for an existing part covering it under another name — persistent state/ledgers → the SQLite parts; saving/reading workspace files → the filesystem parts; searching/citing imported docs → the kb/fs-search entries; document output → the docx/pdf/excel parts. Report a gap ONLY when nothing plausibly covers it, and NEVER invent vendor-specific ids — describe the missing capability generically.',
    // 市场战役 F3:看板需求被配了 browser-automate——"网页上操作"指的是交付的
    // 前端页(装配器自动随件发),不是 agent 要去浏览网页。
    '- A requirement mentioning 网页/页面/看板/面板 usually means the DELIVERED web UI (the assembler ships one automatically) — do NOT select browser-automation or http parts for that; select them only when the AGENT itself must visit EXTERNAL sites.',
    '- Include capabilities that are implied (a support agent needs a persona).',
    // A workstation, not a script: work that outlives a turn (bookkeeping,
    // filing, tracking, archiving) needs somewhere to PUT state. Selecting the
    // storage part is a capability decision; how and when to write is the
    // model\'s. See DESIGN.md — give the desk, never the choreography.
    '- When the requirement implies work that OUTLIVES one turn (bookkeeping, filing, tracking, archiving, "later I can query it"), also select a state-keeping capability (a file-writing or database part) — an agent with no place to put state cannot honor such a requirement.',
    '- When you select a state-keeping capability, the persona MUST carry a durability constraint, e.g. "跨轮事实必须写入账本/文件,不依赖记忆" — a constraint judgeable at any point, NEVER a numbered procedure ("第一步…第二步…" is forbidden in personas).',
    // 装配时预思考:schema 设计是"每次运行都要现想一遍"的最贵深思(实测单次 75s),
    // 把它提前到装配时想一次,烧进 preset 的装备槽,运行时的模型开库即有表。
    '- When (and only when) you select a SQLite capability for persistent state, ALSO return "stateSchema": a short idempotent SQLite DDL string containing ONLY "CREATE TABLE IF NOT EXISTS ..." / "CREATE INDEX IF NOT EXISTS ..." statements (no INSERT/DROP/PRAGMA), pre-designing the tables this agent needs for its requirement. If an ARCHITECTURE DATA MODEL was given above, the schema MUST implement exactly those entities and their fields (do not redesign or omit them). Design the schema HERE, once — the running agent will find the tables ready-built and must never redesign them. Column names in English; include sensible keys.',
    // 前端零件是交互面模板:选形状,不选功能——功能由其余零件供给。
    '- via:"frontend" entries are human-facing UI templates for this agent. Select EXACTLY ONE when the requirement implies a page/UI (页面/前端/网页/表单/工单/看板/仪表盘/面板/dashboard/form/UI), picking the template whose interaction SHAPE fits (form submission → form desk; records & queries → data desk; metrics overview → dashboard; plain conversation → chat console). If ARCHITECTURE INTERFACES were given above, let that description drive the shape choice. Select NONE when no UI is implied — a chat console ships with every preset by default.',
    '- When NO catalog persona matches the requirement, write a "persona" string: a concise assistant persona for the assembled agent (role, tone, answer in the user\'s language, tool-use discipline). Omit it when a catalog persona IS selected — the catalog text wins.',
    '- Write a "name" for the assembled preset: a short kebab-case slug naming what the agent IS (2-5 words, lowercase letters, digits and hyphens only, e.g. "customer-service-bot", "web-research-assistant"). It becomes the preset id users pick in the roster.',
    '- For every item in "missing", add one matching entry to "missingEntries": {id, via, description, tags, tool?, mount?} — id is kebab-case; via is "package" | "harness" | "mcp"; when you know a harness plugin package that provides the capability, set mount.name to it (e.g. "@deepseek-ai/dsh-tool-fs-search"), else omit mount; set tool only for via: "package". Omit "missingEntries" entirely when nothing is missing.',
    archBlock,
    '',
    `Requirement: ${requirement}`,
  ].join('\n')
  const assembler = new BlockAssembler()
  // The mapping call is a light selection task: pin a FAST model instead of
  // inheriting the session's agent model. Measured: inheriting a heavy agent
  // model (deepseek-v4-pro + max reasoning) made assembly take ~10min on a
  // 130-entry catalog; flash finishes in seconds. Provider still follows the
  // host selection (routing correctness); model is config-pinnable.
  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  const request: GenerateOptions = {
    provider: model.provider ?? config?.provider ?? selection?.provider ?? 'deepseek-official',
    model: model.model ?? config?.model ?? 'deepseek-v4-flash',
    // 选型档位归装配器配置管(auxReasoningEffort;默认不降档,见 Config 注释)。
    // 与用户会话的模型档位无关。
    ...(config?.auxReasoningEffort !== undefined ? { reasoningEffort: config.auxReasoningEffort as GenerateOptions['reasoningEffort'] } : {}),
    messages: [createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    })],
    // Deadline, not decoration: this call runs inside the user's assemble
    // turn, and an upstream that neither answers nor closes would otherwise
    // hang that turn forever (see AUX_CALL_TIMEOUT_MS in verify.ts — observed
    // live on the probe-deriver twin of this call).
    ...(AUX_CALL_TIMEOUT_MS > 0 ? { signal: AbortSignal.timeout(AUX_CALL_TIMEOUT_MS) } : {}),
  }
  const stream = ctx.llm.stream(request)
  let text = ''
  const usage: AuxUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 }
  for await (const chunk of stream) {
    addUsage(usage, chunk)
    assembler.push(chunk)
  }
  onUsage?.(usage)
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new Error(`assemble: model call ${finish.kind}: ${finish.failure.message}`)
  }
  if (finish.kind === 'max-tokens') {
    throw new Error('assemble: model call hit max-tokens')
  }
  for (const block of assembler.message().content) {
    if (block.type === 'text') text += block.text
  }
  const parsed = parseModelJson(text) as unknown as AssembleRequest
  parsed.capabilityIds = reconcileCapabilityIds(parsed.capabilityIds ?? [], ids)
  return parsed
}

/**
 * Map the matcher's ids onto real catalog ids, repairing mechanical near-misses.
 *
 * Catalog ids for federated parts carry a bookkeeping prefix
 * (`mcp-<server>-<tool>`) that says nothing about the capability, and the
 * matcher occasionally drops or mangles it — observed live: it answered
 * `semver-check-compare` for `mcp-semver-check-compare` and the whole
 * assembly failed on ids that were, semantically, exactly right.
 *
 * Repair is deterministic (prefix and separator normalization only, never a
 * fuzzy guess at meaning) and reported. An id that still matches nothing is
 * dropped rather than fatal: a selection of five parts should not be lost
 * because the sixth name was mistyped — the probe is what decides whether the
 * assembled agent actually works.
 */
export function reconcileCapabilityIds(requested: readonly string[], catalogIds: readonly string[]): string[] {
  const known = new Set(catalogIds)
  // Separators are normalized BEFORE the prefix is stripped: an id written
  // as `MCP_Semver_Check_Satisfies` only reveals its `mcp-` prefix after
  // underscores become hyphens.
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^mcp-/, '')
  const byNorm = new Map<string, string>()
  for (const id of catalogIds) {
    const key = norm(id)
    if (!byNorm.has(key)) byNorm.set(key, id)
  }
  const resolved: string[] = []
  const dropped: string[] = []
  for (const id of requested) {
    if (known.has(id)) {
      resolved.push(id)
      continue
    }
    const hit = byNorm.get(norm(id))
    if (hit !== undefined) {
      console.error(`[assembler] capability id repaired: "${id}" → "${hit}"`)
      resolved.push(hit)
    } else {
      dropped.push(id)
    }
  }
  if (dropped.length > 0) {
    console.error(`[assembler] unknown capability ids dropped: ${dropped.join(', ')}`)
  }
  if (resolved.length === 0 && requested.length > 0) {
    throw new Error(`assemble: none of the selected capability ids exist: ${requested.join(', ')} — catalog changed?`)
  }
  return [...new Set(resolved)]
}

function renderYamlValue(value: unknown): string {
  return JSON.stringify(value)
}

/**
 * Parse-gate the rendered preset before it is allowed to leave {@link emitPreset}.
 *
 * The preset is built by string-templating YAML: the persona is JSON-encoded
 * (safe), but capability rows (`name: '<...>'`, `id: <...>`) and any
 * `{{param:key}}` slots are interpolated as raw text — so a row name carrying a
 * quote, or a param value carrying a colon, renders bytes that do not parse.
 * This is the ONE artifact the assembler both emits and can malform, and an
 * unparseable preset is the worst failure shape there is: `assemble` reports
 * success, the file lands in the roster, and it fails only when the host tries
 * to MOUNT it — i.e. in front of the client, after the FDE who could have fixed
 * it in one line has walked away.
 *
 * So the invariant "no unparseable preset reaches disk" is ENFORCED here, not
 * hoped for. A rendered preset must parse to a non-empty sequence of rows or the
 * assembly fails loudly, at assemble-time, naming the YAML error — exactly the
 * emission-path twin of scripts/yaml-write.mjs's `assertYaml`, which guards the
 * catalog-write path the same way ("s() 挡的是已知的那种破法,这道闸挡的是下一种
 * 还没见过的"). Byte-neutral on the happy path: a valid preset is returned
 * unchanged.
 */
export function assertEmittedPreset(text: string): string {
  let doc: unknown
  try {
    doc = yaml.load(text)
  } catch (error: unknown) {
    const first = String(error instanceof Error ? error.message : error).split('\n')[0]
    throw new Error(
      `assemble: 发射的 preset 不是合法 YAML(${first})——通常是某条能力行的 name/id 或某个参数值含 YAML 特殊字符;`
      + '修好该行/该值再装配,绝不把装不上的 preset 当成功交付',
    )
  }
  if (!Array.isArray(doc) || doc.length === 0) {
    throw new Error('assemble: 发射的 preset 未解析成非空的行序列——模板或能力行渲染坏了,拒绝写入')
  }
  return text
}

/**
 * 目录声明里的"每 preset 工作区"槽位。stdio MCP 声明(如 filesystem)的 args
 * 里写它,发射时替换成该 preset 的 workspace/ 绝对路径——文件面 = agent 自己
 * 的工作区,一个 preset 一根,越界目录对工具而言天然不存在。联邦列举工具时
 * 用临时目录替位(见 {@link federateMcpTools})。
 */
export const WORKSPACE_SLOT = '@@WORKSPACE@@'

/**
 * 教材区槽位:替换成该 preset 的 kb/ 绝对路径(workspace 的兄弟目录)。
 * filesystem 零件用它当第二根——知识包装在 kb/,只根 workspace 时 agent 拿
 * 文件工具够不着自己的教材(市场战役 s28 类)。发射时两目录都保证存在。
 */
export const KBDIR_SLOT = '@@KBDIR@@'

export function emitPreset(req: AssembleRequest, catalog: Catalog, template: string, presetId: string, personaSuffix = '', extraServerEnv?: Record<string, Record<string, string>>, workspaceDir?: string): string {
  const byId = new Map(catalog.capabilities.map((c) => [c.id, c]))
  // Enabled-only: `enabled: false` entries are excluded from the LLM's
  // choice set by llmMapRequirement below; this is the second gate for the
  // deterministic path (defense against a catalog edit between the two).
  const usable = (c: CapabilityEntry): boolean => c.config?.enabled !== false
  const selected = req.capabilityIds.map((id) => byId.get(id)!).filter(Boolean).filter(usable)
  const personaEntry = selected.find((c) => c.config?.persona !== undefined)
  // Persona priority: catalog persona (hand-authored, domain-validated) beats
  // the matcher's generated text beats the generic default. A requirement
  // outside every catalog domain gets a GENERATED persona — no more
  // "helpful assistant" placeholders for file managers, recruiters, etc.
  // (Shared with the assemble-time lint so the checked text is the emitted text.)
  const persona = `${resolvePersonaText(req.persona, selected)}${personaSuffix}`
  // Tool surface: LLM-selected package tools. When the selected set includes
  // a persona (a domain agent, e.g. customer service), the persona's implied
  // baseline tools are force-included — the LLM only sees the requirement,
  // not the domain's obvious defaults, so "查订单/转人工" alone would omit
  // ticket_create (measured in the cs-03 damage scenario). A domain persona
  // IS the statement of the baseline.
  const personaBaseline = personaEntry?.config?.baselineTools as string[] | undefined
  const packageTools = [...new Set([
    ...(personaBaseline ?? []),
    ...selected.filter((c) => c.via === 'package' && c.tool !== undefined).map((c) => c.tool!),
  ])]
  // The dsh-cs-tools row exists only when it actually carries tools: a preset
  // whose capabilities are all harness/MCP (e.g. a file-manager agent) must
  // not mount an empty `tools: []` row.
  const packageRows = packageTools.length === 0
    ? ''
    : `- id: tool-cs\n  name: '@dsh-external/dsh-cs-tools'\n  config:\n    tools: [${packageTools.join(', ')}]`
  const extraRows = dedupeRowsById(selected.flatMap((c) => c.config?.presetRows ?? []))
    .map((row) => {
      const cfg = row.config === undefined
        ? ''
        : `\n  config:${Object.entries(row.config).map(([k, v]) => `\n    ${k}: ${renderYamlValue(v)}`).join('')}`
      return `- id: ${row.id}\n  name: '${row.name}'${cfg}`
    })
    .join('\n\n')
  // Selected MCP capabilities: if the server is already mounted on the HOST
  // plane (hostMounted: true in mcp-servers), its tools are globally visible
  // to every agent — emit NO mcp-client row (a duplicate serverName would
  // fail the preset mount: "serverName is already in use"). Otherwise emit
  // an mcp-client row so the preset is self-contained.
  //
  // serverName is namespaced with a suffix hashed from the preset id AND the
  // whole rendered composition: the harness reserves MCP serverNames
  // process-globally (per ctx.root), mounts a preset file once per file
  // GENERATION (mtime+size stamp), and never releases a superseded
  // generation's names while the process lives. So the invariant has to be
  // "different file bytes ⇒ different serverNames" — any re-emit that
  // restamps the file (re-selection, or just a reworded persona) must arrive
  // with fresh names or its mount collides with its own predecessor. The
  // rows are rendered with a placeholder first, the full text is hashed,
  // and the suffix is substituted in; a byte-identical re-emit reproduces
  // the same suffix and is then skipped by {@link writePresetFile}, keeping
  // the stamp and the already-mounted generation. 8 hex chars fit the
  // harness serverName cap of 32 characters.
  const mcpServers = catalog['mcp-servers'] ?? {}
  const selectedServers = [...new Set(
    selected.filter((c) => c.via === 'mcp').map((c) => (c.config?.server as string | undefined) ?? ''),
  )].filter((server) => server !== '' && mcpServers[server] !== undefined && mcpServers[server].hostMounted !== true)
  const SUFFIX_SLOT = '@@GEN-SUFFIX@@'
  const mcpRows = selectedServers
    .map((server) => {
      const cfg = mcpServers[server]
      // 装备槽注入(如 SQLITE_INIT_DDL_FILE)与目录声明的 env 合并后一起走
      // stripSecretEnv——装备值是路径不是秘密,但规则不设例外。env 行在目录
      // 没写 env 而装备需要时也要出现。
      // PART_WORKDIR 全员注入(市场战役 F11):零件把相对路径解析进自己进程的
      // cwd(= host 检出目录),docx 实测写进了 host 检出;每个 mcp 零件统一
      // 拿到本 preset 的 workspace 绝对路径当根。目录/装备的显式 env 可覆盖。
      const mergedEnv = stripSecretEnv({ PART_WORKDIR: WORKSPACE_SLOT, ...(cfg.env as Record<string, unknown> | undefined ?? {}), ...(extraServerEnv?.[server] ?? {}) })
      const lines = Object.entries(cfg)
        .filter(([k]) => k !== 'hostMounted' && k !== 'requiredSecrets' && k !== 'env')
        .map(([k, v]) => `\n    ${k}: ${renderYamlValue(v)}`)
        .join('')
        + (Object.keys(mergedEnv).length > 0 ? `\n    env: ${renderYamlValue(mergedEnv)}` : '')
      const serverName = `${server}-${SUFFIX_SLOT}`
      return `- id: mcp-${server}\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: ${renderYamlValue(serverName)}${lines}`
    })
    .join('\n\n')
  const allRows = [extraRows, mcpRows].filter((s) => s !== '').join('\n\n')
  // Parameters are substituted BEFORE the serverName suffix is hashed: a
  // parameter change alters the file's bytes, and the generation invariant
  // (bytes decide names) must see the final text.
  const rendered = applyParams(
    template
      .replace('{{persona}}', JSON.stringify(persona))
      .replace('{{packageRows}}', packageRows)
      .replace('{{extraRows}}', allRows),
    req.params ?? {},
  )
  let out = rendered.replaceAll(SUFFIX_SLOT, presetNameSuffix(presetId, rendered))
  // @@WORKSPACE@@:目录声明里的"每 preset 工作区"槽位(filesystem 零件的根)。
  // 替换在 suffix 哈希之后——workspace 路径由 preset id 唯一决定,同 id 同路径,
  // 不会让两份同字节组合产出不同代际。缺路径时宁可炸在装配台,也不发一个
  // 根目录是字面量 '@@WORKSPACE@@' 的哑零件出门。
  if (out.includes(WORKSPACE_SLOT) || out.includes(KBDIR_SLOT)) {
    if (workspaceDir === undefined) {
      throw new Error('assemble: 选中的能力声明了 @@WORKSPACE@@/@@KBDIR@@(每 preset 目录槽位)但发射时未提供工作区路径')
    }
    out = out.replaceAll(WORKSPACE_SLOT, workspaceDir)
    // kb 是 workspace 的兄弟目录。发射保持纯文本替换;两根目录的真实建立
    // 归 assemble(filesystem 零件对不存在的根直接拒启,见探针/前端两处 mkdir)。
    out = out.replaceAll(KBDIR_SLOT, join(dirname(workspaceDir), 'kb'))
  }
  return assertEmittedPreset(out)
}

/**
 * Drop secret-shaped entries from a server's `env` before it is written into
 * a preset.
 *
 * `dsh-mcp-client` takes `env` as literal strings — there is no reference
 * syntax — so a token placed there would be plaintext in a file that lands in
 * git and in the roster UI. The part reads its credential from its OWN
 * process environment at run time (supplied by the host or the operator's
 * shell); the preset only records that the part NEEDS one. Charter negative
 * list #4, enforced by code rather than by documentation.
 */
export function stripSecretEnv(env: unknown): Record<string, string> {
  if (env === null || typeof env !== 'object') return {}
  const kept: Record<string, string> = {}
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) continue
    if (typeof v === 'string') kept[k] = v
  }
  return kept
}

/** One credential a part needs before it can do real work. */
export interface RequiredSecret {
  /** Environment variable the part reads at run time. */
  env: string
  /** What it is for, shown in the assemble result and the BOM. */
  purpose?: string
  /**
   * True when the part still does useful work without it — GitHub's public
   * reads work anonymously (rate-limited), Crossref's polite pool is a
   * courtesy. An optional credential must NOT hold verification back: the
   * probe can exercise the anonymous path and prove the assembly, which is
   * strictly more evidence than skipping (observed: a public-repo inspector
   * was skipped for a token it never needed).
   */
  optional?: boolean
}

/**
 * Credentials the selected parts declare, deduplicated by env name, each
 * marked with whether the assembling host currently has it configured.
 *
 * "Configured" is read from the assembler's own environment, which is where
 * the host puts what it forwards to part processes. An unconfigured secret is
 * NOT an assembly error: the preset is still correct and mountable, it simply
 * cannot do external work until the operator supplies the value — which is
 * exactly the state an FDE ships in when the interface is ready and the key
 * comes later.
 */
export function collectRequiredSecrets(
  selected: CapabilityEntry[],
  mcpServers: Record<string, Record<string, unknown>>,
): Array<RequiredSecret & { server: string; configured: boolean }> {
  const out = new Map<string, RequiredSecret & { server: string; configured: boolean }>()
  for (const c of selected) {
    const server = (c.config?.server as string | undefined) ?? ''
    const decl = server !== '' ? mcpServers[server]?.requiredSecrets : undefined
    if (!Array.isArray(decl)) continue
    for (const item of decl as Array<Record<string, unknown>>) {
      const envName = typeof item.env === 'string' ? item.env : ''
      if (envName === '' || out.has(envName)) continue
      out.set(envName, {
        env: envName,
        ...(typeof item.purpose === 'string' ? { purpose: item.purpose } : {}),
        ...(item.optional === true ? { optional: true } : {}),
        server,
        configured: typeof process.env[envName] === 'string' && process.env[envName] !== '',
      })
    }
  }
  return [...out.values()]
}

/** An installed knowledge pack: what it is, and WHERE it landed. */
export interface InstalledPack {
  id: string
  docs: number
  /** Absolute directory the docs were copied to. */
  dir: string
  /** Document filenames, in directory order. */
  files: string[]
  source?: string
  version?: string
}

/**
 * The lines that tell the agent where its knowledge is.
 *
 * Shipping the pack is not enough. Measured on a real delivery: the preset
 * carried the docs into kb/ and said only "follow the nw-governance-kb
 * documents", naming the pack but not its path — so the agent opened its first
 * turn with 18 discovery calls (glob, search_files, directory_tree,
 * list_directory, get_file_info, grep) hunting for files that were sitting at a
 * known absolute path the whole time. That is a third of the turn spent
 * rediscovering what assembly already knew.
 *
 * Naming the directory and the filenames turns that hunt into one read.
 */
export function knowledgeLocatorText(packs: readonly InstalledPack[]): string {
  if (packs.length === 0) return ''
  const lines = packs.map((p) => `- ${p.id}${p.version === undefined ? '' : `(版本 ${p.version})`}:${p.dir}/ —— ${p.files.join('、')}`)
  return `\n\n你的知识资料已经随 preset 装好,就在下面这些路径,直接读文件即可,不要去搜索或遍历目录找它们:\n${lines.join('\n')}`
}

/**
 * Copy the selected knowledge packs into the preset's `kb/` and report what
 * landed there.
 *
 * A knowledge pack is EQUIPMENT, not a capability: the agent does not "call"
 * it, it reads it. Copying (rather than referencing the catalog path) is what
 * makes the preset a self-contained deliverable — an FDE hands over one
 * directory, and the agent's knowledge travels with it rather than pointing
 * back at the assembler's machine.
 */
export function installKnowledgePacks(
  selected: CapabilityEntry[],
  presetDir: string,
  catalogRoot: string,
): InstalledPack[] {
  const installed: InstalledPack[] = []
  for (const cap of selected.filter((c) => c.via === 'knowledge')) {
    const packId = (cap.config?.pack as string | undefined) ?? cap.id
    const packDir = join(catalogRoot, 'knowledge', packId)
    const docsDir = join(packDir, 'docs')
    if (!existsSync(docsDir)) continue
    const targetDir = join(presetDir, 'kb', packId)
    mkdirSync(targetDir, { recursive: true })
    const files: string[] = []
    for (const f of readdirSync(docsDir)) {
      writeFileSync(join(targetDir, f), readFileSync(join(docsDir, f)))
      files.push(f)
    }
    const docs = files.length
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(readFileSync(join(packDir, '.knowledge-meta.json'), 'utf8')) as Record<string, unknown>
    } catch { /* pack without metadata still installs */ }
    installed.push({
      id: packId,
      docs,
      dir: targetDir,
      files,
      ...(typeof meta.source === 'string' ? { source: meta.source } : {}),
      ...(typeof meta.version === 'string' ? { version: meta.version } : {}),
    })
  }
  return installed
}

// ── 装备槽:装配时预思考,运行时零设计 ───────────────────────────────────────
// 法医实测:重探针最长的一段思考(75s)是模型面对空库、在脑内设计整套表结构——
// 而且每个新会话都重演一遍,还各设计各的(跨会话 schema 漂移)。装备槽把这个
// 设计决策提前到装配时做一次:matcher 起草 DDL → 双次执行门验证 → 写进 preset
// 的 equipment/init.sql → sqlite 零件经 env 在每次开库时自动应用。房间自带家具。
// 先例:SWE-agent 的 ACI(接口向模型认知靠拢);Anthropic tool-design 的 smart
// defaults。宪法核照:静态工件 ✓、零件自己执行(装配器不在场)✓、给工位不给脚本 ✓。

/**
 * 双次执行门:一份要自动执行的 DDL,必须先证明自己(1)能跑、(2)幂等——
 * 在内存库里连续执行两遍,任何一遍失败都拒绝发射。外加词法负面清单:装备是
 * 家具不是数据,INSERT(破幂等)/DROP(重开即毁)/PRAGMA/ATTACH 一律不收。
 * 用 node:sqlite(Node 内置,宪法允许)而非第三方依赖;不可用时拒绝发射——
 * "没验过的自动执行代码不出厂"比"少个装备"糟得多。
 * @returns null = 通过;否则返回拒绝理由。
 */
export function validateStateSchema(ddl: string): string | null {
  if (/\b(INSERT|UPDATE|DELETE|DROP|ATTACH|PRAGMA|REPLACE)\b/i.test(ddl)) {
    return '装备只收建表/建索引(CREATE ... IF NOT EXISTS);INSERT/DROP/PRAGMA 等一律不收'
  }
  let DatabaseSync: new (path: string) => { exec: (sql: string) => void; close: () => void }
  try {
    DatabaseSync = (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSync }).DatabaseSync
  } catch {
    return 'node:sqlite 不可用,无法验证——未验证的自动执行 DDL 不发射'
  }
  try {
    const db = new DatabaseSync(':memory:')
    db.exec(ddl)
    db.exec(ddl) // 第二遍 = 幂等性的可执行证明,不靠肉眼检查 IF NOT EXISTS
    db.close()
    return null
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** 装备安装结果:发射进 mcp 行的 env、persona 追加句、进 BOM 的文件清单。 */
export interface StateEquipment {
  extraServerEnv: Record<string, Record<string, string>>
  personaText: string
  files: string[]
}

/**
 * 把 matcher 起草的 stateSchema 落成 preset 装备:验证 → 写 equipment/init.sql →
 * 给选中的 sqlite 服务器生成 env 指针 → 给 persona 一句"表已建好,禁止重设计"。
 * 任一条件不满足(没起草/没选 sqlite/没过门)返回 null,装配照常——装备是
 * 加速器不是必需品。只针对 sqlite(本地自有状态);postgres/mysql 是客户库,
 * 自动 DDL 是越权写操作,永不做。
 */
export function installStateEquipment(opts: {
  stateSchema?: string
  selected: CapabilityEntry[]
  dir: string
  /**
   * 共享库(solution 级):给了则本 agent 的默认库钉到这个绝对路径,而不是自己
   * 的 workspace/data.db——同一套班子的多个 agent 由此读写同一份账(FDE 的
   * "共享同一套商品/订单数据")。共享库的建表由 solution 层统一做,这里的
   * 每 agent DDL 仍会自动执行(CREATE TABLE IF NOT EXISTS 幂等,补齐本 agent
   * 专属表不冲突)。
   */
  sharedDb?: string
}): StateEquipment | null {
  const ddl = (opts.stateSchema ?? '').trim()
  if (ddl === '') return null
  const sqliteServers = [...new Set(
    opts.selected
      .filter((c) => c.via === 'mcp' && typeof c.config?.server === 'string' && (c.config.server as string).includes('sqlite'))
      .map((c) => c.config?.server as string),
  )]
  if (sqliteServers.length === 0) return null
  const why = validateStateSchema(ddl)
  if (why !== null) {
    console.error(`[assembler] stateSchema 未过双次执行门,装备不发射:${why}`)
    return null
  }
  const eqDir = join(opts.dir, 'equipment')
  mkdirSync(eqDir, { recursive: true })
  const file = join(eqDir, 'init.sql')
  writeFileSync(file, ddl.endsWith('\n') ? ddl : `${ddl}\n`)
  const extraServerEnv: Record<string, Record<string, string>> = {}
  // 默认库钉为**绝对路径**:独立 agent → 自己的 workspace/data.db;solution 班子
  // → 共享库(sharedDb)。该 preset 的任何会话(前端页/DSH 对话/种子脚本)打开
  // 的都是同一份账。两版教训:不钉库位 agent 各自发明库名甚至落 :memory:;钉相对
  // 路径则解析进部件进程 cwd(= host 检出目录),五个 preset 的表混进同一个文件。
  const defaultDb = opts.sharedDb ?? join(opts.dir, 'workspace', 'data.db')
  mkdirSync(dirname(defaultDb), { recursive: true })
  for (const server of sqliteServers) extraServerEnv[server] = { SQLITE_INIT_DDL_FILE: file, SQLITE_DEFAULT_DB: defaultDb }
  const dbNote = opts.sharedDb !== undefined
    ? `\n\n本台数据库已配备(**方案共享库**,与同套班子的其他 agent 读写同一份账):默认库已固定(调用 sqlite 工具时**不要传 database 参数**,禁止自创数据库文件名),共享表结构已由方案统一建好,本 agent 专属表在打开时自动补齐(DDL 见 ${file})——直接使用现有表,禁止重新设计 schema 或另建同用途的表。`
    : `\n\n本台数据库已配备:默认库已固定(调用 sqlite 工具时**不要传 database 参数**,禁止自创数据库文件名),表结构一打开即自动建好(DDL 见 ${file})——直接使用现有表,禁止重新设计 schema 或另建同用途的表。`
  return {
    extraServerEnv,
    personaText: dbNote,
    files: ['equipment/init.sql'],
  }
}

// ── 选型台账(训练数据的第 0 级)────────────────────────────────────────────
// assemble→probe→verdict 闭环天生是标签工厂:每次真选型产出一条带验证判定的
// (需求, 选型, 判定) 样本;FAIL→重选→PASS 更是黄金纠错对。台账从今天开始积累,
// 未来若专训零件选择小模型(Gorilla/xLAM 路线),这就是别人没有的数据飞轮。
// 纪律:只记真选型(复用轮不记——选型没跑);写失败绝不影响装配;默认不进公共
// git(ledger/ 在 .gitignore——需求文本可能含客户信息,归档要人工挑)。

/** 一条选型样本。字段面向未来的训练/评测消费者,宁全勿缺,但值保持紧凑。 */
export interface SelectionLedgerRecord {
  at: string
  /** 完整需求文本(训练输入,不截断)。 */
  requirement: string
  presetId: string
  /** 选择集的身份:目录路径 + 条数 + id 集合哈希(可按目录纪元过滤样本)。 */
  catalogPath: string
  catalogSize: number
  catalogHash: string
  params: Record<string, string>
  selected: string[]
  missing: string[]
  /** persona 来源:目录手写 / 匹配器生成 / 通用兜底——三者的选型难度不同。 */
  personaSource: 'catalog' | 'generated' | 'default'
  /** 是否起草了状态 schema(装备槽)。 */
  stateSchema: boolean
  /** 辅助调用档位与账目(off/low/high/max;'inherit' = 未配置继承连接默认)。 */
  aux: {
    effort: string
    selection?: { out: number; reason: number; cache: number }
    derive?: { out: number; reason: number; cache: number }
  }
  probe: { status: string; kind?: string; turns?: number; reason?: string }
  /** FAIL→重选的纠错对(黄金样本);没触发重试为 null。 */
  retry: null | { firstSelected: string[]; failReason: string; retrySelected: string[]; retryStatus: string }
  /** 前端验收结果(PASS / FAIL:原因 / SKIPPED);没发前端就没有这个键。 */
  frontendGate?: string
  timings: Array<{ stage: string; seconds: number; detail?: string }>
  totalSeconds: number
}

/** 追加一条样本到台账(JSONL,一行一样本);返回台账路径。 */
export function appendSelectionLedger(record: SelectionLedgerRecord, dir = join(REPO, 'ledger')): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'selections.jsonl')
  appendFileSync(path, `${JSON.stringify(record)}\n`)
  return path
}

/** 目录 id 集合的短哈希:样本按"当时的选择集"分层用。 */
export function catalogIdsHash(catalog: Catalog): string {
  const ids = catalog.capabilities.map((c) => c.id).sort()
  return createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16)
}

/** One-shot fallback id for when no usable name exists: stable, short, collision-free enough. */
function mintPresetId(): string {
  return `assembled-${Date.now().toString(36)}`
}

/**
 * Normalize a requested/suggested preset name to the harness id pattern
 * (`^[a-z0-9][a-z0-9-]*$`): lowercase, other characters become hyphens,
 * leading/trailing hyphens drop, length caps at {@link MAX_PRESET_ID_LENGTH}.
 * Returns '' when nothing usable remains.
 */
export function sanitizePresetName(raw: string): string {
  const slug = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_PRESET_ID_LENGTH)
  return PRESET_ID_RE.test(slug) ? slug : ''
}

/**
 * Resolve the preset id to write under `presetRoot`.
 *
 * Precedence: caller-supplied name (sanitized) → matcher-suggested name
 * (sanitized) → {@link mintPresetId}. A name whose directory already exists
 * gains a `-2`/`-3`/… suffix instead of silently colliding, so a re-assembly
 * of the same concept never overwrites or fails.
 */
export function resolvePresetId(
  requestedName: string | undefined,
  suggestedName: string | undefined,
  presetRoot: string,
): string {
  const base = sanitizePresetName(requestedName ?? '') || sanitizePresetName(suggestedName ?? '')
  const desired = base !== '' ? base : mintPresetId()
  let id = desired
  for (let n = 2; existsSync(join(presetRoot, id)); n++) {
    id = `${desired}-${n}`
  }
  return id
}

/**
 * Parameter keys that smell like secrets — refused, never rendered.
 *
 * The parameter channel exists for deployment facts (timezone, language, a
 * working directory), and preset files are plain text that lands in git and
 * in the roster UI. A credential arriving here would be a plaintext leak with
 * an innocent-looking door, so the door is machine-locked rather than
 * documented shut (DESIGN.md negative list #4: secrets are declared, never
 * embedded).
 */
const SECRET_KEY_RE = /(password|passwd|secret|token|api[-_]?key|access[-_]?key|credential|private[-_]?key|auth)/i

export interface ParamRejection { key: string; reason: string }

/**
 * Split caller-supplied parameters into the accepted set and the refused ones.
 * Values are never inspected — a key that looks like a secret is refused even
 * when its value is harmless, because the SHAPE is what invites misuse later.
 */
export function screenParams(params: Record<string, string>): {
  accepted: Record<string, string>
  rejected: ParamRejection[]
} {
  const accepted: Record<string, string> = {}
  const rejected: ParamRejection[] = []
  for (const [k, v] of Object.entries(params)) {
    if (SECRET_KEY_RE.test(k)) {
      rejected.push({ key: k, reason: '疑似凭证:秘密不进 preset 文件,请走 host 的 env/settings 通道' })
    } else if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(k)) {
      rejected.push({ key: k, reason: '键名非法(字母开头,字母/数字/-/_,≤40 字符)' })
    } else if (v.length > 200) {
      rejected.push({ key: k, reason: `值过长(${String(v.length)} 字符 > 200)` })
    } else {
      accepted[k] = v
    }
  }
  return { accepted, rejected }
}

/**
 * Fill `{{param:key}}` slots in a rendered composition.
 *
 * An unfilled slot renders as the empty string rather than staying literal:
 * a preset carrying `{{param:timezone}}` into a session would hand the model
 * a placeholder as if it were a value.
 */
export function applyParams(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{param:([A-Za-z][A-Za-z0-9_-]{0,39})\}\}/g, (_m, key: string) => params[key] ?? '')
}

/**
 * Stable 8-char suffix for a preset's MCP serverNames, derived by hashing the
 * preset id plus a generation seed (the rendered composition text, before
 * suffix substitution). Hashing (rather than tail-truncation) keeps two
 * similarly-named presets ("web-research" vs "deep-research") from sharing a
 * suffix, and seeding with the composition text keeps two GENERATIONS of the
 * same preset from sharing one — the host never releases a superseded
 * generation's serverNames while the process lives, so a re-emitted file
 * whose bytes changed must carry fresh names to be mountable at all
 * (observed live: the verify-retry re-emit collided on every serverName of
 * its own first generation).
 */
export function presetNameSuffix(presetId: string, seed = ''): string {
  return createHash('sha256').update(`${presetId}\n${seed}`).digest('hex').slice(0, 8)
}

/**
 * Write a composition file only when its bytes actually change.
 *
 * The host keys a preset's standing mount to the file's mtime+size stamp; a
 * byte-identical rewrite would restamp the file and force a pointless next
 * generation — whose mcp rows carry the SAME serverNames (same selection ⇒
 * same suffix) and therefore cannot mount. Skipping the write keeps the
 * stamp, and the host keeps serving the already-mounted generation.
 */
export function writePresetFile(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return
  writeFileSync(path, content)
}

// ── 增量验收(verify ledger)与同名复用 ─────────────────────────────────────
// 法医实测:一次重装配 24 分钟里 99% 是探针会话的模型解码;而 solution apply 每次
// 重跑都全量重探,买回来的验收证据和上次一模一样。两件机器让"没变的东西不再付费":
//  - verify ledger:验收结论跟着 preset 字节哈希入账,同字节 + 未过期 ⇒ 沿用 PASS
//    (明写"沿用",绝不冒充新跑——账本文化);
//  - 同名复用:需求与参数与上次完全相同 ⇒ 跳过重选型与重发射,连 -2/-3 目录都
//    不再铸(顺带治掉 handover 永远读旧目录、roster 长满代际垃圾两个病)。
// 先例:promptfoo 的响应缓存 + resume 跳过已完成对(TTL + 强制绕过开关同款形态)。

/** 一份 preset 字节的验收台账:证明"这些字节被探过且 PASS"。 */
export interface VerifyLedger {
  /** sha256(preset 文件全文)——证据绑定到字节,不绑定到名字。 */
  presetSha256: string
  /** 只记 PASS:FAIL 沿用毫无意义(该重探或换零件),不入账。 */
  status: 'PASS'
  kind?: 'single' | 'scenario'
  verifiedAt: string
  /** 一行摘要(场景 goal 或探针任务),给读台账的人看这份证据证明了什么。 */
  summary?: string
}

export const VERIFY_LEDGER_FILE = 'last-verify.json'

/**
 * 沿用窗口(默认 7 天,与联邦缓存同款):库型零件字节锁死,但服务型零件的上游
 * 明天返回什么由提供方说了算——验收证据随时间贬值,过期就重探。
 */
export const VERIFY_CARRY_TTL_MS = 7 * 24 * 3600 * 1000

/**
 * 发射代号:发射产物的语义版本。任何改变"同样输入会发射出什么"的改动
 * (装备 env、模板槽位、行渲染……)都必须把它 +1——同名复用闸会因此对
 * 全体旧 preset 失效一次,让下一次装配用新语义全新发射。教训:装备槽
 * 新增 SQLITE_DEFAULT_DB 后,三个旧 preset 经复用原样上桌,修复没上车。
 * rev 2:装备槽注入 SQLITE_DEFAULT_DB(钉死默认库)。
 * rev 3:默认库改为**绝对路径** preset workspace/data.db——相对路径解析进的是
 *        部件进程 cwd(= host 检出目录),实测五个 preset 的表混进同一个文件。
 * rev 4:filesystem 不再走 host 全局挂载(那个挂载从未活过),改随 preset 发射
 *        mcp 行、根目录经 @@WORKSPACE@@ 钉到各自 workspace/。老代 lock 选了
 *        文件能力却没有对应行,复用必须失效,同需求重装原地换代补上行。
 * rev 5:lock 增记 missing + catalogIdsHash(缺件工单闭环的后半):复用闸据此
 *        识别"欠着件 + 目录已生长"并重新选型。旧代 lock 没这两个字段,闸失明,
 *        必须换代补记。
 * rev 6:每个 mcp 行注入 PART_WORKDIR=<preset>/workspace(F11 零件 cwd 病类修):
 *        零件相对路径从此解析进本 preset 工作区。旧代 preset 没这个 env,
 *        零件仍写 host 检出,必须换代重发。
 */
export const EMISSION_REV = 6

/** preset 文本的账本键。 */
export function presetSha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 读台账;缺失/损坏/形状不对一律 null(等价于"无证据",走全新探针)。 */
export function loadVerifyLedger(dir: string): VerifyLedger | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, VERIFY_LEDGER_FILE), 'utf8')) as VerifyLedger
    if (typeof parsed.presetSha256 === 'string' && parsed.status === 'PASS' && typeof parsed.verifiedAt === 'string') {
      return parsed
    }
  } catch { /* absent or corrupt — no evidence */ }
  return null
}

export function saveVerifyLedger(dir: string, ledger: VerifyLedger): void {
  writeFileSync(join(dir, VERIFY_LEDGER_FILE), JSON.stringify(ledger, null, 2) + '\n')
}

/**
 * 沿用判定:同字节 + PASS + 未过期。拒绝时说清为什么要重探——"字节已变"和
 * "台账过期"对操作者是两种完全不同的下一步。
 */
export function carryDecision(
  ledger: VerifyLedger | null,
  sha: string,
  nowMs: number,
  ttlMs: number,
): { carry: boolean; why: string } {
  if (ledger === null) return { carry: false, why: '无验收台账' }
  if (ledger.presetSha256 !== sha) return { carry: false, why: 'preset 字节已变' }
  const age = nowMs - Date.parse(ledger.verifiedAt)
  if (!Number.isFinite(age) || age < 0 || age >= ttlMs) {
    return { carry: false, why: `验收台账已过期(沿用窗口 ${String(Math.round(ttlMs / 86_400_000))} 天)` }
  }
  return { carry: true, why: `沿用 ${ledger.verifiedAt.slice(0, 10)} 验收,preset 字节未变` }
}

/** 从已发射的 preset 文本取回 persona 实文——复用轮 lint 检查的必须是盘上那份。 */
export function personaFromPresetText(presetText: string): string | undefined {
  try {
    const rows = yaml.load(presetText)
    if (!Array.isArray(rows)) return undefined
    const row = rows.find((r) => (r as { id?: unknown } | null)?.id === 'persona') as { config?: { text?: unknown } } | undefined
    return typeof row?.config?.text === 'string' ? row.config.text : undefined
  } catch {
    return undefined
  }
}

/**
 * 同概念判定:盘上这个名字是否就是"同一个 agent"(需求与参数一致),不问
 * 代际新旧。planReuse 因新鲜度(发射代号/知识版本)拒绝复用时,全新装配应当
 * **原地重发**同一 id——-2/-3 兄弟目录只留给"真正不同的新概念"防撞名。教训:
 * 发射代号闸上线后,三个升级重装全被铸成 *-2 兄弟,roster 又开始长代际垃圾。
 */
export function sameConceptOnDisk(opts: {
  name?: string
  requirement: string
  params: Record<string, string>
  presetRoot: string
}): boolean {
  const id = sanitizePresetName(opts.name ?? '')
  if (id === '') return false
  const lockPath = join(opts.presetRoot, id, 'parts.lock.yml')
  if (!existsSync(lockPath)) return false
  let lock: { requirement?: unknown; params?: unknown }
  try {
    lock = (yaml.load(readFileSync(lockPath, 'utf8')) ?? {}) as typeof lock
  } catch {
    return false
  }
  if (lock.requirement !== opts.requirement.replace(/\s+/g, ' ').trim().slice(0, 140)) return false
  const lockParams = (lock.params !== null && typeof lock.params === 'object' ? lock.params : {}) as Record<string, string>
  const canon = (p: Record<string, string>): string => JSON.stringify(Object.entries(p).sort())
  return canon(lockParams) === canon(opts.params)
}

/** 同名复用的产物:选型、盘上的 preset 文本、知识包事实,全部来自既有工件。 */
export interface ReusePlan {
  id: string
  capabilityIds: string[]
  presetText: string
  knowledge: InstalledPack[]
}

/**
 * 同名复用计划:调用者点名的 preset 已存在,且 parts.lock 记录的需求与参数和
 * 这次完全相同 ⇒ 跳过重选型(LLM 选型天生抖动,一抖字节就变、台账就废)与重发射,
 * 沿用现有目录。任何一个条件不满足就返回 null 走全新装配:
 *  - 名字必须是调用者显式给的(匹配器起的名不参与复用);
 *  - lock 里每个能力仍在当前目录中且未停用(目录变了 ⇒ 旧选型不可信);
 *  - 需求文本按 lock 同款归一(压空白、截 140)后必须相等,参数逐键相等。
 * 复用不重写任何文件——preset 的 mtime 是 host 的代际标记,白翻新一次就白换一代。
 */
export function planReuse(opts: {
  name?: string
  requirement: string
  params: Record<string, string>
  presetRoot: string
  catalog: Catalog
  /**
   * 目录根(catalogPath 所在目录)。给了才能做知识包版本闸:目录里的包升了版
   * 而 lock 记的还是旧版 ⇒ 拒绝复用,走全新装配把新知识拷进 preset——否则
   * "同名复用"会永远交付过期知识。
   */
  catalogRoot?: string
}): ReusePlan | null {
  const id = sanitizePresetName(opts.name ?? '')
  if (id === '') return null
  const dir = join(opts.presetRoot, id)
  const presetPath = join(dir, 'agent.cordis.yml')
  const lockPath = join(dir, 'parts.lock.yml')
  if (!existsSync(presetPath) || !existsSync(lockPath)) return null
  let lock: { requirement?: unknown; params?: unknown; emitter?: unknown; parts?: Array<Record<string, unknown>>; knowledge?: Array<Record<string, unknown>> }
  try {
    lock = (yaml.load(readFileSync(lockPath, 'utf8')) ?? {}) as typeof lock
  } catch {
    return null
  }
  // 发射代号闸:旧代发射的 preset 不复用——装配器的发射语义升级必须落到工件上。
  if ((typeof lock.emitter === 'number' ? lock.emitter : 1) !== EMISSION_REV) return null
  const wantReq = opts.requirement.replace(/\s+/g, ' ').trim().slice(0, 140)
  if (lock.requirement !== wantReq) return null
  const lockParams = (lock.params !== null && typeof lock.params === 'object' ? lock.params : {}) as Record<string, string>
  const canon = (p: Record<string, string>): string => JSON.stringify(Object.entries(p).sort())
  if (canon(lockParams) !== canon(opts.params)) return null
  // 缺口生长闸(缺件工单闭环的另一半):上次装配欠着件(lock.missing 在案),
  // 而目录指纹已变(通常 = 主 agent 照工单造件入库了)⇒ 拒绝复用、重新选型,
  // 给新零件上桌的机会。目录没变则照常复用——重选也只会报出同样的缺口,
  // 白付一次选型抖动。无缺口的 lock 不看指纹:目录生长与它无关。
  const lockMissing = Array.isArray((lock as { missing?: unknown }).missing) ? ((lock as { missing?: unknown[] }).missing as unknown[]) : []
  const lockCatalogHash = (lock as { catalogIdsHash?: unknown }).catalogIdsHash
  if (lockMissing.length > 0 && typeof lockCatalogHash === 'string' && lockCatalogHash !== catalogIdsHash(opts.catalog)) return null
  const byId = new Map(opts.catalog.capabilities.map((c) => [c.id, c]))
  const ids: string[] = []
  for (const p of Array.isArray(lock.parts) ? lock.parts : []) {
    const cid = typeof p.capability === 'string' ? p.capability : ''
    const cap = byId.get(cid)
    if (cap === undefined || cap.config?.enabled === false) return null
    ids.push(cid)
  }
  if (ids.length === 0) return null
  // 知识包事实从盘上读回:docs 已随上次装配拷进 kb/,复用只是把事实复述给报告。
  const knowledge: InstalledPack[] = []
  for (const k of Array.isArray(lock.knowledge) ? lock.knowledge : []) {
    const kid = typeof k.id === 'string' ? k.id : ''
    if (kid === '') continue
    // 知识版本闸:目录里的包与 lock 记录版本不一致 ⇒ 不复用(新知识必须进 preset)。
    if (opts.catalogRoot !== undefined && typeof k.version === 'string') {
      try {
        const meta = JSON.parse(readFileSync(join(opts.catalogRoot, 'knowledge', kid, '.knowledge-meta.json'), 'utf8')) as { version?: unknown }
        if (typeof meta.version === 'string' && meta.version !== k.version) return null
      } catch { /* 包已不在目录:无从确认新旧,不因此阻断复用 */ }
    }
    const kdir = join(dir, 'kb', kid)
    let files: string[] = []
    try {
      files = readdirSync(kdir)
    } catch { /* kb 目录被手动清掉:仍复用,篇数如实报 0 */ }
    knowledge.push({
      id: kid,
      docs: files.length,
      dir: kdir,
      files,
      ...(typeof k.source === 'string' ? { source: k.source } : {}),
      ...(typeof k.version === 'string' ? { version: k.version } : {}),
    })
  }
  return { id, capabilityIds: [...new Set(ids)], presetText: readFileSync(presetPath, 'utf8'), knowledge }
}

/**
 * Ambient env with only string values (process.env entries can be undefined).
 *
 * `NODE_USE_ENV_PROXY=1` is forced on when a proxy is configured: Node's
 * global `fetch` IGNORES `HTTP(S)_PROXY` without it, so a service part behind
 * a corporate or local proxy fails with a bare "fetch failed" while `curl`
 * from the same shell succeeds — a failure that reads as a broken part and is
 * really a broken network path (observed live: geocode's smoke, 16 red
 * assertions, endpoint healthy). Setting it here fixes every network part at
 * once instead of asking each one to remember.
 */
function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  const proxied = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((k) => env[k] !== undefined && env[k] !== '')
  if (proxied && env.NODE_USE_ENV_PROXY === undefined) env.NODE_USE_ENV_PROXY = '1'
  return env
}

// ── Federation cache (P2.1) ────────────────────────────────────────────────
// Connecting all catalog servers costs one process cold-start each (~4.7s
// wall for 33 stdio servers even at 16 lanes). The tool LIST of a part
// changes only when its adapter or connection config changes, so the list is
// cached per server under a key derived from exactly those inputs; a warm
// assemble skips every connection. A TTL backstops remote (streamable-http)
// servers whose toolset can change server-side without any local trace.

/**
 * Raw tool descriptor as cached — the minimal input `toolsToEntries` needs.
 * `size` = 完整工具定义(名字+描述+inputSchema)的 JSON 字节数:检索价签的数据源
 * ——挂载一个工具,它的说明书就进交付 agent 每一轮的 prompt,这个字节数就是
 * 那笔"每轮税"的本体(先例:Anthropic 实测普通 MCP 每调用载入 ~15.4K token
 * 工具定义;把税标在检索结果上,选型决策才看得见价格)。
 */
interface CachedTool { name: string; description?: string; size?: number }

interface FedCacheEntry { key: string; fetchedAt: number; tools: CachedTool[] }
interface FedCache { version: number; servers: Record<string, FedCacheEntry> }

// v2:CachedTool 增 size(价签)。版本升档让旧缓存整体作废重探(一次 ~5s 冷启)。
const FED_CACHE_VERSION = 2
const FED_CACHE_PATH = join(REPO, '.cache', 'federation.json')
const FED_CACHE_TTL_MS = 7 * 24 * 3600 * 1000

/**
 * Invalidation key for one server's cached tool list: the connection config
 * plus a stamp (mtime+size) of every local file its args reference —
 * regenerating an adapter under generated/ must invalidate its entry even
 * when the config text is unchanged. Relative arg paths resolve against the
 * assembler repo, where generated/ adapters live.
 */
export function serverCacheKey(cfg: Record<string, unknown>): string {
  const h = createHash('sha256').update(JSON.stringify(cfg))
  for (const arg of Array.isArray(cfg.args) ? (cfg.args as string[]) : []) {
    const p = isAbsolutePath(arg) ? arg : join(REPO, arg)
    try {
      const st = statSync(p)
      // Regular files only: a file arg is adapter CODE, whose change must
      // re-probe. A directory arg (a data root like /tmp) has an mtime that
      // flaps on every unrelated temp file — stamping it made the
      // npx-resolved filesystem server re-probe ~3s on most runs.
      if (st.isFile()) h.update(`\n${arg}:${String(st.mtimeMs)}:${String(st.size)}`)
    } catch { /* not a local path (flag, package name) — config text covers it */ }
  }
  return h.digest('hex').slice(0, 16)
}

/** Crude absolute-path check that also covers Windows drive letters. */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
}

function loadFedCache(): FedCache {
  try {
    const parsed = JSON.parse(readFileSync(FED_CACHE_PATH, 'utf8')) as FedCache
    if (parsed.version === FED_CACHE_VERSION && typeof parsed.servers === 'object') return parsed
  } catch { /* absent or corrupt — start empty */ }
  return { version: FED_CACHE_VERSION, servers: {} }
}

function saveFedCache(cache: FedCache): void {
  try {
    mkdirSync(dirname(FED_CACHE_PATH), { recursive: true })
    writeFileSync(FED_CACHE_PATH, JSON.stringify(cache))
  } catch (error: unknown) {
    console.error(`[assembler] federation cache write failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Deterministic mapping from a server's raw tool list to catalog entries —
 * the single code path for both live-probed and cache-served tools, so a
 * cache hit can never drift from what a live probe would have produced.
 */
export function toolsToEntries(server: string, tools: CachedTool[]): CapabilityEntry[] {
  return tools.map((tool) => {
    const description = typeof tool.description === 'string' && tool.description !== ''
      ? tool.description
      : `MCP tool ${tool.name} from server ${server}`
    const words = description.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4)
    return {
      id: `mcp-${server}-${tool.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`,
      via: 'mcp' as const,
      tool: `mcp__${server}__${tool.name}`,
      description,
      tags: [...new Set([server.toLowerCase(), ...words.slice(0, 8)])],
      config: { server, ...(typeof tool.size === 'number' ? { toolBytes: tool.size } : {}) },
    }
  })
}

/**
 * Federated catalog: merge MCP server tools into the static catalog.
 *
 * The static capabilities.yml holds hand-authored entries (personas, package
 * tools, harness reuse). Every server declared under `mcp-servers` is
 * connected directly (MCP SDK), its tools listed, and each becomes a
 * `via: mcp` capability entry automatically — so adding an MCP server to
 * the catalog makes its tools assemblable with zero further edits. The
 * server's own tool description is the entry's description; tags derive
 * from server name and description words for the LLM matcher.
 *
 * The assembler connects itself rather than reading ctx.tools: the tools
 * registry has no public enumeration API, and a direct list is
 * deterministic regardless of whether the server is also mounted in the
 * host composition.
 */
/** 联邦列举时 @@WORKSPACE@@ 的替位目录(懒建、进程内复用一个即可)。 */
let fedWorkspaceStubDir: string | null = null
function fedWorkspaceStub(): string {
  if (fedWorkspaceStubDir === null) fedWorkspaceStubDir = mkdtempSync(join(tmpdir(), 'assembler-fed-ws-'))
  return fedWorkspaceStubDir
}

export async function federateMcpTools(catalog: Catalog): Promise<Catalog> {
  const servers = catalog['mcp-servers'] ?? {}
  const serverNames = Object.keys(servers)
  if (serverNames.length === 0) return catalog
  const mcpEntries: CapabilityEntry[] = []
  const collected = new Map<string, CapabilityEntry[]>()

  // Cache first: a server whose key matches and whose entry is younger than
  // the TTL is served from disk without spawning anything. DSH_ASSEMBLER_FED_CACHE=0
  // forces every server live; DSH_ASSEMBLER_FED_TTL_MS tunes the backstop.
  const cacheOn = process.env.DSH_ASSEMBLER_FED_CACHE !== '0'
  const ttlMs = Number(process.env.DSH_ASSEMBLER_FED_TTL_MS ?? FED_CACHE_TTL_MS) || FED_CACHE_TTL_MS
  const cache = cacheOn ? loadFedCache() : { version: FED_CACHE_VERSION, servers: {} }
  const keys = new Map(serverNames.map((s) => [s, serverCacheKey(servers[s])]))
  // 可达闸:stdio 声明的命令在本机解析不到,整台服务器从目录剔除(缓存命中也
  // 不豁免——缓存证明的是"当时列举过工具",不是"现在拉得起进程")。反例已付
  // 学费:filesystem 走 host 全局挂载、挂载因 npx/pnpm 布局天天死,目录照旧
  // 售卖其工具 → 选型选对了、运行时零件不存在 → agent 盲猜 7 个工具名后向
  // 用户求助、探针挂满 600s(bilingual-reader 取证,2026-08-21)。目录只许
  // 承诺本机此刻真能拉起的零件。
  const commandResolvable = (cfg: Record<string, unknown>): boolean => {
    if (cfg.transport === 'streamable-http') return true
    const cmd = String(cfg.command ?? '')
    if (cmd === '') return false
    if (cmd.includes('/')) return existsSync(cmd)
    return (process.env.PATH ?? '').split(':').some((p) => p !== '' && existsSync(join(p, cmd)))
  }
  const misses: string[] = []
  for (const server of serverNames) {
    if (!commandResolvable(servers[server])) {
      console.error(`[assembler] federateMcpTools: server "${server}" 命令不可达(${String(servers[server].command ?? '')}),目录剔除其工具`)
      continue
    }
    const hit = cache.servers[server]
    if (cacheOn && hit !== undefined && hit.key === keys.get(server) && Date.now() - hit.fetchedAt < ttlMs) {
      collected.set(server, toolsToEntries(server, hit.tools))
    } else {
      misses.push(server)
    }
  }

  if (misses.length > 0) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    // Parallel probing with a bounded pool: 30+ stdio spawns at once would
    // be a fork storm; a pool keeps wall-clock near max(server) while
    // staying polite. Wall-clock floor is per-server process cold-start
    // (~0.5s each) — which is exactly what the cache exists to skip.
    const CONCURRENCY = Math.max(1, Number(process.env.DSH_ASSEMBLER_FED_LANES ?? 16) || 16)
    const queue = [...misses]
    let cacheDirty = false
    const worker = async (): Promise<void> => {
      for (let server = queue.shift(); server !== undefined; server = queue.shift()) {
        const cfg = servers[server]
        try {
          // @@WORKSPACE@@ 在列举时用一次性临时目录替位:filesystem 这类零件要求
          // 根目录真实存在才肯启动;列举只看工具清单,给哪个根都一样。
          const transport = cfg.transport === 'streamable-http'
            ? new StreamableHTTPClientTransport(new URL(cfg.url as string))
            : new StdioClientTransport({
                command: cfg.command as string,
                args: ((cfg.args as string[] | undefined) ?? []).map((a) => a === WORKSPACE_SLOT || a === KBDIR_SLOT ? fedWorkspaceStub() : a),
                ...(cfg.env !== undefined
                  ? { env: { ...scrubbedEnv(), ...(cfg.env as Record<string, string>) } }
                  : { env: scrubbedEnv() }),
              })
          const client = new Client({ name: 'dsh-assembler', version: '0.0.1' })
          await client.connect(transport)
          const tools = await client.listTools()
          await client.close()
          const raw: CachedTool[] = tools.tools.map((t) => ({
            name: t.name,
            ...(typeof t.description === 'string' ? { description: t.description } : {}),
            // 完整定义字节(含 inputSchema):检索价签用。序列化失败就不标价,不炸联邦。
            ...((): { size?: number } => {
              try { return { size: JSON.stringify(t).length } } catch { return {} }
            })(),
          }))
          collected.set(server, toolsToEntries(server, raw))
          cache.servers[server] = { key: keys.get(server) ?? '', fetchedAt: Date.now(), tools: raw }
          cacheDirty = true
        } catch (error: unknown) {
          // No negative caching: an unreachable part stays a live retry next
          // time, and any stale cache entry it has is already key-guarded.
          console.error(`[assembler] federateMcpTools: server "${server}" unreachable: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, misses.length) }, () => worker()))
    if (cacheOn && cacheDirty) saveFedCache(cache)
  }
  // Deterministic merge in declared server order (parallel arrival order is not)
  const known = new Set(catalog.capabilities.map((c) => c.id))
  for (const server of serverNames) {
    for (const entry of collected.get(server) ?? []) {
      if (known.has(entry.id)) continue
      known.add(entry.id)
      mcpEntries.push(entry)
    }
  }
  if (mcpEntries.length === 0) return catalog
  return { capabilities: [...catalog.capabilities, ...mcpEntries], 'mcp-servers': servers }
}

// ── Parts BOM (P2.2) ───────────────────────────────────────────────────────

/** One row of index/catalog.yml — the supply-chain record of one part library. */
interface IndexRecord {
  id: string
  repo?: string
  rev?: string
  license?: string
  verified?: boolean
  /** 'service' for parts that wrap a public HTTP API; absent for library parts. */
  kind?: string
  /** Service part: base URL, terms, rate limit — its provenance has no rev to pin. */
  service?: string
  provider?: string
  terms?: string
  rateLimit?: string
  network?: boolean
}

/**
 * Render the parts BOM (`parts.lock.yml`) for an emitted preset: every
 * selected capability with its supply-chain provenance — upstream repo,
 * pinned rev, license, and the serverName the preset actually mounts. The
 * preset says WHAT the agent can do; the lock says WHERE each ability came
 * from, so an assembled agent is auditable like a dependency lockfile.
 *
 * serverNames are read back from the emitted composition text (not
 * recomputed) so the lock always matches the preset's actual bytes.
 */
export function renderPartsLock(opts: {
  presetId: string
  requirement: string
  selected: CapabilityEntry[]
  presetText: string
  index: IndexRecord[]
  personaFindings?: PersonaLintFinding[]
  params?: Record<string, string>
  requiredSecrets?: Array<RequiredSecret & { server: string; configured: boolean }>
  knowledge?: Array<{ id: string; docs: number; source?: string; version?: string }>
  /** Assembly-time pre-thought equipment shipped with the preset (e.g. equipment/init.sql). */
  equipment?: string[]
  /** 选型报出的缺口(有工单在 gaps/ 与之对应);复用闸靠它判断"是否还欠着件"。 */
  missing?: string[]
  /** 装配时目录的 id 集指纹;与 missing 联用:缺口在案 + 目录已生长 ⇒ 拒绝复用重选。 */
  catalogIdsHash?: string
}): string {
  const byId = new Map(opts.index.map((r) => [r.id, r]))
  const serverNames = [...opts.presetText.matchAll(/serverName: "([^"]+)"/g)].map((m) => m[1])
  const nameFor = (server: string): string | undefined =>
    serverNames.find((n) => n.startsWith(`${server}-`))
  const parts = opts.selected.map((c) => {
    const part: Record<string, unknown> = { capability: c.id, via: c.via }
    if (c.tool !== undefined) part.tool = c.tool
    if (c.via === 'mcp') {
      const server = (c.config?.server as string | undefined) ?? ''
      part.server = server
      const mounted = nameFor(server)
      // hostMounted servers emit no row of their own — mark the plane instead.
      if (mounted !== undefined) part.serverName = mounted
      else part.plane = 'host'
      const rec = byId.get(server)
      if (rec !== undefined) {
        // A service part has no rev to pin: its provenance IS the endpoint,
        // the terms it is used under, and the rate limit it must respect —
        // the three facts a client's compliance desk asks about.
        if (rec.kind === 'service') {
          part.kind = 'service'
          if (rec.service !== undefined) part.service = rec.service
          if (rec.provider !== undefined) part.provider = rec.provider
          if (rec.terms !== undefined) part.terms = rec.terms
          if (rec.rateLimit !== undefined) part.rateLimit = rec.rateLimit
          part.network = true
        } else {
          if (rec.repo !== undefined) part.repo = rec.repo
          if (rec.rev !== undefined) part.rev = rec.rev
        }
        if (rec.license !== undefined) part.license = rec.license
        part.verified = rec.verified !== false
      }
    } else {
      const mounts = (c.config?.presetRows ?? []).map((r) => r.name)
      if (mounts.length > 0) part.mounts = mounts
    }
    return part
  })
  const doc: Record<string, unknown> = {
    preset: opts.presetId,
    emitter: EMISSION_REV,
    assembledAt: new Date().toISOString(),
    requirement: opts.requirement.replace(/\s+/g, ' ').trim().slice(0, 140),
    parts,
  }
  if (opts.personaFindings !== undefined && opts.personaFindings.length > 0) {
    doc.personaLint = opts.personaFindings.map((f) => `${f.kind}: ${f.detail}`)
  }
  // 缺口与目录指纹入档:这是"缺件工单闭环"的另一半——重跑时复用闸读它们,
  // 发现"欠着件 + 目录已生长"就放弃复用重新选型,新入库的零件才有机会上桌。
  if (opts.missing !== undefined && opts.missing.length > 0) doc.missing = opts.missing
  if (opts.catalogIdsHash !== undefined) doc.catalogIdsHash = opts.catalogIdsHash
  // Parameters are part of the build record: the same preset id emitted with
  // different parameters is a different artifact, and the lock says which.
  if (opts.params !== undefined && Object.keys(opts.params).length > 0) doc.params = opts.params
  // Credentials are NAMED here, never valued: the lock tells an operator what
  // to configure and where it is used, and stays safe to commit.
  // Knowledge is provenance too: which teaching material, from where, at what version.
  if (opts.knowledge !== undefined && opts.knowledge.length > 0) doc.knowledge = opts.knowledge
  // Equipment is delivered pre-thinking(装配时想好的设计决策落成的工件)——
  // handover 读 lock,不该看不见随 preset 交付的自动执行装备。
  if (opts.equipment !== undefined && opts.equipment.length > 0) doc.equipment = opts.equipment
  if (opts.requiredSecrets !== undefined && opts.requiredSecrets.length > 0) {
    doc.requiredSecrets = opts.requiredSecrets.map((sec) => ({
      env: sec.env, server: sec.server, configured: sec.configured,
      ...(sec.optional === true ? { optional: true } : {}),
      ...(sec.purpose !== undefined ? { purpose: sec.purpose } : {}),
    }))
  }
  return '# 零件物料清单(BOM)— dsh-assembler 自动生成;记录每个能力的供应链出处。\n'
    + '# 审计:repo@rev 为上游锁定版本,license 为上游许可证,serverName 为本 preset 实际挂载名。\n'
    + yaml.dump(doc, { lineWidth: -1 })
}

/**
 * 缺件工单:把选型报出的每个缺口落成一份"调用方 agent 拿了就能开工"的施工单。
 *
 * 设计裁定(2026-08-21,与用户共同定稿):装配脊柱(选型神谕/确定性发射/独立
 * 验收)不动;"写缺失零件"这种需要全套 harness(工具+迭代+执行)的创造性工作
 * 交给调用方主 agent——aux 神谕调用没有工具面,写不出能用的零件。工单三要素:
 * spec(缺什么)、真实可跑的命令序列(index 流水线,门在流水线里)、本次装配
 * 的复跑指令(零件入库后重跑即闭环)。铁律:新代码必须**入库**而不是焊死在
 * 单台 preset——入库 = smoke 质检门 + BOM 供应链记录 + 全体后续装配可选 +
 * 选型账本多一条样本;直接改 preset 的产物是无门、无记录、不可复用的雪花。
 * 验收始终归 assembler 的黑盒探针:写零件的 agent 不给自己发合格证。
 */
export function renderGapWorkOrder(draft: MissingDraft, opts: { presetId: string; requirement: string }): string {
  const entryYaml = renderMissingDraft(draft)
  const route = draft.via === 'harness' && draft.mount !== undefined
    ? [
        '## 施工路线(via: harness,已知挂载行——不用写代码)',
        '',
        '把文末的目录条目追加进 capabilities.yml 的 `capabilities:` 段即可,然后直接跳到「完工闭环」。',
      ]
    : [
        `## 施工路线(via: ${draft.via}——造零件入库)`,
        '',
        `在 dsh-assembler 检出(${REPO})下:`,
        '',
        '1. 有合适上游 npm 库时用脚手架(生成 generated/<id>/ 骨架 + 上游源码缓存 + WORK-ORDER.md):',
        '',
        `   node scripts/index-add.mjs scaffold <owner/repo> --pkg <npm包名> --id ${draft.id}`,
        '',
        `   纯胶水(无上游库)则手建 generated/${draft.id}/{package.json,index.js,smoke.mjs},参考任一现有零件(如 generated/csv-parse/)。`,
        `2. 质检门:node scripts/index-add.mjs verify ${draft.id}(smoke exit 0 + 独立 listTools 实探;smoke 必须真调用工具拿真结果,不许只测"能启动")`,
        `3. 登记入库:node scripts/index-add.mjs register ${draft.id}(verify 不过会被直接拒绝;自动写 index/catalog.yml 与 capabilities.yml 的 mcp-servers 段)`,
        '4. 目录条目:register 后把文末草案并入 capabilities.yml 的 `capabilities:` 段(id/描述/tags 可按实况修润)。',
      ]
  return [
    `# 缺件工单:${draft.id}`,
    '',
    `- 需求方 preset:\`${opts.presetId}\``,
    `- 缺口:${draft.description}`,
    `- via:${draft.via}${draft.tool !== undefined ? `(tool: ${draft.tool})` : ''}`,
    '',
    '新零件必须走入库流水线,禁止把胶水代码直接塞进本 preset(无质检门、无供应链记录、不可复用)。',
    '代码里绝不写入任何凭证/token——零件从自己的进程环境读,host 或 .env 提供。',
    '',
    ...route,
    '',
    '## 目录条目草案',
    '',
    '```yaml',
    entryYaml,
    '```',
    '',
    '## 完工闭环',
    '',
    '零件入库后重跑本次装配(同名同需求会同 id 原地换代,新零件被选中并过独立验收):',
    '',
    '```',
    `/assemble ${opts.requirement.replace(/\s+/g, ' ').trim()} --name ${opts.presetId}`,
    '```',
    '',
  ].join('\n')
}

/**
 * 把全部缺口写成 gaps/ 下的工单文件;每次装配整目录重写——上一轮的缺口
 * 若已补齐,旧工单随之消失(工单反映现状,不是历史)。无缺口时目录不存在。
 */
export function writeGapWorkOrders(opts: {
  presetDir: string
  presetId: string
  requirement: string
  missingEntries: MissingDraft[]
}): string[] {
  const gapsDir = join(opts.presetDir, 'gaps')
  rmSync(gapsDir, { recursive: true, force: true })
  if (opts.missingEntries.length === 0) return []
  mkdirSync(gapsDir, { recursive: true })
  const paths: string[] = []
  for (const [i, draft] of opts.missingEntries.entries()) {
    const file = join(gapsDir, `${String(i + 1).padStart(2, '0')}-${draft.id}.md`)
    writeFileSync(file, renderGapWorkOrder(draft, { presetId: opts.presetId, requirement: opts.requirement }))
    paths.push(file)
  }
  return paths
}

/** Render one matcher draft as a copy-paste-ready capabilities.yml entry. */
export function renderMissingDraft(draft: MissingDraft): string {
  const lines = [`  - id: ${draft.id}`, `    via: ${draft.via}`, `    description: ${JSON.stringify(draft.description)}`, `    tags: [${draft.tags.join(', ')}]`]
  if (draft.tool !== undefined) lines.push(`    tool: ${draft.tool}`)
  if (draft.mount !== undefined) {
    lines.push('    config:')
    lines.push('      presetRows:')
    lines.push(`        - id: ${draft.mount.name.split('/').pop()?.replace(/^@/, '') ?? 'tool'}`)
    lines.push(`          name: '${draft.mount.name}'`)
    if (draft.mount.config !== undefined) {
      const entries = Object.entries(draft.mount.config)
      if (entries.length > 0) {
        lines.push('          config:')
        for (const [k, v] of entries) {
          lines.push(`            ${k}: ${renderYamlValue(v)}`)
        }
      }
    }
  }
  return lines.join('\n')
}

/**
 * Assemble one preset from a requirement and persist it under the preset
 * root. Returns the preset id, the selection, the missing report, and
 * copy-paste-ready catalog drafts for every missing capability.
 *
 * `options.name` is the caller's requested preset id (kebab-case slug). When
 * absent, the matcher's suggested name is used; when neither yields a usable
 * slug, the timestamp fallback id applies. The resolved id is minted BEFORE
 * emission because emitted MCP serverNames carry a hash suffix derived from
 * it — that is what keeps every preset's servers collision-free inside the
 * host's process-global serverName registry.
 */
export async function assemble(
  ctx: Context,
  requirement: string,
  config: Config,
  options: {
    name?: string
    params?: Record<string, string>
    onPhase?: (line: string) => void
    /** Force a fresh probe even when the verify ledger would carry (--reverify). */
    reverify?: boolean
    /** Skip same-name reuse: full re-selection and re-emit (--fresh). */
    fresh?: boolean
    /**
     * 方案共享库(solution 级):给了则本 agent 的 SQLite 默认库钉到这个绝对
     * 路径,与同套班子的其他 agent 读写同一份账。由 assemble_solution 传入。
     */
    sharedDb?: string
  } = {},
): Promise<{
  id: string
  capabilityIds: string[]
  missing: string[]
  presetPath: string
  drafts: string[]
  /** 缺件工单文件的绝对路径(preset/gaps/ 下,每缺口一份;无缺口为空)。 */
  gapOrders: string[]
  verification: ProbeResult
  personaLint: PersonaLintFinding[]
  params: Record<string, string>
  paramsRejected: ParamRejection[]
  requiredSecrets: Array<RequiredSecret & { server: string; configured: boolean }>
  knowledge: Array<{ id: string; docs: number; source?: string; version?: string }>
  /** Per-stage wall clock, in pipeline order — see the 耗时账单 note below. */
  timings: Array<{ stage: string; seconds: number; detail?: string }>
  /** Whole-assemble wall clock in seconds. */
  totalSeconds: number
  /** True when the same-name reuse path served this assembly (no re-selection, no re-emit). */
  reused: boolean
  /** 随 preset 发射的前端页:模板名、本地路径、host 在线时的可打开 URL。 */
  frontend: { template: string; url?: string; path: string } | null
  /** 前端验收(页面可达门+会话环路门);null = headless 无从验(结果行写"待验")。 */
  frontendCheck: { pass: boolean; reason?: string } | null
}> {
  const catalogPath = config.catalogPath ?? join(REPO, 'capabilities.yml')
  const templatePath = config.templatePath ?? join(REPO, 'presets', 'agent-template.yml')
  // Progress narration for whoever is watching (the jobs panel): a swallowed
  // reporter must never fail an assembly, hence the try around every call.
  // 进度双写:jobs 通道(readOutput)之外,同一行还落进 preset 的 progress.log
  // ——装配直播台(/assembler/ui/_console)靠轮询这份文件把行动链摆到用户眼前。
  // web 的后台任务面板只渲染条目与终态、从不消费 readOutput(源码坐实),
  // 没有这份文件,用户面对慢装配只能看一颗 chip 猜"卡了还是 bug"。
  const progressBuf: string[] = []
  let progressPath: string | null = null
  // 本地时间(不是 UTC):直播台是给盯着屏幕的人看的,11:17 与墙上钟的 19:17
  // 对不上号,第一反应是"这日志是不是旧的"(实测用户就这么问)。
  const stamp = (): string => {
    const d = new Date()
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
  }
  // 开工时刻在此定格:头行(══ assemble <id> 开始 ══)要等 id 解出才能落盘,
  // 若用落盘时刻做头行时间戳,会晚于它下面缓冲行的时间戳——链首乱序(实测)。
  const startedStamp = stamp()
  const phase = (line: string): void => {
    try { options.onPhase?.(line) } catch { /* a broken reporter must not break the build */ }
    try {
      const entry = `${stamp()} ${line}\n`
      if (progressPath !== null) appendFileSync(progressPath, entry)
      else progressBuf.push(entry)
    } catch { /* 直播是加速器不是必需品 */ }
  }
  // 无闸辅助调用的心跳:AUX 兜底闸已按用户裁定禁用(见 AUX_CALL_TIMEOUT_MS),
  // "还在推理"与"挂了"从此只能靠直播区分——每 20s 报一次经过时间。
  const hb = async <T>(label: string, p: Promise<T>): Promise<T> => {
    const t = Date.now()
    const timer = setInterval(() => { phase(`  …${label}进行中(${String(Math.round((Date.now() - t) / 1000))}s)`) }, 20_000)
    try { return await p } finally { clearInterval(timer) }
  }
  const t0 = Date.now()
  const secs = (from: number): string => `${String(Math.round((Date.now() - from) / 1000))}s`
  {
    const consolePort = (ctx.get?.('webServer') as { port?: number } | undefined)?.port
    if (consolePort !== undefined) phase(`直播台:http://127.0.0.1:${String(consolePort)}${FRONTEND_ROUTE}/_console(实时行动链在此)`)
  }
  // ── 耗时账单 ──────────────────────────────────────────────────────────
  // Every stage stamps its wall time into an ordered ledger that ships in
  // the RESULT text, not just the transient phase stream. Motivation is the
  // operator's actual question after every slow assemble: "为什么跑了这么久?"
  // — which the product used to leave unanswerable (phase lines scroll away;
  // the result said nothing). Measured on the bench: median 70s, p90 164s,
  // real deliveries up to 24 minutes — an unaccounted minute reads as a hang,
  // the SAME minute itemized ("验收探针 2 轮 130s") reads as work. A stage
  // showing 0s is information too: it says the federation cache was warm.
  const timings: Array<{ stage: string; seconds: number; detail?: string }> = []
  // detail 是这段钱的去向明细(token 账目):秒数说"花了多久",明细说"为什么"。
  const mark = (stage: string, from: number, detail?: string): void => {
    timings.push({ stage, seconds: Math.round((Date.now() - from) / 1000), ...(detail !== undefined && detail !== '' ? { detail } : {}) })
  }
  // 辅助调用共用的路由+档位(effort 只辖装配器内部调用;默认不降档,见 Config 注释)。
  const auxLlm = { provider: config.provider, model: config.model, effort: config.auxReasoningEffort }
  const staticCatalog = loadCatalog(catalogPath)
  const catalog = await federateMcpTools(staticCatalog)
  mark('零件联邦', t0)
  phase(`零件联邦就绪:${String(catalog.capabilities.length)} 条可装配(${secs(t0)})`)
  // Parameter screening happens BEFORE selection and emission: the reuse gate
  // compares the accepted set against the lock, and a refused key must never
  // influence either. Rejections are reported, not silently dropped.
  const screened = screenParams(options.params ?? {})
  const template = readFileSync(templatePath, 'utf8')
  const presetRoot = config.presetRoot ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.agent-presets')
  // ── 直播从第 1 秒起(临时链)────────────────────────────────────────────
  // progress.log 过去要等 id 解出(选型之后)才创建,而满档选型实测可达 185s
  // ——那段最焦虑的开头("到底启动没")直播台一片空白,缓冲行等选型完成才一次性
  // 刷出(用户实测:15:24 开始的链 15:28 才显示)。这里先落一份临时链,phase()
  // 立刻真写盘、心跳每 20s 刷新 mtime,选型全程可见;id 解出后把正文搬进正式
  // 目录、删临时目录。临时目录名以 _ 打头 → 前端路由的 ID_RE 天然不收,只被
  // 直播台的目录列举读到。
  const pendingDir = join(presetRoot, `_pending-${createHash('sha256').update(`${requirement}${startedStamp}`).digest('hex').slice(0, 8)}`)
  try {
    mkdirSync(pendingDir, { recursive: true })
    progressPath = join(pendingDir, 'progress.log')
    const reqSnip = requirement.replace(/\s+/g, ' ').trim().slice(0, 40)
    writeFileSync(progressPath, `${startedStamp} ══ 装配启动中·选型中…(${reqSnip})══\n${progressBuf.join('')}`)
  } catch { progressPath = null }
  // ── 同名复用(增量装配的前半)────────────────────────────────────────────
  // 调用者点名的 preset 已存在且需求/参数与其 lock 完全相同 ⇒ 不再让天生抖动的
  // LLM 重新选型(一抖 persona 字节就变,验收台账就废),也不再铸 -2/-3 代际目录
  // (那正是 roster 垃圾与 handover 永远读旧目录两个病的共同病根)。
  const reuse = options.fresh === true
    ? null
    : planReuse({ ...(options.name !== undefined ? { name: options.name } : {}), requirement, params: screened.accepted, presetRoot, catalog, catalogRoot: dirname(catalogPath) })
  let req: AssembleRequest
  let id: string
  // 台账采集位:选型账目、推导账目、重试纠错对(只在各自发生处赋值)。
  let selUsageLedger: AuxUsage | null = null
  let deriveUsageLedger: AuxUsage | null = null
  let retryLedger: SelectionLedgerRecord['retry'] = null
  // 架构 spec 提到外层作用域:选型分支产出它,下游探针派生(workflow 驱动)也要读它。
  let archSpec: import('./arch-spec.js').ArchSpec | undefined
  if (reuse !== null) {
    req = { capabilityIds: reuse.capabilityIds, params: screened.accepted, missing: [], rationale: '同名复用:需求与参数未变' }
    id = reuse.id
    timings.push({ stage: '选型(复用)', seconds: 0 })
    phase(`选型复用:需求与参数未变,沿用 ${id} 现有选型(${String(reuse.capabilityIds.length)} 个能力;全新重装用 --fresh)`)
  } else {
    // 架构优先:选型前先无目录地出一份架构 spec(这个 agent 架构上需要什么),
    // 再让选型逐条覆盖或标缺口。DSH_ASSEMBLER_ARCH_FIRST=0 可关(退回纯选型优先)。
    // 实验(2026-08-22,HR/科研/医院导诊三例)证明:纯选型优先三战三次报"0 缺口"
    // 静默丢真需求(含医疗导诊的急危重症识别、边界拒答两个安全缺口)。
    if (process.env.DSH_ASSEMBLER_ARCH_FIRST !== '0') {
      try {
        const tArch = Date.now()
        phase('架构 spec 推导中(先无目录列全需求,避免目录偏置)…')
        archSpec = await hb('架构 spec 推导', deriveArchSpec(ctx, requirement, { provider: config.provider, model: config.model }, config))
        mark('架构 spec', tArch)
        phase(`架构 spec 就绪:${String(archSpec.capabilities.length)} 项架构需求(选型将逐条覆盖或标缺口)`)
      } catch (error: unknown) {
        console.error(`[assembler] 架构 spec 推导失败(退回纯选型优先):${error instanceof Error ? error.message : String(error)}`)
        archSpec = undefined
      }
    }
    const tSel = Date.now()
    let selUsage: AuxUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 }
    req = await hb('选型推理', llmMapRequirement(ctx, requirement, catalog, { provider: config.provider, model: config.model }, config, (u) => { selUsage = u }, archSpec, (info) => phase(`能力目录粗筛:${String(info.total)} → ${String(info.kept)} 候选(选型只看相关子集)`)))
    selUsageLedger = selUsage
    mark('选型', tSel, usageDetail(selUsage))
    phase(`选型完成:${String(req.capabilityIds.length)} 个能力${req.missing.length > 0 ? `,${String(req.missing.length)} 项缺口` : ''}(${secs(tSel)})`)
    req.params = screened.accepted
    // 同概念原地重发:复用被新鲜度闸拒绝(发射代号/知识版本升级)时,同名同
    // 需求同参数的重装覆写原目录换代,而不是铸 -2 兄弟;-N 只防"不同新概念"撞名。
    const explicit = sanitizePresetName(options.name ?? '')
    const sameConcept = sameConceptOnDisk({ ...(options.name !== undefined ? { name: options.name } : {}), requirement, params: screened.accepted, presetRoot })
    if (explicit !== '' && existsSync(join(presetRoot, explicit)) && !sameConcept) {
      // 显式点名撞上"另一个概念"占着这个名字:绝不静默铸 -2(市场战役 F1 实录:
      // 主 agent 换措辞重装铸出 kanban-2,再想 rm -rf 抢回原名、申请升权)。
      // --fresh = 调用方明确要覆盖 ⇒ 原地换概念;否则把选择权还给人。
      if (options.fresh !== true) {
        throw new Error(
          `assemble: preset 名「${explicit}」已存在,且承载的是另一个需求(与本次不同)。三选一:`
          + `换一个名字;确定要覆盖旧概念就加 --fresh;或不指定名字由我起名。绝不静默铸「${explicit}-2」。`,
        )
      }
      id = explicit
      phase(`显式覆盖:「${explicit}」原承载的旧概念被 --fresh 替换(旧 kb/工作区文件保留在原目录)`)
    } else {
      id = sameConcept ? explicit : resolvePresetId(options.name, req.name, presetRoot)
    }
  }
  const dir = join(presetRoot, id)
  mkdirSync(dir, { recursive: true })
  // 直播文件就位:把临时链的正文(去掉临时头)搬进正式目录、换上正式头行,
  // 删临时目录。临时链创建失败(progressPath 为 null)时,phase() 一直在写
  // progressBuf,回退用它。
  try {
    const realPath = join(dir, 'progress.log')
    let body = progressBuf.join('')
    if (progressPath !== null && progressPath !== realPath) {
      try { body = readFileSync(progressPath, 'utf8').split('\n').slice(1).join('\n') } catch { /* 读不到临时链就用缓冲 */ }
    }
    writeFileSync(realPath, `${startedStamp} ══ assemble ${id} 开始 ══\n${body}`)
    if (progressPath !== realPath && existsSync(pendingDir) && pendingDir !== dir) {
      try { rmSync(pendingDir, { recursive: true, force: true }) } catch { /* 临时目录删不掉不影响交付 */ }
    }
    progressPath = realPath
  } catch { /* 保留 progressPath 现值(可能仍指向临时链,至少还在直播) */ }
  // Knowledge packs travel WITH the preset (copied into kb/), so the handover is
  // one self-contained directory rather than a pointer back to this machine.
  // Installed BEFORE emission because the persona has to name where they landed
  // — an agent that has to go looking for its own documents pays for the search
  // every single session.
  const knowledgeInstalled = reuse !== null ? reuse.knowledge : (() => {
    try {
      const byIdK = new Map(catalog.capabilities.map((c) => [c.id, c]))
      const selK = req.capabilityIds.map((cid) => byIdK.get(cid)).filter((c): c is CapabilityEntry => c !== undefined)
      return installKnowledgePacks(selK, dir, dirname(catalogPath))
    } catch (error: unknown) {
      console.error(`[assembler] knowledge install failed: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  })()
  if (reuse === null && knowledgeInstalled.length > 0) phase(`知识包已随 preset 安装:${knowledgeInstalled.map((k) => k.id).join('、')}`)
  // 装备:装配时预思考的 schema。仅 fresh 路径——复用轮连字节都不动,盘上装备照旧。
  let equipmentNow: StateEquipment | null = null
  if (reuse === null) {
    const byIdEq = new Map(catalog.capabilities.map((c) => [c.id, c]))
    const selectedForEquip = req.capabilityIds.map((cid) => byIdEq.get(cid)).filter((c): c is CapabilityEntry => c !== undefined)
    equipmentNow = installStateEquipment({
      ...(req.stateSchema !== undefined ? { stateSchema: req.stateSchema } : {}),
      selected: selectedForEquip,
      dir,
      ...(options.sharedDb !== undefined ? { sharedDb: options.sharedDb } : {}),
    })
    if (equipmentNow !== null) phase(`装备已发射:预建数据库 schema(equipment/init.sql,双次执行门 PASS)${options.sharedDb !== undefined ? '——钉方案共享库' : ''}`)
  }
  const tEmit = Date.now()
  const preset = reuse !== null
    ? reuse.presetText
    : emitPreset(req, catalog, template, id, knowledgeLocatorText(knowledgeInstalled) + (equipmentNow?.personaText ?? ''), equipmentNow?.extraServerEnv, join(dir, 'workspace'))
  if (reuse === null) {
    writePresetFile(join(dir, 'agent.cordis.yml'), preset)
    mark('发射', tEmit)
    phase(`preset 已发射:${id}`)
    // Display metadata beside the composition: the roster picker shows the name
    // and a one-line description (harness dsh-agent-presets reads preset.yml).
    const description = requirement.replace(/\s+/g, ' ').trim().slice(0, 140)
    writeFileSync(join(dir, 'preset.yml'), yaml.dump({ name: id, description }, { lineWidth: -1 }))
  } else {
    // 复用轮零写入:preset 的 mtime+size 是 host 的代际标记,白翻新一次就白换一代
    // (换代 ⇒ 新 serverName ⇒ 旧会话与新会话各绑一代,平添混乱)。
    phase(`preset 复用:${id}(字节未动,host 代际保持)`)
  }
  // ── 前端车道:每个 preset 装完即有可操作页 ────────────────────────────────
  // 选中 via:'frontend' 零件用其模板;没选则发兜底聊天台。模板填参确定性 ⇒
  // 复用轮重发是 no-op(顺带给老 preset 自动补页)。前端发射失败不毁装配。
  let frontendInfo: { template: string; url?: string; path: string } | null = null
  try {
    const byIdFe = new Map(catalog.capabilities.map((c) => [c.id, c]))
    const feCap = req.capabilityIds.map((cid) => byIdFe.get(cid)).find((c) => c?.via === 'frontend')
    const template = (feCap?.config?.template as string | undefined) ?? DEFAULT_FRONTEND_TEMPLATE
    const fe = emitFrontend({ template, presetDir: dir, presetId: id, requirement, workdir: join(dir, 'workspace') })
    // workspace + kb 双根都保证存在:filesystem 零件把它们当允许根,缺一即拒启。
    mkdirSync(join(dir, 'workspace'), { recursive: true })
    mkdirSync(join(dir, 'kb'), { recursive: true })
    const fePort = (ctx.get?.('webServer') as { port?: number } | undefined)?.port
    frontendInfo = {
      template: fe.template,
      path: join(dir, 'frontend', 'index.html'),
      ...(fePort !== undefined ? { url: `http://127.0.0.1:${String(fePort)}${FRONTEND_ROUTE}/${id}` } : {}),
    }
    if (fe.changed) phase(`前端已就位:${fe.template}${frontendInfo.url !== undefined ? ` → ${frontendInfo.url}` : ''}`)
  } catch (error: unknown) {
    console.error(`[assembler] 前端发射失败(装配照常):${error instanceof Error ? error.message : String(error)}`)
  }
  // Declared here because both the BOM block and the verify block read it.
  let requiredSecrets: Array<RequiredSecret & { server: string; configured: boolean }> = []

  // ── Assemble-then-verify ─────────────────────────────────────────────
  // vibe assembly's promise is find → assemble → VERIFY. Default-on probe:
  // derive an acceptance probe (the deriver picks one turn or a multi-turn
  // scenario), run it in a real session bound to this preset, judge the
  // replies. One FAIL triggers a re-selection (the matcher is told what
  // failed) and a single re-emit under the same id — failure changes the
  // ROOM (which parts are mounted), never the model's head.
  // Credentials the chosen parts need, and whether this host has them.
  // Computed before verification because an unconfigured secret changes what
  // the probe can prove — not whether the assembly is correct.
  {
    const byIdSel = new Map(catalog.capabilities.map((c) => [c.id, c]))
    const selectedNow = req.capabilityIds.map((cid) => byIdSel.get(cid)).filter((c): c is CapabilityEntry => c !== undefined)
    requiredSecrets = collectRequiredSecrets(selectedNow, catalog['mcp-servers'] ?? {})
  }
  let verification: ProbeResult = { status: 'SKIPPED', reason: 'verify disabled' }
  let personaFindings: PersonaLintFinding[] = []
  // Set when the verify-retry re-emitted the file: the BOM must then be
  // rewritten even on a reuse run (the artifact is no longer the reused one).
  let presetRewritten = false
  if (config.verify !== false) {
    // ── 增量验收:同字节 + 台账 PASS + 未过期 ⇒ 沿用,不再开探针会话 ──────
    // 沿用判定放在端口/凭证检查之前:一份已被证明过的字节不需要 host 在场,
    // headless 复装同样能拿到(如实标注的)沿用判定。
    const ttlMs = config.verifyCarryTtlMs ?? VERIFY_CARRY_TTL_MS
    const carry = options.reverify === true
      ? { carry: false, why: '--reverify 强制重验' }
      : carryDecision(loadVerifyLedger(dir), presetSha(preset), Date.now(), ttlMs)
    const port = (ctx.get?.('webServer') as { port?: number } | undefined)?.port
    // Only a REQUIRED, unconfigured credential blocks verification. An
    // optional one leaves an anonymous path the probe can still exercise.
    const missingSecrets = requiredSecrets.filter((sec) => !sec.configured && sec.optional !== true)
    if (carry.carry) {
      const led = loadVerifyLedger(dir)
      verification = {
        status: 'PASS',
        carried: true,
        reason: carry.why,
        ...(led?.kind !== undefined ? { kind: led.kind } : {}),
      }
      timings.push({ stage: '验收(沿用)', seconds: 0 })
      phase(`验收沿用:${carry.why}(增量验收;强制重验用 --reverify)`)
    } else if (port === undefined) {
      verification = { status: 'SKIPPED', reason: 'webServer port unavailable (headless run?)' }
      phase('验收跳过:无 webServer 端口(headless?)')
    } else if (missingSecrets.length > 0) {
      // The interface is in place and the preset is mountable; what is absent
      // is the operator's key. Calling that a FAILED assembly would be a lie
      // about whose problem it is (DESIGN.md: probes prove the assembly, not
      // the deployment).
      verification = {
        status: 'SKIPPED',
        reason: `待配置凭证:${missingSecrets.map((sec) => sec.env).join(', ')}——装配正确但无法实调外部服务,配好后重跑装配即可验证`,
      }
      // 这行以前漏了:凭证 SKIPPED 只设 verification 不 phase,直播台一片空白、
      // 账单无探针段,旁观者会以为"怎么没验收"(实测 hr-arch2/hr-noshortlist 都
      // 静默走了这条)。SKIPPED 是设计内降级,但必须看得见。
      phase(`验收跳过:待配置凭证 ${missingSecrets.map((sec) => sec.env).join(', ')}(装配正确,配好凭证后重跑即验;探针不对未配服务打假拳)`)
    } else {
      const byId = new Map(catalog.capabilities.map((c) => [c.id, c]))
      // 前端零件不进探针推导的工具单:它是给人用的交互面,agent 摸不到——
      // 实测推导器会把它当工具、设计"回显前端模板名"的验收标记,必假红
      // (fe-e2e 首败:标记里出现 frontend-data-desk / 记录台前端)。
      const selected = req.capabilityIds.map((cid) => byId.get(cid))
        .filter((c): c is CapabilityEntry => c !== undefined && c.via !== 'frontend')
      // 探针在 preset 自己的 workspace/ 里跑(不再用一次性 mkdtemp):
      //  1. filesystem 零件的根就钉在这里,探针读写的"工作区"与工具面指同一目录;
      //  2. 与前端页的会话共用一个持久工作区,探针验证的就是交付后真实使用的那间屋。
      const probeCwd = join(dir, 'workspace')
      mkdirSync(probeCwd, { recursive: true })
      mkdirSync(join(dir, 'kb'), { recursive: true })
      const runPlan = async (plan: ProbePlan): Promise<ProbeResult> => (
        plan.kind === 'scenario'
          ? await runScenario(port, id, plan.scenario, config.verifyTimeoutMs, phase, probeCwd)
          : await runProbe(port, id, plan.probe, config.verifyTimeoutMs, phase, probeCwd)
      )
      try {
        const tDerive = Date.now()
        // 真瓶颈打法 B(确定性构造探针):架构师在 archSpec 里顺手写了探针草图,
        // 机械校验合格就直接用——整段 ~160s 的 LLM 探针推导省掉(实测它是满档
        // 推理绑定的第二大墙钟)。校验任何一条不过 → 回退 LLM 推导,不冒质量险。
        // DSH_ASSEMBLER_ARCH_PROBE=0 强制全走 LLM 推导。
        let plan: ProbePlan | null = null
        if (process.env.DSH_ASSEMBLER_ARCH_PROBE !== '0' && archSpec?.probe !== undefined) {
          plan = validateArchProbe(archSpec.probe, sanitizeMarks)
          if (plan !== null) {
            timings.push({ stage: '探针推导(架构直构)', seconds: 0 })
            phase(plan.kind === 'scenario'
              ? `验收探针:架构直构,多轮场景共 ${String(plan.scenario.turns.length)} 轮(推导 0s,省掉整段 LLM 推导)——探针会话可在侧栏实时旁观`
              : '验收探针:架构直构,单轮(推导 0s)——探针会话可在侧栏实时旁观')
          } else {
            phase('架构探针草图未过机械校验,回退 LLM 推导…')
          }
        }
        if (plan === null) {
          phase('探针推导中(定单轮或多轮场景)…')
          const deriveUsage: AuxUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 }
          plan = await hb('探针推导', deriveProbePlan(ctx, requirement, selected, auxLlm, (u) => { addUsage(deriveUsage, { type: 'usage', usage: u }) }, archSpec !== undefined ? { workflow: archSpec.workflow, dataModel: archSpec.dataModel } : undefined))
          deriveUsageLedger = deriveUsage
          mark('探针推导', tDerive, usageDetail(deriveUsage))
          phase(plan.kind === 'scenario'
            ? `验收探针:多轮场景共 ${String(plan.scenario.turns.length)} 轮(推导 ${secs(tDerive)})——探针会话可在侧栏实时旁观`
            : `验收探针:单轮(推导 ${secs(tDerive)})——探针会话可在侧栏实时旁观`)
        }
        const tProbe = Date.now()
        verification = await runPlan(plan)
        mark(plan.kind === 'scenario' ? `验收探针(${String(plan.scenario.turns.length)}轮)` : '验收探针(单轮)', tProbe)
        if (verification.status === 'FAIL') {
          // One re-selection with failure feedback, re-emit under the same id.
          // Its own catch: a transient failure INSIDE the retry (a flaky model
          // call, a wire hiccup) must not erase the first probe's verdict —
          // the FAIL plus its evidence is the actionable result.
          try {
            phase('首探 FAIL → 携失败反馈重选型、同 id 重发一次…')
            const tRetry = Date.now()
            // 纠错对采集:重选前的选型 + 失败原因,是台账里最值钱的样本。
            const firstSelectedIds = [...req.capabilityIds]
            const firstFailReason = (verification.reason ?? '回复未包含验收标记').slice(0, 200)
            const retryReq = await hb('重选型推理', llmMapRequirement(
              ctx,
              `${requirement}\n\n(上一次装配选了 [${req.capabilityIds.join(', ')}],冒烟探针未通过:${verification.reason ?? '回复未包含验收标记'}。请重新选型,优先替换可能不匹配的零件。)`,
              catalog,
              { provider: config.provider, model: config.model },
              config,
            ))
            const retrySelected = retryReq.capabilityIds.map((cid) => byId.get(cid))
              .filter((c): c is CapabilityEntry => c !== undefined && c.via !== 'frontend')
            // 重选可能换掉状态零件或重画 schema:装备随重选一起重装,preset 的
            // env 指针与 persona 句都以重试代际为准。
            const retryEquipment = installStateEquipment({
              ...(retryReq.stateSchema !== undefined ? { stateSchema: retryReq.stateSchema } : {}),
              selected: retrySelected,
              dir,
              ...(options.sharedDb !== undefined ? { sharedDb: options.sharedDb } : {}),
            })
            equipmentNow = retryEquipment
            const retryPreset = emitPreset(retryReq, catalog, template, id, knowledgeLocatorText(knowledgeInstalled) + (retryEquipment?.personaText ?? ''), retryEquipment?.extraServerEnv, join(dir, 'workspace'))
            writePresetFile(join(dir, 'agent.cordis.yml'), retryPreset)
            presetRewritten = true
            const retryPlan = await hb('重试探针推导', deriveProbePlan(ctx, requirement, retrySelected, auxLlm, undefined, archSpec !== undefined ? { workflow: archSpec.workflow, dataModel: archSpec.dataModel } : undefined))
            verification = await runPlan(retryPlan)
            mark('重试轮(重选+重验)', tRetry)
            retryLedger = {
              firstSelected: firstSelectedIds,
              failReason: firstFailReason,
              retrySelected: retryReq.capabilityIds,
              retryStatus: verification.status,
            }
            if (verification.status === 'PASS') {
              req.capabilityIds = retryReq.capabilityIds
              // The persona of record is the retry's too — the lock lints the
              // text that actually shipped, not the first generation's.
              req.persona = retryReq.persona
              // 缺口报告与缺件工单同理:以实际上桌的重试选型为准。
              req.missing = retryReq.missing
              req.missingEntries = retryReq.missingEntries
            }
          } catch (retryError: unknown) {
            verification = {
              ...verification,
              reason: `${verification.reason ?? '回复未包含验收标记'};重试轮出错:${retryError instanceof Error ? retryError.message : String(retryError)}`,
            }
          }
        }
      } catch (error: unknown) {
        // ERRORED, not SKIPPED: the probe machinery broke, so this agent is
        // UNVERIFIED. A caller aggregating verdicts must be able to fail on it.
        verification = { status: 'ERRORED', reason: `probe error: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
  }

  // ── 前端验收(纳入装配即验证)─────────────────────────────────────────
  // 页面可达门每轮都打(发射对了但伺服不通 = 交付白屏);会话环路门只在
  // 非沿用轮打(用页面同款参数开真会话回显口令,证页面那套接线端到端活着)。
  let frontendCheck: { pass: boolean; reason?: string } | null = null
  if (frontendInfo !== null && config.verify !== false) {
    const gatePort = (ctx.get?.('webServer') as { port?: number } | undefined)?.port
    if (gatePort !== undefined) {
      const tFe = Date.now()
      try {
        frontendCheck = await runFrontendGate(gatePort, id, dir, { loop: verification.carried !== true })
      } catch (error: unknown) {
        frontendCheck = { pass: false, reason: error instanceof Error ? error.message : String(error) }
      }
      mark('前端验收', tFe)
      phase(frontendCheck.pass ? `前端验收:${frontendCheck.reason ?? 'PASS'}` : `前端验收:FAIL——${frontendCheck.reason ?? ''}`)
    }
  }

  // ── 缺件工单(在验收之后落盘:重试轮可能换过选型,工单以上桌代际为准)──
  // 草案与工单同源 req.missingEntries;工单是"主 agent 拿了就能开工"的施工单,
  // 详见 renderGapWorkOrder 的设计裁定注释。落盘失败不毁装配(缺口在结果文本
  // 里仍有报告)。
  const drafts = (req.missingEntries ?? []).map(renderMissingDraft)
  let gapOrders: string[] = []
  try {
    gapOrders = writeGapWorkOrders({ presetDir: dir, presetId: id, requirement, missingEntries: req.missingEntries ?? [] })
    if (gapOrders.length > 0) {
      phase(`缺件工单已落盘:${String(gapOrders.length)} 份 → ${join(dir, 'gaps')}/(照单造件入库,重跑本次 assemble 即闭环)`)
    }
  } catch (error: unknown) {
    console.error(`[assembler] 缺件工单落盘失败(装配照常):${error instanceof Error ? error.message : String(error)}`)
  }

  // 台账落笔:新鲜 PASS 才入账(沿用不重写台账;FAIL/SKIPPED/ERRORED 没有可记的
  // 证据)。哈希取盘上实文而非内存变量:重试轮可能已重发,盘上那份才是被探过的。
  if (verification.status === 'PASS' && verification.carried !== true) {
    try {
      const onDisk = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8')
      const summary = verification.kind === 'scenario' ? verification.scenario?.goal : verification.probe?.task
      saveVerifyLedger(dir, {
        presetSha256: presetSha(onDisk),
        status: 'PASS',
        ...(verification.kind !== undefined ? { kind: verification.kind } : {}),
        verifiedAt: new Date().toISOString(),
        ...(typeof summary === 'string' && summary !== '' ? { summary: summary.slice(0, 120) } : {}),
      })
    } catch (error: unknown) {
      // 台账是加速器不是必需品:写不上只损失下次的沿用,不损失这次的判定。
      console.error(`[assembler] verify ledger write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Parts BOM — written LAST so it reflects the final generation: after a
  // verify-retry re-selection, req.capabilityIds and the preset bytes on
  // disk are both the retry's, and the lock reads them from there.
  try {
    const byIdAll = new Map(catalog.capabilities.map((c) => [c.id, c]))
    const finalSelected = req.capabilityIds
      .map((cid) => byIdAll.get(cid))
      .filter((c): c is CapabilityEntry => c !== undefined)
    // Persona lint on the FINAL generation's actual text — read back from the
    // preset ON DISK (the artifact being handed over), falling back to the
    // resolution chain only if the file cannot yield a persona row. On a reuse
    // run req.persona is undefined, so the disk text is the ONLY honest source.
    const mcpServersAll = catalog['mcp-servers'] ?? {}
    const hostMounted = Object.keys(mcpServersAll).filter((sv) => mcpServersAll[sv].hostMounted === true)
    const diskPreset = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8')
    personaFindings = lintPersona(personaFromPresetText(diskPreset) ?? resolvePersonaText(req.persona, finalSelected), finalSelected, hostMounted)
    // 复用轮且未重发 ⇒ BOM 不重写:内容与上次逐字节相同,重写只翻新 assembledAt
    // 时间戳——工件字节稳定优先(diff 干净、mtime 不骗人)。
    if (reuse === null || presetRewritten) {
      // The index lives BESIDE the catalog in use: a client catalog
      // (catalogs/<client>/capabilities.yml) has its own index/catalog.yml, and
      // reading the public one instead produced BOM rows with no provenance at
      // all for client parts — the one thing a handover document exists to show.
      // One index per catalog layer, base first, so a client layer's own parts
      // override the public entry of the same id.
      const index = catalogChain(catalogPath).flatMap((layer) => {
        const indexPath = join(dirname(layer), 'index', 'catalog.yml')
        if (!existsSync(indexPath)) return []
        const parsed = yaml.load(readFileSync(indexPath, 'utf8'))
        return Array.isArray(parsed) ? (parsed as IndexRecord[]) : []
      })
      writeFileSync(join(dir, 'parts.lock.yml'), renderPartsLock({
        presetId: id,
        requirement,
        selected: finalSelected,
        presetText: diskPreset,
        index,
        personaFindings,
        params: screened.accepted,
        requiredSecrets,
        knowledge: knowledgeInstalled,
        ...(equipmentNow !== null ? { equipment: equipmentNow.files } : {}),
        missing: req.missing,
        catalogIdsHash: catalogIdsHash(catalog),
      }))
    }
  } catch (error: unknown) {
    // The lock is provenance metadata: failing to write it must not fail
    // the assembly the user asked for.
    console.error(`[assembler] parts.lock.yml write failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const totalSeconds = Math.round((Date.now() - t0) / 1000)
  // 选型台账:只记真选型(复用轮选型没跑,不是样本);写失败绝不影响装配。
  if (reuse === null) {
    try {
      const byIdL = new Map(catalog.capabilities.map((c) => [c.id, c]))
      const selectedL = req.capabilityIds.map((cid) => byIdL.get(cid)).filter((c): c is CapabilityEntry => c !== undefined)
      const auxNums = (u: AuxUsage | null): { out: number; reason: number; cache: number } | undefined =>
        u === null ? undefined : { out: u.outputTokens, reason: u.reasoningTokens, cache: u.cacheReadTokens }
      appendSelectionLedger({
        at: new Date().toISOString(),
        requirement,
        presetId: id,
        catalogPath: catalogPath.replace(`${REPO}/`, ''),
        catalogSize: catalog.capabilities.length,
        catalogHash: catalogIdsHash(catalog),
        params: screened.accepted,
        selected: req.capabilityIds,
        missing: req.missing,
        personaSource: selectedL.some((c) => c.config?.persona !== undefined)
          ? 'catalog'
          : (typeof req.persona === 'string' && req.persona.trim() !== '' ? 'generated' : 'default'),
        stateSchema: equipmentNow !== null,
        aux: {
          effort: config.auxReasoningEffort ?? 'inherit',
          ...(auxNums(selUsageLedger) !== undefined ? { selection: auxNums(selUsageLedger) } : {}),
          ...(auxNums(deriveUsageLedger) !== undefined ? { derive: auxNums(deriveUsageLedger) } : {}),
        },
        probe: {
          status: verification.status,
          ...(verification.kind !== undefined ? { kind: verification.kind } : {}),
          ...(verification.turns !== undefined ? { turns: verification.turns.length } : {}),
          ...(verification.reason !== undefined ? { reason: verification.reason.slice(0, 200) } : {}),
        },
        retry: retryLedger,
        ...(frontendInfo !== null ? { frontendGate: frontendCheck === null ? 'SKIPPED' : frontendCheck.pass ? 'PASS' : `FAIL:${(frontendCheck.reason ?? '').slice(0, 120)}` } : {}),
        timings,
        totalSeconds,
      })
    } catch (error: unknown) {
      console.error(`[assembler] selection ledger write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  phase(`装配完成:共 ${String(totalSeconds)}s — ${timings.map((s) => `${s.stage} ${String(s.seconds)}s`).join(' · ')}`)
  return { id, capabilityIds: req.capabilityIds, missing: req.missing, presetPath: join(dir, 'agent.cordis.yml'), drafts, gapOrders, verification, personaLint: personaFindings, params: screened.accepted, paramsRejected: screened.rejected, requiredSecrets, knowledge: knowledgeInstalled, timings, totalSeconds, reused: reuse !== null, frontend: frontendInfo, frontendCheck }
}

/** Shared human-facing result text for the command and the tool. */
export function assembleResultText(result: Awaited<ReturnType<typeof assemble>>): string {
  const missing = result.missing.length > 0
    ? `\nmissing capabilities (not in catalog): ${result.missing.join(', ')}`
    : ''
  // 缺件工单优先:有工单时结果只报路径与闭环指令(草案 YAML 已在工单里,
  // 不再整段刷进对话);工单落盘失败才回退到内联草案,缺口报告绝不失踪。
  const gapOrders = result.gapOrders ?? []
  const drafts = gapOrders.length > 0
    ? `\n\n缺件工单(${String(gapOrders.length)} 份)——请照单造件并入库,入库后重跑本次 assemble 即闭环:\n${gapOrders.map((p) => `  ${p}`).join('\n')}\n(工单含施工路线、质检门命令与目录条目草案;新零件必须走 index 流水线入库,不要直接改本 preset。)`
    : result.drafts.length > 0
      ? `\n\n补件草案 (append to the "capabilities:" section of capabilities.yml):\n${result.drafts.join('\n')}`
      : ''
  const v = result.verification
  // Two probe shapes render differently: a single probe reports its task and
  // marks; a scenario reports the turn ladder, which is the evidence that
  // state survived across turns. A CARRIED verdict renders neither: its
  // evidence is the ledger reference, and saying so out loud is the whole
  // honesty contract of incremental acceptance.
  let verifyLine: string
  if (v.carried === true) {
    verifyLine = `\n自动验证:PASS — ${v.reason ?? '沿用上次验收'}(增量验收:同字节不重探;强制重验加 --reverify)`
  } else if (v.kind === 'scenario' && v.scenario !== undefined) {
    const ladder = (v.turns ?? [])
      .map((t) => `  第${String(t.index)}轮 ${t.pass ? '✓' : '✗'} 「${t.prompt.slice(0, 50)}」标记 [${t.mustInclude.join(', ')}]`)
      .join('\n')
    const head = `场景「${v.scenario.goal.slice(0, 60)}」共 ${String(v.scenario.turns.length)} 轮`
    verifyLine = v.status === 'PASS'
      ? `\n自动验证:PASS — 多轮${head},逐轮通过\n${ladder}`
      : v.status === 'FAIL'
        ? `\n自动验证:FAIL — 多轮${head};${v.reason ?? ''}\n${ladder}(preset 已生成,建议人工试用)`
        : v.status === 'ERRORED'
          ? `\n自动验证:未能验证(${v.reason ?? ''})——preset 已生成但没有跑过验收,不可当作通过`
          : `\n自动验证:跳过(${v.reason ?? ''})`
  } else {
    const marks = v.probe !== undefined ? `;验收标记 [${v.probe.mustInclude.join(', ')}]` : ''
    verifyLine = v.status === 'PASS'
      ? `\n自动验证:PASS — 探针「${v.probe?.task.slice(0, 80) ?? ''}」通过${marks}`
      : v.status === 'FAIL'
        ? `\n自动验证:FAIL — ${v.reason ?? '探针回复未含验收标记'}${marks};探针「${v.probe?.task.slice(0, 80) ?? ''}」`
          + `${v.reply !== undefined && v.reply !== '' ? `;回复摘录「${v.reply.slice(0, 120)}」` : ''}(preset 已生成,建议人工试用)`
        : v.status === 'ERRORED'
          ? `\n自动验证:未能验证(${v.reason ?? ''})——preset 已生成但没有跑过验收,不可当作通过`
          : `\n自动验证:跳过(${v.reason ?? ''})`
  }
  const paramLine = Object.keys(result.params).length > 0
    ? `\n装配参数:${Object.entries(result.params).map(([k, v]) => `${k}=${v}`).join(', ')}`
    : ''
  const rejectLine = result.paramsRejected.length > 0
    ? `\n参数被拒:${result.paramsRejected.map((r) => `${r.key}(${r.reason})`).join(';')}`
    : ''
  const kbLine = result.knowledge.length > 0
    ? `\n知识包:${result.knowledge.map((k) => `${k.id}(${String(k.docs)} 篇${k.version !== undefined ? `,版本 ${k.version}` : ''})`).join(';')} — 已拷入 preset 的 kb/`
    : ''
  const secretLines = result.requiredSecrets.length > 0
    ? `\n所需凭证:${result.requiredSecrets.map((sec) => `${sec.env}${sec.configured ? '(已配置)' : sec.optional === true ? '(可选,未配则降级)' : '(待配置)'}${sec.purpose !== undefined ? ` — ${sec.purpose}` : ''}`).join(';')}`
      + (result.requiredSecrets.some((sec) => !sec.configured && sec.optional !== true)
        ? '\n  配置方式:把待配置的变量写进 host 环境或部署的 .env(值不会写进 preset 文件),配好后重跑装配即可完成验证'
        : '')
    : ''
  const lint = result.personaLint.length > 0
    ? `\npersona 检查:${String(result.personaLint.length)} 条提示 — ${result.personaLint.map((f) => f.detail).join(';')}`
    : ''
  // 耗时账单 renders in the RESULT, not only the transient phase stream:
  // "为什么跑了这么久" must be answerable after the fact, from the artifact
  // the user actually keeps. Stages that never ran (verify off) simply don't
  // appear; time no stage claimed (session handshake, BOM write, retry paths
  // that errored mid-way) is surfaced as 其他 rather than silently vanishing.
  const accounted = result.timings.reduce((a, s) => a + s.seconds, 0)
  const other = result.totalSeconds - accounted
  const billParts = [
    // detail 是 token 去向(出/思/缓):同一个 90s,写成"探针推导 90s(出7.1k/思6.2k/缓1.1k)"
    // 才回答得了"为什么"——秒数指认哪段贵,明细指认贵在推理链还是预填。
    ...result.timings.map((s) => `${s.stage} ${String(s.seconds)}s${s.detail !== undefined ? `(${s.detail})` : ''}`),
    ...(other >= 2 ? [`其他 ${String(other)}s`] : []),
  ]
  const billLine = `\n耗时:共 ${String(result.totalSeconds)}s — ${billParts.join(' · ')}`
  const reuseLine = result.reused
    ? '\n选型复用:需求与参数与上次相同,preset 未重发(全新重装加 --fresh)'
    : ''
  const fe = result.frontend ?? null
  const fc = result.frontendCheck ?? null
  const fcText = fe === null ? '' : fc === null ? ';前端验收:待验(headless)' : fc.pass ? `;前端验收:${fc.reason ?? 'PASS'}` : `;前端验收:FAIL(${fc.reason ?? ''})`
  const feLine = fe !== null
    ? `\n前端页面:${fe.url ?? fe.path}(模板 ${fe.template},浏览器打开即可直接操作)${fcText}`
    : ''
  // ── 给调用方 agent 的行为契约 ──────────────────────────────────────────
  // 市场战役 F6 实录:FAIL 判决后主 agent 义警修复全谱系——改写需求重调 assemble
  // (铸 -2 兄弟)、rm -rf 产物目录、edit 手改 preset persona、自行经 wire 重跑
  // 探针、grep 装配器源码试图调试装配器。契约随结果走:决策点上的新鲜段落,
  // 比工具描述里的陈年一句可靠。逐条对症,不是空洞礼貌。
  const failed = v.status === 'FAIL' || v.status === 'ERRORED'
  const contract = [
    '',
    '【给调用方 agent 的行为契约】',
    '- 如实向用户转述:preset id、验证结论' + (result.frontend?.url !== undefined ? '、前端 URL(用户要能点开)' : '') + (gapOrders.length > 0 ? '、缺件工单路径' : '') + '。',
    ...(failed ? [
      '- 装配器已自带一次"携失败反馈重选型"的重试,本结果就是重试后的终局。不要再调 assemble 重试,不要改写需求另装一台。',
      '- preset 目录与装配器源码不是你的修理对象:禁止编辑/删除 preset 文件,禁止自行重跑探针,禁止翻装配器源码调试。把失败原因与证据转述给用户,等用户定夺。',
    ] : []),
    ...(gapOrders.length > 0 ? ['- 缺件工单先转述、征得用户同意后再照单施工(在 dsh-assembler 检出目录下执行工单命令,新零件必须入库)。'] : []),
    ...(result.requiredSecrets.some((s) => !s.configured) || result.paramsRejected.length > 0
      ? ['- 待配置凭证/被拒的秘密参数必须转述给用户:凭证配到 host 环境变量,绝不进装配参数。'] : []),
  ].join('\n')
  return `assembled preset "${result.id}" with: ${result.capabilityIds.join(', ')}${missing}${drafts}${reuseLine}${verifyLine}${feLine}${kbLine}${secretLines}${paramLine}${rejectLine}${lint}${billLine}${contract}\n`
    + `preset file: ${result.presetPath}\n`
    + `start a new session and select preset ${result.id} to use it.`
}

export const name = 'dsh-assembler'
export const inject = ['commands', 'llm', 'tools']

// NOTE: no `export default` — the cordis loader's unwrapExports reads
// `exports.default ?? exports`, so a default export would hide the named
// `inject`/`name` exports from it (same trap as dsh-cs-tools).

export function apply(ctx: Context, config: Config = {}): void {
  // ── 配合形态注册矩阵(DSH_ASSEMBLER_MODE,一臂一台 host,互不污染)────────
  // 形态探索(docs/ab-orchestrated-mode.md + C/D/F 扩展):pipeline = A 臂一条龙;
  // orchestrated = B 臂三工具;draft = C 臂提案审阅;dialogue = D 臂对话专家;
  // search = F 臂纯检索。非 pipeline 模式一律不注册 assemble*(臂间互斥,数据干净);
  // emit_preset/verify_preset(哑发射+独立考官)是所有新形态的公共底座。
  const mode = assemblerMode()
  if (mode === 'off') {
    // 完全停用(实验对照/纯写码环境):零工具零命令。前端路由仍伺服既有 preset
    // 页面(它们是静态字节,不属于装配面)。
  } else if (mode === 'pipeline') {
    // Agent-native path: the same capability as a tool, so the agent loop
    // renders the call (reasoning → tool card → result) in the conversation.
    // Registered on the host plane (like dsh-cs-tools), visible to every agent.
    ctx.effect(() => ctx.tools.register(assembleToolDefinition(ctx, config)), 'assembler.tool.assemble()')
    // 多 agent 方案交付:assemble 装一个,assemble_solution 装一整套班子 + HANDOVER。
    // FDE 级实测(f01)暴露:没有它,主 agent 面对多 agent 需求只能揉成巨型单体。
    ctx.effect(() => ctx.tools.register(solutionToolDefinition(ctx, config)), 'assembler.tool.assemble_solution()')
  } else {
    ctx.effect(() => ctx.tools.register(emitPresetToolDefinition(ctx, config)), 'assembler.tool.emit_preset()')
    ctx.effect(() => ctx.tools.register(verifyPresetToolDefinition(ctx, config)), 'assembler.tool.verify_preset()')
    // 共享数据考官:多 agent 班子(同一 sharedDb)的 FDE 闭环,所有编排形态可用。
    ctx.effect(() => ctx.tools.register(verifySharedDataToolDefinition(ctx, config)), 'assembler.tool.verify_shared_data()')
    // 配方车道(app 形态):哑实例化 + app 独立考官,与 preset 车道同构。
    ctx.effect(() => ctx.tools.register(emitAppToolDefinition(ctx, config)), 'assembler.tool.emit_app()')
    ctx.effect(() => ctx.tools.register(verifyAppToolDefinition(ctx, config)), 'assembler.tool.verify_app()')
    ctx.effect(() => ctx.tools.register(deployAppToolDefinition(ctx, config)), 'assembler.tool.deploy_app()')
    // 触发面考官:无人值守形态(cron/webhook 唤醒)的第四格——打一发,验后果。
    ctx.effect(() => ctx.tools.register(verifyTriggerToolDefinition(ctx, config)), 'assembler.tool.verify_trigger()')
    if (mode === 'search' || mode === 'orchestrated' || mode === 'dialogue') {
      // search 默认形态里 match 是"专家精排"备用阀:平时零调用,检索拿不准时升级。
      ctx.effect(() => ctx.tools.register(matchCatalogToolDefinition(ctx, config)), 'assembler.tool.match_catalog()')
    }
    if (mode === 'dialogue') {
      ctx.effect(() => ctx.tools.register(askCatalogToolDefinition(ctx, config)), 'assembler.tool.ask_catalog()')
    }
    if (mode === 'draft') {
      ctx.effect(() => ctx.tools.register(draftAssemblyToolDefinition(ctx, config)), 'assembler.tool.draft_assembly()')
    }
    if (mode === 'search') {
      ctx.effect(() => ctx.tools.register(searchCatalogToolDefinition(ctx, config)), 'assembler.tool.search_catalog()')
    }
  }
  // 实验工具(flag 门控,不进正常面):DSH_ASSEMBLER_EXPERIMENT=1 才注册,验完即撤。
  // 对照"选型优先 vs 架构优先"的实际产出差异(用户 2026-08-22 提的架构-first 问题)。
  if (process.env.DSH_ASSEMBLER_EXPERIMENT === '1') {
    ctx.effect(() => ctx.tools.register(specExperimentToolDefinition(ctx, config)), 'assembler.tool.spec_experiment()')
  }

  // 前端路由:/assembler/ui/<id> 同源伺服各 preset 的 frontend/ 静态文件。
  // webServer 走可选注入(dsh-ios 同款):headless profile 没有它,装配照常,
  // 只是结果里给本地路径而非 URL。装配器只发静态字节,不参与会话执行——
  // 与 roster 伺服 preset 同性质,运行时判据不越界。
  try {
    const inject = (ctx as unknown as { inject?: (deps: string[], cb: (c2: Context) => void) => void }).inject
    inject?.call(ctx, ['webServer'], (c2: Context) => {
      const ws = (c2 as unknown as { webServer: { register: (route: { kind: string; path: string; handler: unknown }) => () => void } }).webServer
      const presetRoot = config.presetRoot ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.agent-presets')
      c2.effect(() => ws.register({ kind: 'prefix', path: FRONTEND_ROUTE, handler: frontendRouteHandler(presetRoot) }), 'assembler.frontend.route')
    })
  } catch (error: unknown) {
    console.error(`[assembler] 前端路由注册失败(headless?):${error instanceof Error ? error.message : String(error)}`)
  }

  if (mode === 'off') return
  ctx.commands.register({
    name: 'assemble',
    description: 'Assemble an agent from a natural-language requirement (vibe assembly). Usage: /assemble <requirement> [--name <kebab-case-preset-name>] [--param key=value ...]',
    // input.hint is REQUIRED for the web client's slash pipeline to claim
    // the token and route "/assemble <args>" to command.execute. Without it,
    // an argued line falls through to the default chat sink (the LLM gets
    // "/assemble ..." as plain text) and only a bare /assemble executes —
    // which the handler then rejects as missing its requirement. Same
    // contract as the built-in feedback/goal/permission/plan commands.
    input: { hint: '<requirement>' },
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const raw = invocation.rawInput.trim()
      if (raw === '') {
        return {
          kind: 'error',
          text: 'usage: /assemble <what you want the agent to do> [--name <kebab-case-preset-name>] [--param k=v ...] [--reverify] [--fresh]',
        }
      }
      // Optional flags, any order after the requirement:
      //   --name <slug>        name the preset id directly
      //   --param k=v          non-secret deployment parameter (repeatable)
      //   --reverify           ignore the verify ledger, probe fresh
      //   --fresh              skip same-name reuse, full re-selection
      // Parsed off the tail so the requirement itself keeps its own wording;
      // boolean flags are stripped FIRST because the tail parsers anchor to $.
      const params: Record<string, string> = {}
      let rest = raw
      let reverify = false
      let fresh = false
      rest = rest.replace(/\s--reverify\b/g, () => { reverify = true; return '' })
      rest = rest.replace(/\s--fresh\b/g, () => { fresh = true; return '' })
      for (;;) {
        const paramMatch = rest.match(/\s--param(?:=|\s+)([A-Za-z][A-Za-z0-9_-]{0,39})=(\S+)\s*$/)
        if (paramMatch === null) break
        params[paramMatch[1]] = paramMatch[2]
        rest = rest.slice(0, paramMatch.index).trimEnd()
      }
      const nameMatch = rest.match(/^(.*?)\s+--name(?:=|\s+)([a-zA-Z0-9][a-zA-Z0-9-]{0,63})\s*$/)
      const requirement = (nameMatch ? nameMatch[1] : rest).trim()
      if (requirement === '') {
        return { kind: 'error', text: 'usage: /assemble <what you want the agent to do> [--name <kebab-case-preset-name>] [--param k=v ...] [--reverify] [--fresh]' }
      }
      try {
        const result = await assemble(ctx, requirement, config, {
          ...(nameMatch?.[2] !== undefined ? { name: nameMatch[2] } : {}),
          params,
          ...(reverify ? { reverify: true } : {}),
          ...(fresh ? { fresh: true } : {}),
        })
        return { kind: 'success', text: assembleResultText(result) }
      } catch (error: unknown) {
        return {
          kind: 'error',
          text: `assemble failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  })
}
