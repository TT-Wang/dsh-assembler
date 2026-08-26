/**
 * 装配核心 —— 这门语言的"编译器芯",作为 dsh 插件。
 *
 * 本文件是确定性的那一半:目录加载与联邦、确定性发射(emitPreset + 全部闸门)、
 * BOM/缺件工单/知识包/装备槽、验收台账,以及 host 接线(工具面注册 + 前端路由)。
 * 工具面本体(检索/发射/考官)在 orchestrated-tools.ts;编排智力归主 agent。
 *
 * 历史:这里曾有一条龙 `assemble()` 脊柱(选型 LLM + 自动重试 + /assemble 命令,
 * pipeline 形态)。四个实验形态均已判负并按宪法第八条删除——git 备查。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import yaml from 'js-yaml'
import { addKnowledgeToolDefinition, readPresetToolDefinition, submitPartToolDefinition, assemblerMode, deployAppToolDefinition, emitAppToolDefinition, emitPresetToolDefinition, matchCatalogToolDefinition, searchCatalogToolDefinition, verifyAppToolDefinition, verifyPresetToolDefinition, verifyTriggerToolDefinition, verifySharedDataToolDefinition } from './orchestrated-tools.js'
import { FRONTEND_ROUTE, frontendRouteHandler } from './frontend.js'

export { FRONTEND_ROUTE, FRONTEND_TEMPLATES_DIR, DEFAULT_FRONTEND_TEMPLATE, emitFrontend, fillTemplate, shortTitle, listAssemblyProgress, listFrontendTemplates, resolveFrontendFile, frontendRouteHandler } from './frontend.js'
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
   * (曾有第六种 via:'recipe'——独立 app 图纸;宪法第九条执行后配方并入
   * scaffold 装备,不再是目录零件,git 备查。)
   */
  via: 'package' | 'harness' | 'mcp' | 'knowledge' | 'frontend'
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
export interface ReconcileReport {
  resolved: string[]
  repaired: Array<{ from: string; to: string }>
  dropped: string[]
}

export function reconcileCapabilityIdsDetailed(requested: readonly string[], catalogIds: readonly string[]): ReconcileReport {
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
  const repaired: Array<{ from: string; to: string }> = []
  const dropped: string[] = []
  for (const id of requested) {
    if (known.has(id)) {
      resolved.push(id)
      continue
    }
    const hit = byNorm.get(norm(id))
    if (hit !== undefined) {
      console.error(`[assembler] capability id repaired: "${id}" → "${hit}"`)
      repaired.push({ from: id, to: hit })
      resolved.push(hit)
    } else {
      dropped.push(id)
    }
  }
  if (dropped.length > 0) {
    console.error(`[assembler] unknown capability ids dropped: ${dropped.join(', ')}`)
  }
  if (resolved.length === 0 && requested.length > 0) {
    // 过堂刀3:曾是英文陈名反问句,且近似候选就躺在 byNorm 里没伸手。
    const toks = requested.flatMap((rid) => norm(rid).split('-')).filter((t) => t.length >= 4)
    const near = [...new Set([...byNorm.values()].filter((cid) => toks.some((t) => cid.includes(t))))].slice(0, 6)
    throw new Error(`emit_preset: capabilityIds 全部不在目录:${requested.join(', ')}。常见病:凭记忆写 id、丢了 mcp- 前缀。${near.length > 0 ? `近似候选:${near.join('、')}。` : ''}用 search_catalog 逐项检索确认真实 id 后重调`)
  }
  return { resolved: [...new Set(resolved)], repaired, dropped }
}

