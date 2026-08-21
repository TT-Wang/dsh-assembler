/**
 * assemble — the vibe-assembly capability as an AGENT TOOL.
 *
 * The `/assemble` command is the human shortcut; this tool is the agent-native
 * path. Registering the same capability as a `ctx.tools` entry makes it part
 * of the agent loop's tool surface: when the user says "帮我组装一个客服机器人",
 * the agent decides to call `assemble`, and the loop renders the call as a
 * tool card (arguments, running state, result) inside the conversation — the
 * thinking/decision is the agent's own reasoning, and the outcome is a durable
 * `tool/call` + `tool/result` pair in the session log, unlike a plugin-side
 * `ctx.llm.stream()` call which produces no trajectory at all.
 *
 * The tool is registered on the HOST plane (like dsh-cs-tools and host-mounted
 * MCP servers), so every agent sees it — assembly is a global capability:
 * any session can request a new agent.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { assemble, assembleResultText } from './index.js'
import type { Config } from './index.js'

export const ASSEMBLE_TOOL_NAME = 'assemble'

/** One registered `assemble` tool instance, bound to the plugin's ctx + config. */
export function assembleToolDefinition(ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: ASSEMBLE_TOOL_NAME,
    description:
      'Assemble a new agent from a natural-language requirement: match the capability catalog, '
      + 'write a composed agent preset under $DSH_HOME/.agent-presets/<id>/, and return the preset id. '
      + 'Call this when the user asks to BUILD/CREATE/ASSEMBLE an agent, bot, assistant, or preset '
      + '(e.g. "make me a customer-service bot that can look up orders and open tickets"). '
      + 'Pass the complete requirement as one string. '
      + 'AFTER it returns, relay the result faithfully to the user: preset id, frontend URL, the verification verdict, '
      + 'and any gap work-orders or credential notes — do not swallow them. '
      + 'On FAIL: the assembler already retried internally with failure feedback; do NOT re-call assemble, '
      + 'do NOT rewrite the requirement to force a pass, and NEVER edit/delete preset files, re-run probes yourself, '
      + 'or debug the assembler source — report to the user and wait for their decision. '
      + 'Follow a gap work-order only after the user agrees. If you stripped secret-looking params before calling, tell the user '
      + 'to configure them as host environment variables instead.',
    parameters: {
      requirement: {
        type: 'string',
        description:
          'The full natural-language requirement for the agent to build, '
          + 'e.g. "a customer-service bot that can look up orders, open tickets, and hand off to a human".',
      },
      name: {
        type: 'string',
        description:
          'Optional preset id for the new agent: a short kebab-case slug (lowercase letters, digits, hyphens), '
          + 'e.g. "web-research-assistant". Omit to let the assembler derive one from the requirement.',
      },
      params: {
        // Open object: keys are deployment-specific and unknown at author time;
        // the assembler screens them (secret-shaped keys refused) at emission.
        type: 'object',
        additionalProperties: true,
        description:
          'Optional NON-SECRET deployment parameters as a flat string map, e.g. {"timezone": "Asia/Shanghai", "language": "zh"}. '
          + 'They fill {{param:key}} slots in the preset and are recorded in the parts lock. '
          + 'Never pass credentials here — keys that look like secrets (password/token/api-key/…) are refused by design; '
          + 'secrets belong in the host env/settings.',
      },
      reverify: {
        type: 'boolean',
        description:
          'Optional. Re-assembling an unchanged preset normally CARRIES the last PASS from the verify ledger '
          + '(same bytes, within TTL) instead of re-probing. Pass true to force a fresh acceptance probe.',
      },
      fresh: {
        type: 'boolean',
        description:
          'Optional. When name+requirement+params match an existing preset, the assembler reuses its selection '
          + 'and emitted file as-is. Pass true to force a full re-selection and re-emit instead.',
      },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown, exec?: { agent?: unknown }): Promise<string> => {
      const a = args as { requirement?: unknown; name?: unknown; params?: unknown; reverify?: unknown; fresh?: unknown } | null
      const requirement = typeof a?.requirement === 'string' ? a.requirement.trim() : ''
      if (requirement === '') {
        throw new Error('assemble needs {"requirement": "<what you want the agent to do>"}')
      }
      const name = typeof a?.name === 'string' ? a.name.trim() : ''
      // Flat string map only: nested values would render as "[object Object]"
      // into the preset, so they are dropped here rather than at emission.
      const params: Record<string, string> = {}
      if (a?.params !== null && typeof a?.params === 'object') {
        for (const [k, v] of Object.entries(a.params as Record<string, unknown>)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params[k] = String(v)
        }
      }

      // ── Assembly progress, live ────────────────────────────────────────
      // A tool result is atomic on this harness (tool/call → tool/result,
      // nothing in between), so a long assemble is a silent spinner from the
      // user's seat. The jobs service is the harness's one live channel — the
      // same stream a background bash command narrates through — so the
      // assembly registers itself as a job and narrates its phases there. The
      // jobs panel shows them as they happen; the phases also ride the final
      // result as a timeline, so the trail survives for whoever reads the
      // transcript later. `ctx.get('jobs')` is optional on purpose: a profile
      // without the jobs plugin still assembles, just silently.
      const phases: string[] = []
      let pending: string[] = []
      let settle: ((outcome: { status: 'completed' | 'failed'; detail?: string }) => void) | undefined
      const jobs = ctx.get('jobs') as undefined | {
        start(spec: {
          kind: string
          label: string
          owner?: unknown
          run: () => {
            cancel: () => void
            done: Promise<{ status: 'completed' | 'failed'; detail?: string }>
            readOutput: () => string
          }
        }): unknown
      }
      try {
        jobs?.start({
          kind: 'assemble',
          label: `assemble ${name !== '' ? name : '(自动命名)'}`,
          ...(exec?.agent !== undefined ? { owner: exec.agent } : {}),
          run: () => ({
            // An assembly is not abortable mid-flight (the preset write is
            // atomic and probes have their own deadlines); kill just stops
            // the narration.
            cancel: () => { settle?.({ status: 'completed', detail: '进度跟踪被终止(装配仍在完成)' }); settle = undefined },
            done: new Promise((resolve) => { settle = resolve }),
            readOutput: () => {
              const out = pending.join('\n')
              pending = []
              return out === '' ? '' : `${out}\n`
            },
          }),
        })
      } catch { /* jobs registration is narration, never a build dependency */ }

      const onPhase = (line: string): void => { phases.push(line); pending.push(line) }
      try {
        const result = await assemble(ctx, requirement, config, {
          ...(name === '' ? {} : { name }),
          params,
          onPhase,
          ...(a?.reverify === true ? { reverify: true } : {}),
          ...(a?.fresh === true ? { fresh: true } : {}),
        })
        settle?.({ status: 'completed', detail: `自动验证:${result.verification.status}` })
        const timeline = phases.length > 0 ? `\n装配轨迹:${phases.join(';')}` : ''
        return assembleResultText(result) + timeline
      } catch (error) {
        settle?.({ status: 'failed', detail: String(error instanceof Error ? error.message : error).slice(0, 200) })
        throw error
      }
    },
  })
}
