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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { BlockAssembler, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import yaml from 'js-yaml'
import { assembleToolDefinition } from './assemble-tool.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export interface Config {
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

interface CapabilityEntry {
  id: string
  via: 'package' | 'harness' | 'mcp'
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
  via: 'package' | 'harness' | 'mcp'
  description: string
  tags: string[]
  /** Package tool name for `via: package` entries (e.g. `send_email`). */
  tool?: string
  /** Plugin package / tool-row name to mount, e.g. `@deepseek-ai/dsh-tool-fs-search`. */
  mount?: { name: string; config?: Record<string, unknown> }
}

interface AssembleRequest {
  capabilityIds: string[]
  missing: string[]
  rationale: string
  /** Generated persona text, used only when the catalog offers no persona. */
  persona?: string
  /** Draft capability entries for each missing item (see MissingDraft). */
  missingEntries?: MissingDraft[]
}

export function loadCatalog(path: string): Catalog {
  return yaml.load(readFileSync(path, 'utf8')) as Catalog
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
    '- Respond with JSON only: {"capabilityIds": [...], "missing": [...], "missingEntries": [...], "persona": "...", "rationale": "..."}',
    `- capabilityIds must ONLY use ids from this exact set: ${ids.join(', ')}`,
    '- If the requirement asks for something the catalog cannot provide, list it in "missing" (e.g. "phone support", "payment").',
    '- Include capabilities that are implied (a support agent needs a persona).',
    '- When NO catalog persona matches the requirement, write a "persona" string: a concise assistant persona for the assembled agent (role, tone, answer in the user\'s language, tool-use discipline). Omit it when a catalog persona IS selected — the catalog text wins.',
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
  const known = new Set(ids)
  const bogus = (parsed.capabilityIds ?? []).filter((id) => !known.has(id))
  if (bogus.length > 0) {
    throw new Error(`assemble: LLM returned unknown capability ids: ${bogus.join(', ')} — catalog changed?`)
  }
  return parsed
}

function renderYamlValue(value: unknown): string {
  return JSON.stringify(value)
}

export function emitPreset(req: AssembleRequest, catalog: Catalog, template: string): string {
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
  const persona = (personaEntry?.config?.persona as string | undefined)
    ?? (req.persona !== undefined && req.persona.trim() !== '' ? req.persona : undefined)
    ?? 'You are a helpful assistant. Be concise and accurate.'
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
  const extraRows = selected
    .flatMap((c) => c.config?.presetRows ?? [])
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
  const mcpServers = catalog['mcp-servers'] ?? {}
  const mcpRows = [...new Set(
    selected.filter((c) => c.via === 'mcp').map((c) => (c.config?.server as string | undefined) ?? ''),
  )].filter((server) => server !== '' && mcpServers[server] !== undefined && mcpServers[server].hostMounted !== true)
    .map((server) => {
      const cfg = mcpServers[server]
      const lines = Object.entries(cfg).filter(([k]) => k !== 'hostMounted')
        .map(([k, v]) => `\n    ${k}: ${renderYamlValue(v)}`).join('')
      return `- id: mcp-${server}\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: ${renderYamlValue(server)}${lines}`
    })
    .join('\n\n')
  const allRows = [extraRows, mcpRows].filter((s) => s !== '').join('\n\n')
  return template
    .replace('{{persona}}', JSON.stringify(persona))
    .replace('{{packageRows}}', packageRows)
    .replace('{{extraRows}}', allRows)
}

/** One-shot id: stable, short, collision-free enough for a session-local tool. */
function mintPresetId(): string {
  return `assembled-${Date.now().toString(36)}`
}

/** Ambient env with only string values (process.env entries can be undefined). */
function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  return env
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
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const known = new Set(catalog.capabilities.map((c) => c.id))
  const mcpEntries: CapabilityEntry[] = []
  for (const server of serverNames) {
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
      for (const tool of tools.tools) {
        const description = typeof tool.description === 'string' && tool.description !== ''
          ? tool.description
          : `MCP tool ${tool.name} from server ${server}`
        const id = `mcp-${server}-${tool.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`
        if (known.has(id)) continue
        const words = description.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4)
        const tags = [...new Set([server.toLowerCase(), ...words.slice(0, 8)])]
        mcpEntries.push({
          id,
          via: 'mcp',
          tool: `mcp__${server}__${tool.name}`,
          description,
          tags,
          config: { server },
        })
        known.add(id)
      }
      await client.close()
    } catch (error: unknown) {
      console.error(`[assembler] federateMcpTools: server "${server}" unreachable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (mcpEntries.length === 0) return catalog
  return { capabilities: [...catalog.capabilities, ...mcpEntries], 'mcp-servers': servers }
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
 */
export async function assemble(
  ctx: Context,
  requirement: string,
  config: Config,
): Promise<{
  id: string
  capabilityIds: string[]
  missing: string[]
  presetPath: string
  drafts: string[]
}> {
  const catalogPath = config.catalogPath ?? join(REPO, 'capabilities.yml')
  const templatePath = config.templatePath ?? join(REPO, 'presets', 'agent-template.yml')
  const staticCatalog = loadCatalog(catalogPath)
  const catalog = await federateMcpTools(staticCatalog)
  const req = await llmMapRequirement(ctx, requirement, catalog, { provider: config.provider, model: config.model }, config)
  const template = readFileSync(templatePath, 'utf8')
  const preset = emitPreset(req, catalog, template)
  const presetRoot = config.presetRoot ?? join(homedir(), '.dsh', '.agent-presets')
  const id = mintPresetId()
  const dir = join(presetRoot, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), preset)
  const drafts = (req.missingEntries ?? []).map(renderMissingDraft)
  return { id, capabilityIds: req.capabilityIds, missing: req.missing, presetPath: join(dir, 'agent.cordis.yml'), drafts }
}

/** Shared human-facing result text for the command and the tool. */
export function assembleResultText(result: Awaited<ReturnType<typeof assemble>>): string {
  const missing = result.missing.length > 0
    ? `\nmissing capabilities (not in catalog): ${result.missing.join(', ')}`
    : ''
  const drafts = result.drafts.length > 0
    ? `\n\n补件草案 (append to the "capabilities:" section of capabilities.yml):\n${result.drafts.join('\n')}`
    : ''
  return `assembled preset "${result.id}" with: ${result.capabilityIds.join(', ')}${missing}${drafts}\n`
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
    description: 'Assemble an agent from a natural-language requirement (vibe assembly). Usage: /assemble <requirement>',
    // input.hint is REQUIRED for the web client's slash pipeline to claim
    // the token and route "/assemble <args>" to command.execute. Without it,
    // an argued line falls through to the default chat sink (the LLM gets
    // "/assemble ..." as plain text) and only a bare /assemble executes —
    // which the handler then rejects as missing its requirement. Same
    // contract as the built-in feedback/goal/permission/plan commands.
    input: { hint: '<requirement>' },
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const requirement = invocation.rawInput.trim()
      if (requirement === '') {
        return { kind: 'error', text: 'usage: /assemble <what you want the agent to do>' }
      }
      try {
        const result = await assemble(ctx, requirement, config)
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