/** 兼容薄封装:只要调和结果。一份实现在 reconcileCapabilityIdsDetailed。 */
export function reconcileCapabilityIds(requested: readonly string[], catalogIds: readonly string[]): string[] {
  return reconcileCapabilityIdsDetailed(requested, catalogIds).resolved
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
      `emit_preset: 发射的 preset 不是合法 YAML(${first})——通常是某条能力行的 name/id 或某个参数值含 YAML 特殊字符;`
      + '修好该行/该值再装配,绝不把装不上的 preset 当成功交付',
    )
  }
  if (!Array.isArray(doc) || doc.length === 0) {
    throw new Error('emit_preset: 发射的 preset 未解析成非空的行序列——模板或能力行渲染坏了,拒绝写入')
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

/**
 * 这件零件够不够得着本 preset 的教材区(kb/)——死知识闸的判据。
 *
 * mcp 件由 **@@KBDIR@@ 槽位**推定:那是发射端真会替换成 kb 绝对路径的承重槽,
 * 声明了它就是把 kb 当根拉起,伪造不了(比按 server 名字认可靠——按名字猜是本
 * 仓库反复付过学费的病)。非 mcp 件(harness 行、host 平面工具)没有这种可推定
 * 的结构,由目录显式声明 `config.readsKb: true`。
 */
export function canReadKb(c: CapabilityEntry, servers: Record<string, Record<string, unknown>>): boolean {
  if (c.via === 'mcp') {
    const sv = c.config?.server as string | undefined
    const args = sv !== undefined ? servers[sv]?.args : undefined
    return Array.isArray(args) && args.includes(KBDIR_SLOT)
  }
  return c.config?.readsKb === true
}

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
): { installed: InstalledPack[]; skipped: Array<{ id: string; packId: string; expectedDir: string }> } {
  const installed: InstalledPack[] = []
  // 过堂刀2③:目录条目在、盘上包被移走时曾静默 continue——发射"成功"而 kb/ 空,
  // 死知识闸只查"有没有手",没人查"有没有书"。缺书如实上报,拒不拒印由调用方裁。
  const skipped: Array<{ id: string; packId: string; expectedDir: string }> = []
  for (const cap of selected.filter((c) => c.via === 'knowledge')) {
    const packId = (cap.config?.pack as string | undefined) ?? cap.id
    const packDir = join(catalogRoot, 'knowledge', packId)
    const docsDir = join(packDir, 'docs')
    if (!existsSync(docsDir)) { skipped.push({ id: cap.id, packId, expectedDir: docsDir }); continue }
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
  return { installed, skipped }
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
 * 把编排者起草的 stateSchema 落成 preset 装备:验证 → 写 equipment/init.sql →
 * 给选中的 sqlite 服务器生成 env 指针 → 给 persona 一句"表已建好,禁止重设计"。
 * 任一条件不满足(没起草/没选 sqlite/没过门)equipment 为 null 且 **why 说清
 * 是哪条**(报错即界面:曾只写"详见 host 日志"——调用方 agent 根本读不到 host
 * 日志,理由必须随结果走)。装配照常——装备是加速器不是必需品。只针对 sqlite
 * (本地自有状态);postgres/mysql 是客户库,自动 DDL 是越权写操作,永不做。
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
}): { equipment: StateEquipment | null; why?: string } {
  const ddl = (opts.stateSchema ?? '').trim()
  if (ddl === '') return { equipment: null }
  const sqliteServers = [...new Set(
    opts.selected
      .filter((c) => c.via === 'mcp' && typeof c.config?.server === 'string' && (c.config.server as string).includes('sqlite'))
      .map((c) => c.config?.server as string),
  )]
  if (sqliteServers.length === 0) {
    return { equipment: null, why: '选中零件里没有 SQLite 件——装备只配 agent 自有状态库;要预建表就把 sqlite 零件加进 capabilityIds' }
  }
  const gateWhy = validateStateSchema(ddl)
  if (gateWhy !== null) {
    console.error(`[assembler] stateSchema 未过双次执行门,装备不发射:${gateWhy}`)
    return { equipment: null, why: `DDL 未过双次执行门:${gateWhy}` }
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
    equipment: {
      extraServerEnv,
      personaText: dbNote,
      files: ['equipment/init.sql'],
    },
  }
}

