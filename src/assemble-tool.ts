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
      + 'Pass the complete requirement as one string.',
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
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown): Promise<string> => {
      const a = args as { requirement?: unknown; name?: unknown } | null
      const requirement = typeof a?.requirement === 'string' ? a.requirement.trim() : ''
      if (requirement === '') {
        throw new Error('assemble needs {"requirement": "<what you want the agent to do>"}')
      }
      const name = typeof a?.name === 'string' ? a.name.trim() : ''
      const result = await assemble(ctx, requirement, config, { name: name === '' ? undefined : name })
      return assembleResultText(result)
    },
  })
}
