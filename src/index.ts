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
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { BlockAssembler, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import yaml from 'js-yaml'
import { assembleToolDefinition } from './assemble-tool.js'
import { AUX_CALL_TIMEOUT_MS, deriveProbePlan, runProbe, runScenario, type ProbePlan, type ProbeResult } from './verify.js'
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
  /** Catalog path (default: this package's capabilities.yml). */
  catalogPath?: string
  /** Preset template path (default: this package's presets/agent-template.yml). */
  templatePath?: string
  /** Provider route for the decomposition model call (default: host default). */
  provider?: string
  /** Model id for the decomposition call (default: host default). */
  model?: string
  /** Where assembled presets are written (default: $DSH_HOME/.agent-presets). */
  presetRoot?: string
}

export interface CapabilityEntry {
  id: string
  via: 'package' | 'harness' | 'mcp' | 'knowledge'
  tool?: string
  description: string
  tags: string[]
  config?: Record<string, unknown> & {
    enabled?: boolean
    persona?: string
    baselineTools?: string[]
    presetRows?: Array<{ id: string; name: string; config?: Record<string, unknown> }>
  }
}

interface Catalog {
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
): Promise<AssembleRequest> {
  const usable = catalog.capabilities.filter((c) => c.config?.enabled !== false)
  const ids = usable.map((c) => c.id)
  const tagsIndex = usable.map((c) => `${c.id}: ${c.tags.join(', ')} — ${c.description}`).join('\n')
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
    '- Include capabilities that are implied (a support agent needs a persona).',
    // A workstation, not a script: work that outlives a turn (bookkeeping,
    // filing, tracking, archiving) needs somewhere to PUT state. Selecting the
    // storage part is a capability decision; how and when to write is the
    // model\'s. See DESIGN.md — give the desk, never the choreography.
    '- When the requirement implies work that OUTLIVES one turn (bookkeeping, filing, tracking, archiving, "later I can query it"), also select a state-keeping capability (a file-writing or database part) — an agent with no place to put state cannot honor such a requirement.',
    '- When you select a state-keeping capability, the persona MUST carry a durability constraint, e.g. "跨轮事实必须写入账本/文件,不依赖记忆" — a constraint judgeable at any point, NEVER a numbered procedure ("第一步…第二步…" is forbidden in personas).',
    '- When NO catalog persona matches the requirement, write a "persona" string: a concise assistant persona for the assembled agent (role, tone, answer in the user\'s language, tool-use discipline). Omit it when a catalog persona IS selected — the catalog text wins.',
    '- Write a "name" for the assembled preset: a short kebab-case slug naming what the agent IS (2-5 words, lowercase letters, digits and hyphens only, e.g. "customer-service-bot", "web-research-assistant"). It becomes the preset id users pick in the roster.',
    '- For every item in "missing", add one matching entry to "missingEntries": {id, via, description, tags, tool?, mount?} — id is kebab-case; via is "package" | "harness" | "mcp"; when you know a harness plugin package that provides the capability, set mount.name to it (e.g. "@deepseek-ai/dsh-tool-fs-search"), else omit mount; set tool only for via: "package". Omit "missingEntries" entirely when nothing is missing.',
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
    messages: [createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    })],
    // Deadline, not decoration: this call runs inside the user's assemble
    // turn, and an upstream that neither answers nor closes would otherwise
    // hang that turn forever (see AUX_CALL_TIMEOUT_MS in verify.ts — observed
    // live on the probe-deriver twin of this call).
    signal: AbortSignal.timeout(AUX_CALL_TIMEOUT_MS),
  }
  const stream = ctx.llm.stream(request)
  let text = ''
  for await (const chunk of stream) {
    assembler.push(chunk)
  }
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
  const parsed = JSON.parse(text) as AssembleRequest
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

