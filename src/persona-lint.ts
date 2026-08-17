/**
 * Persona lint — the last ungated artifact gets its gate.
 *
 * Parts pass smoke gates, assemblies pass probes, the catalog passes bench;
 * persona text had no check of its own. The lint enforces the constraint
 * charter mechanically:
 *  - constraints, not procedures (no step-numbered choreography — execution
 *    order belongs to the model);
 *  - the text must agree with the mounted tool surface (a persona telling
 *    the agent to use a tool that is not in the room is a live trap);
 *  - length bounds (too short = no discipline; too long = context bloat).
 *
 * Findings are advisory: they surface in the assemble result and the parts
 * lock, they do not block emission — the probe stays the hard gate.
 */
import type { CapabilityEntry } from './index.js'

export interface PersonaLintFinding {
  kind: 'procedure-steps' | 'unknown-tool' | 'too-short' | 'too-long'
  detail: string
}

/**
 * Final persona text for an emitted preset — the SAME resolution chain
 * emitPreset uses: hand-authored catalog persona beats matcher-generated
 * text beats the generic default.
 */
export function resolvePersonaText(reqPersona: string | undefined, selected: CapabilityEntry[]): string {
  const personaEntry = selected.find((c) => c.config?.persona !== undefined)
  return (personaEntry?.config?.persona as string | undefined)
    ?? (reqPersona !== undefined && reqPersona.trim() !== '' ? reqPersona : undefined)
    ?? 'You are a helpful assistant. Be concise and accurate.'
}

/** Step-numbered choreography patterns — conservative, to keep false positives out. */
const STEP_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /第\s*[一二三四五六七八九十\d]+\s*步/, label: '第 N 步' },
  { re: /步骤\s*[一二三四五六七八九十\d]/, label: '步骤 N' },
  { re: /\bstep\s*\d/i, label: 'Step N' },
]

/**
 * Lint one persona against the surface it will be mounted with.
 *
 * `selected` is the FINAL selection (after any verify-retry re-selection);
 * `hostMountedServers` names servers whose tools are globally visible on the
 * host plane — references to those are legitimate even when unselected.
 */
export function lintPersona(
  persona: string,
  selected: CapabilityEntry[],
  hostMountedServers: readonly string[] = [],
): PersonaLintFinding[] {
  const findings: PersonaLintFinding[] = []
  const text = persona.trim()

  if (text.length < 40) {
    findings.push({ kind: 'too-short', detail: `persona 仅 ${String(text.length)} 字符——身份/辖区/纪律至少写清一样` })
  } else if (text.length > 2500) {
    findings.push({ kind: 'too-long', detail: `persona ${String(text.length)} 字符——超过 2500,挤占每轮上下文` })
  }

  for (const { re, label } of STEP_PATTERNS) {
    if (re.test(text)) {
      findings.push({ kind: 'procedure-steps', detail: `含"${label}"步骤句式——persona 只放约束(必须/禁止),执行顺序归模型` })
      break
    }
  }
  // 首先…然后…最后 三连也是编舞信号;单独出现任一词是正常行文,不报。
  if (/首先/.test(text) && /然后/.test(text) && /最后/.test(text)) {
    findings.push({ kind: 'procedure-steps', detail: '含"首先…然后…最后"三连——疑似把流程写进了 persona' })
  }

  // 工具引用核对:persona 里点名的 mcp__server__tool 必须在挂载面里
  // (选中零件的工具 + host 平面全局可见的工具)。
  const mounted = new Set(selected.filter((c) => c.tool !== undefined).map((c) => c.tool!))
  const hostSet = new Set(hostMountedServers)
  for (const ref of new Set(text.match(/mcp__[a-z0-9-]+__[A-Za-z0-9_.-]+/g) ?? [])) {
    if (mounted.has(ref)) continue
    const server = ref.split('__')[1]
    if (hostSet.has(server)) continue
    findings.push({ kind: 'unknown-tool', detail: `persona 点名了未挂载的工具 ${ref}——要么补选零件,要么删引用` })
  }
  return findings
}