/** 目录 id 集合的短哈希:样本按"当时的选择集"分层用。 */
export function catalogIdsHash(catalog: Catalog): string {
  const ids = catalog.capabilities.map((c) => c.id).sort()
  return createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16)
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

// ── 增量验收(verify ledger)─────────────────────────────────────────────────
// 法医实测:一次重装配 24 分钟里 99% 是探针会话的模型解码,而重跑买回来的验收
// 证据和上次一模一样。verify ledger 让"没变的东西不再付费":验收结论跟着 preset
// 字节哈希入账,同字节 + 未过期 ⇒ 沿用 PASS(明写"沿用",绝不冒充新跑——账本
// 文化)。先例:promptfoo 的响应缓存(TTL + 强制绕过开关同款形态)。

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
 * 发射代号:发射产物的语义版本,随 BOM 入档(lock.emitter)。任何改变"同样
 * 输入会发射出什么"的改动(装备 env、模板槽位、行渲染……)都必须把它 +1——
 * 工件由哪一代发射语义产出,审计与重发决策都读它。(曾另有同名复用闸靠它
 * 判新鲜度;闸随 pipeline 形态删除,git 备查。)
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
 * 代际新旧。emit_preset 的同名占用裁决用它:同概念 → 原地重发同一 id;
 * -2/-3 兄弟目录只留给"真正不同的新概念"防撞名。教训:曾因只看名字,三个
 * 升级重装全被铸成 *-2 兄弟,roster 长满代际垃圾。
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