export function emitPreset(req: AssembleRequest, catalog: Catalog, template: string, presetId: string, personaSuffix = ''): string {
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
      const lines = Object.entries(cfg)
        .filter(([k]) => k !== 'hostMounted' && k !== 'requiredSecrets')
        .map(([k, v]) => [k, k === 'env' ? stripSecretEnv(v) : v] as [string, unknown])
        .map(([k, v]) => `\n    ${k}: ${renderYamlValue(v)}`).join('')
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
  return rendered.replaceAll(SUFFIX_SLOT, presetNameSuffix(presetId, rendered))
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

/** Raw tool descriptor as cached — the minimal input `toolsToEntries` needs. */
interface CachedTool { name: string; description?: string }

interface FedCacheEntry { key: string; fetchedAt: number; tools: CachedTool[] }
interface FedCache { version: number; servers: Record<string, FedCacheEntry> }

const FED_CACHE_VERSION = 1
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
      config: { server },
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
  const misses: string[] = []
  for (const server of serverNames) {
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
          const transport = cfg.transport === 'streamable-http'
            ? new StreamableHTTPClientTransport(new URL(cfg.url as string))
            : new StdioClientTransport({
                command: cfg.command as string,
                args: cfg.args as string[],
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
    assembledAt: new Date().toISOString(),
    requirement: opts.requirement.replace(/\s+/g, ' ').trim().slice(0, 140),
    parts,
  }
  if (opts.personaFindings !== undefined && opts.personaFindings.length > 0) {
    doc.personaLint = opts.personaFindings.map((f) => `${f.kind}: ${f.detail}`)
  }
  // Parameters are part of the build record: the same preset id emitted with
  // different parameters is a different artifact, and the lock says which.
  if (opts.params !== undefined && Object.keys(opts.params).length > 0) doc.params = opts.params
  // Credentials are NAMED here, never valued: the lock tells an operator what
  // to configure and where it is used, and stays safe to commit.
  // Knowledge is provenance too: which teaching material, from where, at what version.
  if (opts.knowledge !== undefined && opts.knowledge.length > 0) doc.knowledge = opts.knowledge
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
  options: { name?: string; params?: Record<string, string> } = {},
): Promise<{
  id: string
  capabilityIds: string[]
  missing: string[]
  presetPath: string
  drafts: string[]
  verification: ProbeResult
  personaLint: PersonaLintFinding[]
  params: Record<string, string>
  paramsRejected: ParamRejection[]
  requiredSecrets: Array<RequiredSecret & { server: string; configured: boolean }>
  knowledge: Array<{ id: string; docs: number; source?: string; version?: string }>
}> {
  const catalogPath = config.catalogPath ?? join(REPO, 'capabilities.yml')
  const templatePath = config.templatePath ?? join(REPO, 'presets', 'agent-template.yml')
  const staticCatalog = loadCatalog(catalogPath)
  const catalog = await federateMcpTools(staticCatalog)
  const req = await llmMapRequirement(ctx, requirement, catalog, { provider: config.provider, model: config.model }, config)
  // Parameter screening happens before emission so a refused key can never
  // reach the file; rejections are reported, not silently dropped.
  const screened = screenParams(options.params ?? {})
  req.params = screened.accepted
  const template = readFileSync(templatePath, 'utf8')
  const presetRoot = config.presetRoot ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.agent-presets')
  const id = resolvePresetId(options.name, req.name, presetRoot)
  const dir = join(presetRoot, id)
  mkdirSync(dir, { recursive: true })
  // Knowledge packs travel WITH the preset (copied into kb/), so the handover is
  // one self-contained directory rather than a pointer back to this machine.
  // Installed BEFORE emission because the persona has to name where they landed
  // — an agent that has to go looking for its own documents pays for the search
  // every single session.
  const knowledgeInstalled = (() => {
    try {
      const byIdK = new Map(catalog.capabilities.map((c) => [c.id, c]))
      const selK = req.capabilityIds.map((cid) => byIdK.get(cid)).filter((c): c is CapabilityEntry => c !== undefined)
      return installKnowledgePacks(selK, dir, dirname(catalogPath))
    } catch (error: unknown) {
      console.error(`[assembler] knowledge install failed: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  })()
  const preset = emitPreset(req, catalog, template, id, knowledgeLocatorText(knowledgeInstalled))
  writePresetFile(join(dir, 'agent.cordis.yml'), preset)
  // Display metadata beside the composition: the roster picker shows the name
  // and a one-line description (harness dsh-agent-presets reads preset.yml).
  const description = requirement.replace(/\s+/g, ' ').trim().slice(0, 140)
  writeFileSync(join(dir, 'preset.yml'), yaml.dump({ name: id, description }, { lineWidth: -1 }))
  const drafts = (req.missingEntries ?? []).map(renderMissingDraft)
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
  if (config.verify !== false) {
    const port = (ctx.get?.('webServer') as { port?: number } | undefined)?.port
    // Only a REQUIRED, unconfigured credential blocks verification. An
    // optional one leaves an anonymous path the probe can still exercise.
    const missingSecrets = requiredSecrets.filter((sec) => !sec.configured && sec.optional !== true)
    if (port === undefined) {
      verification = { status: 'SKIPPED', reason: 'webServer port unavailable (headless run?)' }
    } else if (missingSecrets.length > 0) {
      // The interface is in place and the preset is mountable; what is absent
      // is the operator's key. Calling that a FAILED assembly would be a lie
      // about whose problem it is (DESIGN.md: probes prove the assembly, not
      // the deployment).
      verification = {
        status: 'SKIPPED',
        reason: `待配置凭证:${missingSecrets.map((sec) => sec.env).join(', ')}——装配正确但无法实调外部服务,配好后重跑装配即可验证`,
      }
    } else {
      const byId = new Map(catalog.capabilities.map((c) => [c.id, c]))
      const selected = req.capabilityIds.map((cid) => byId.get(cid)).filter((c): c is CapabilityEntry => c !== undefined)
      const runPlan = async (plan: ProbePlan): Promise<ProbeResult> => (
        plan.kind === 'scenario'
          ? await runScenario(port, id, plan.scenario, config.verifyTimeoutMs)
          : await runProbe(port, id, plan.probe, config.verifyTimeoutMs)
      )
      try {
        const plan = await deriveProbePlan(ctx, requirement, selected, { provider: config.provider, model: config.model })
        verification = await runPlan(plan)
        if (verification.status === 'FAIL') {
          // One re-selection with failure feedback, re-emit under the same id.
          // Its own catch: a transient failure INSIDE the retry (a flaky model
          // call, a wire hiccup) must not erase the first probe's verdict —
          // the FAIL plus its evidence is the actionable result.
          try {
            const retryReq = await llmMapRequirement(
              ctx,
              `${requirement}\n\n(上一次装配选了 [${req.capabilityIds.join(', ')}],冒烟探针未通过:${verification.reason ?? '回复未包含验收标记'}。请重新选型,优先替换可能不匹配的零件。)`,
              catalog,
              { provider: config.provider, model: config.model },
              config,
            )
            const retryPreset = emitPreset(retryReq, catalog, template, id, knowledgeLocatorText(knowledgeInstalled))
            writePresetFile(join(dir, 'agent.cordis.yml'), retryPreset)
            const retryPlan = await deriveProbePlan(ctx, requirement, retryReq.capabilityIds.map((cid) => byId.get(cid)).filter((c): c is CapabilityEntry => c !== undefined), { provider: config.provider, model: config.model })
            verification = await runPlan(retryPlan)
            if (verification.status === 'PASS') {
              req.capabilityIds = retryReq.capabilityIds
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

  // Parts BOM — written LAST so it reflects the final generation: after a
  // verify-retry re-selection, req.capabilityIds and the preset bytes on
  // disk are both the retry's, and the lock reads them from there.
  try {
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
    const byIdAll = new Map(catalog.capabilities.map((c) => [c.id, c]))
    const finalSelected = req.capabilityIds
      .map((cid) => byIdAll.get(cid))
      .filter((c): c is CapabilityEntry => c !== undefined)
    // Persona lint on the FINAL generation's actual text (same resolution
    // chain emitPreset used) — advisory findings, never a block.
    const mcpServersAll = catalog['mcp-servers'] ?? {}
    const hostMounted = Object.keys(mcpServersAll).filter((sv) => mcpServersAll[sv].hostMounted === true)
    personaFindings = lintPersona(resolvePersonaText(req.persona, finalSelected), finalSelected, hostMounted)
    writeFileSync(join(dir, 'parts.lock.yml'), renderPartsLock({
      presetId: id,
      requirement,
      selected: finalSelected,
      presetText: readFileSync(join(dir, 'agent.cordis.yml'), 'utf8'),
      index,
      personaFindings,
      params: screened.accepted,
      requiredSecrets,
      knowledge: knowledgeInstalled,
    }))
  } catch (error: unknown) {
    // The lock is provenance metadata: failing to write it must not fail
    // the assembly the user asked for.
    console.error(`[assembler] parts.lock.yml write failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  return { id, capabilityIds: req.capabilityIds, missing: req.missing, presetPath: join(dir, 'agent.cordis.yml'), drafts, verification, personaLint: personaFindings, params: screened.accepted, paramsRejected: screened.rejected, requiredSecrets, knowledge: knowledgeInstalled }
}

/** Shared human-facing result text for the command and the tool. */
export function assembleResultText(result: Awaited<ReturnType<typeof assemble>>): string {
  const missing = result.missing.length > 0
    ? `\nmissing capabilities (not in catalog): ${result.missing.join(', ')}`
    : ''
  const drafts = result.drafts.length > 0
    ? `\n\n补件草案 (append to the "capabilities:" section of capabilities.yml):\n${result.drafts.join('\n')}`
    : ''
  const v = result.verification
  // Two probe shapes render differently: a single probe reports its task and
  // marks; a scenario reports the turn ladder, which is the evidence that
  // state survived across turns.
  let verifyLine: string
  if (v.kind === 'scenario' && v.scenario !== undefined) {
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
  return `assembled preset "${result.id}" with: ${result.capabilityIds.join(', ')}${missing}${drafts}${verifyLine}${kbLine}${secretLines}${paramLine}${rejectLine}${lint}\n`
    + `preset file: ${result.presetPath}\n`
    + `start a new session and select preset ${result.id} to use it.`
}

export const name = 'dsh-assembler'
export const inject = ['commands', 'llm', 'tools']

// NOTE: no `export default` — the cordis loader's unwrapExports reads
// `exports.default ?? exports`, so a default export would hide the named
// `inject`/`name` exports from it (same trap as dsh-cs-tools).

export function apply(ctx: Context, config: Config = {}): void {
  // Agent-native path: the same capability as a tool, so the agent loop
  // renders the call (reasoning → tool card → result) in the conversation.
  // Registered on the host plane (like dsh-cs-tools), visible to every agent.
  ctx.effect(() => ctx.tools.register(assembleToolDefinition(ctx, config)), 'assembler.tool.assemble()')

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
          text: 'usage: /assemble <what you want the agent to do> [--name <kebab-case-preset-name>]',
        }
      }
      // Optional flags, any order after the requirement:
      //   --name <slug>        name the preset id directly
      //   --param k=v          non-secret deployment parameter (repeatable)
      // Parsed off the tail so the requirement itself keeps its own wording.
      const params: Record<string, string> = {}
      let rest = raw
      for (;;) {
        const paramMatch = rest.match(/\s--param(?:=|\s+)([A-Za-z][A-Za-z0-9_-]{0,39})=(\S+)\s*$/)
        if (paramMatch === null) break
        params[paramMatch[1]] = paramMatch[2]
        rest = rest.slice(0, paramMatch.index).trimEnd()
      }
      const nameMatch = rest.match(/^(.*?)\s+--name(?:=|\s+)([a-zA-Z0-9][a-zA-Z0-9-]{0,63})\s*$/)
      const requirement = (nameMatch ? nameMatch[1] : rest).trim()
      if (requirement === '') {
        return { kind: 'error', text: 'usage: /assemble <what you want the agent to do> [--name <kebab-case-preset-name>]' }
      }
      try {
        const result = await assemble(ctx, requirement, config, { name: nameMatch?.[2], params })
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