export async function federateMcpTools(catalog: Catalog): Promise<Catalog & { fedExcluded?: Array<{ server: string; why: string }> }> {
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
  // 过堂第七条:剔除只进 host console 时,search_catalog 零命中会被读成"真缺口"
  // ——把剔除名单随目录带出去,由检索面出声。
  const fedExcluded: Array<{ server: string; why: string }> = []
  for (const server of serverNames) {
    if (!commandResolvable(servers[server])) {
      console.error(`[assembler] federateMcpTools: server "${server}" 命令不可达(${String(servers[server].command ?? '')}),目录剔除其工具`)
      fedExcluded.push({ server, why: `命令不可达(${String(servers[server].command ?? '')})` })
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
          fedExcluded.push({ server, why: `拉起失败:${(error instanceof Error ? error.message : String(error)).slice(0, 120)}` })
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
  if (mcpEntries.length === 0) return fedExcluded.length > 0 ? { ...catalog, fedExcluded } : catalog
  return { capabilities: [...catalog.capabilities, ...mcpEntries], 'mcp-servers': servers, ...(fedExcluded.length > 0 ? { fedExcluded } : {}) }
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
  /** 选型报出的缺口(有工单在 gaps/ 与之对应);重装闸靠它判断"是否还欠着件"。 */
  missing?: string[]
  /** 装配时目录的 id 集指纹;与 missing 联用:缺口在案 + 目录已生长 ⇒ 重新选型。 */
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
    '零件入库后重新发射本 preset(同名重发即原地换代),再独立验收:',
    '',
    `1. search_catalog 确认新零件已可检得;`,
    `2. emit_preset {"name": "${opts.presetId}", ...} —— capabilityIds 带上新零件,其余入参照旧;`,
    `3. verify_preset {"presetId": "${opts.presetId}"} —— 新零件上桌后必须重过独立考官。`,
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

export const name = 'dsh-assembler'
export const inject = ['llm', 'tools']

// NOTE: no `export default` — the cordis loader's unwrapExports reads
// `exports.default ?? exports`, so a default export would hide the named
// `inject`/`name` exports from it (same trap as dsh-cs-tools).

export function apply(ctx: Context, config: Config = {}): void {
  // ── 工具面注册(唯一形态 search;off = 完全停用)──────────────────────────
  // 形态曾有六种(pipeline/orchestrated/draft/dialogue/search/off),四个实验臂
  // 已判负并按宪法第八条删除(git 备查,战役档案在 docs/ 与 bench/results/)。
  // registration effect 标签(assembler.tool.*)被 tests-orchestrated 的
  // CONTRACT_ACTIONS 闸逐条断言——契约点名的动作漏注册工具,测试当场红。
  const mode = assemblerMode()
  if (mode !== 'off') {
    // 检索是选型的默认入口:机械 BM25,零 LLM,结果行带价签。
    ctx.effect(() => ctx.tools.register(searchCatalogToolDefinition(ctx, config)), 'assembler.tool.search_catalog()')
    // match 是"专家精排"备用阀:平时零调用,检索拿不准时升级。
    ctx.effect(() => ctx.tools.register(matchCatalogToolDefinition(ctx, config)), 'assembler.tool.match_catalog()')
    // 哑发射 + 独立考官(preset 车道)。
    ctx.effect(() => ctx.tools.register(emitPresetToolDefinition(ctx, config)), 'assembler.tool.emit_preset()')
    ctx.effect(() => ctx.tools.register(verifyPresetToolDefinition(ctx, config)), 'assembler.tool.verify_preset()')
    // 共享数据考官:多 agent 班子(同一 sharedDb)的 FDE 闭环。
    ctx.effect(() => ctx.tools.register(verifySharedDataToolDefinition(ctx, config)), 'assembler.tool.verify_shared_data()')
    // app 车道(scaffold 唯一底盘):哑实例化 + app 独立考官 + 发布(与 preset 车道同构)。
    ctx.effect(() => ctx.tools.register(emitAppToolDefinition(ctx, config)), 'assembler.tool.emit_app()')
    ctx.effect(() => ctx.tools.register(verifyAppToolDefinition(ctx, config)), 'assembler.tool.verify_app()')
    ctx.effect(() => ctx.tools.register(deployAppToolDefinition(ctx, config)), 'assembler.tool.deploy_app()')
    // 触发面考官:无人值守形态的第四格——打一发,验后果。
    ctx.effect(() => ctx.tools.register(verifyTriggerToolDefinition(ctx, config)), 'assembler.tool.verify_trigger()')
    // 装配器资源只经工具面读写(目录/preset/scaffold/知识包都在会话沙箱之外)。
    ctx.effect(() => ctx.tools.register(addKnowledgeToolDefinition(ctx, config)), 'assembler.tool.add_knowledge()')
    ctx.effect(() => ctx.tools.register(readPresetToolDefinition(ctx, config)), 'assembler.tool.read_preset()')
    ctx.effect(() => ctx.tools.register(submitPartToolDefinition(ctx, config)), 'assembler.tool.submit_part()')
  }

  // 前端路由:/assembler/ui/<id> 同源伺服各 preset 的 frontend/ 静态文件。
  // webServer 走可选注入(dsh-ios 同款):headless profile 没有它,工具照常,
  // 只是结果里给本地路径而非 URL。装配器只发静态字节,不参与会话执行——
  // 与 roster 伺服 preset 同性质,运行时判据不越界。off 模式也伺服:既有
  // 页面是静态字节,不属于装配面。
  try {
    const injectFn = (ctx as unknown as { inject?: (deps: string[], cb: (c2: Context) => void) => void }).inject
    injectFn?.call(ctx, ['webServer'], (c2: Context) => {
      const ws = (c2 as unknown as { webServer: { register: (route: { kind: string; path: string; handler: unknown }) => () => void } }).webServer
      const presetRoot = config.presetRoot ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.agent-presets')
      c2.effect(() => ws.register({ kind: 'prefix', path: FRONTEND_ROUTE, handler: frontendRouteHandler(presetRoot) }), 'assembler.frontend.route')
    })
  } catch (error: unknown) {
    console.error(`[assembler] 前端路由注册失败(headless?):${error instanceof Error ? error.message : String(error)}`)
  }
}
