/**
 * Assemble-then-verify: after a preset is emitted, derive a probe task from
 * the requirement, run it in a REAL session bound to the new preset, and
 * judge the reply. "Vibe assembly" promises find → assemble → verify; this
 * module is the verify leg.
 *
 * The probe run drives the host's own public wire contract (HTTP RPC +
 * events.mux WebSocket) rather than internal services: the wire is the
 * stable, versioned surface, and a probe that passes here passes exactly the
 * way a user's session would.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { BlockAssembler, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { createUserMessage } from "@deepseek-ai/dsh-llm/message";
import type { CapabilityEntry } from "./index.js";

/** A probe task plus its machine-checkable acceptance marks. */
export interface ProbeSpec {
  /** One-turn task the assembled agent should complete with its parts. */
  task: string;
  /**
   * Acceptance marks: ALL must appear (case-insensitive) in the agent's final
   * reply. The deriver is told to pick content-bearing marks (computed values,
   * verbatim echoes) rather than self-assertions like "done".
   */
  mustInclude: string[];
}

/**
 * One turn of a multi-turn scenario probe: a prompt plus the marks its OWN
 * reply must carry. A later turn's marks are how state continuity is tested
 * from the outside — "the invoice you filed in turn 1, what was its number?"
 * asserts persistence without inspecting the trajectory.
 */
export interface ScenarioTurn {
  prompt: string;
  mustInclude: string[];
}

/** A scenario probe: several turns in ONE session, judged turn by turn. */
export interface ScenarioSpec {
  /** What this scenario proves (one line, for the ledger). */
  goal: string;
  turns: ScenarioTurn[];
}

/** Per-turn outcome of a scenario run. */
export interface TurnResult {
  index: number;
  prompt: string;
  mustInclude: string[];
  pass: boolean;
  /** Truncated reply — the evidence this turn's verdict judged. */
  reply: string;
}

export interface ProbeResult {
  /**
   * PASS / FAIL are the probe's verdict on the assembled agent.
   *
   * The two non-verdicts are deliberately DIFFERENT statuses, because they mean
   * opposite things to whoever signs off the delivery:
   *
   * - SKIPPED — there was nothing to verify and that is by design: verification
   *   was turned off, or a required credential is unconfigured so the agent
   *   cannot reach its upstream yet. Expected, reportable, not a defect.
   * - ERRORED — the probe itself could not run: the session would not open, the
   *   preset would not mount. The agent is UNVERIFIED, which is a failure of
   *   the delivery even though the preset file exists.
   *
   * Folding the second into the first is how three unmounted agents once got
   * reported as `ok: true, failed: []`.
   */
  status: "PASS" | "FAIL" | "SKIPPED" | "ERRORED";
  /** Single-turn probe (kind: 'single'). */
  probe?: ProbeSpec;
  /** Scenario probe (kind: 'scenario'). */
  scenario?: ScenarioSpec;
  /** Which probe shape ran. */
  kind?: "single" | "scenario";
  /** Final assistant reply (truncated) — the evidence the verdict judged. */
  reply?: string;
  /** Per-turn results for a scenario run. */
  turns?: TurnResult[];
  /** Why the run degraded to SKIPPED, when it did. */
  reason?: string;
}

/**
 * Per-turn probe budget.
 *
 * 300s was too small for a heavy agent: the governance desk's first turn has to
 * batch-scan a dependency list, fetch a licence per hit and write the batch to
 * SQLite, and it was declared FAIL at 300s for running long rather than for
 * answering wrong — the worst kind of red, because it accuses the agent of a
 * defect the probe caused.
 *
 * Raising it costs nothing on the happy path (a turn that finishes in 60s still
 * finishes in 60s); it only lengthens the wait before a genuine failure is
 * called. A deployment that needs a different figure sets `verifyTimeoutMs` in
 * the assembler's plugin config.
 */
export const DEFAULT_TURN_BUDGET_MS = 600_000;

/** Most turns a derived scenario may have (the deriver is told "2-4 turns"). */
export const MAX_SCENARIO_TURNS = 4;

/**
 * How long a CALLER must be willing to wait for one `assemble` call, worst case.
 *
 * Exported so no outer layer has to guess. Guessing has already cost three
 * false verdicts in one afternoon: `solution apply` waited 12 minutes and
 * declared a still-running agent UNKNOWN, a one-off driver waited 9 and called
 * it TIMEOUT, and the probe's own per-turn budget accused a working agent of
 * failing. Every one of them was an outer wait shorter than the inner worst
 * case. Deriving the figure means raising the turn budget moves all of them.
 *
 * The margin covers what surrounds the turns themselves: the matcher call, part
 * federation, preset emission, probe derivation, and the session handshake.
 */
export const ASSEMBLE_WORST_CASE_MS = DEFAULT_TURN_BUDGET_MS * MAX_SCENARIO_TURNS + 10 * 60_000;

/** Pure mark check: every mark present, case-insensitive. Unit-tested. */
export function marksPresent(marks: readonly string[], reply: string): boolean {
  const hay = reply.toLowerCase();
  return marks.length > 0 && marks.every((m) => hay.includes(m.toLowerCase()));
}

/** Pure verdict for a single-turn probe. */
export function evaluateProbe(spec: ProbeSpec, reply: string): boolean {
  return marksPresent(spec.mustInclude, reply);
}

/**
 * Pure verdict for a scenario: EVERY turn must pass.
 *
 * All-or-nothing rather than a score, deliberately: a scenario is a contract
 * ("after three turns the books still add up"), and a partially honored
 * contract is a broken one. Scoring turns would also drift toward grading the
 * trajectory, which the charter forbids.
 */
export function evaluateScenario(turns: readonly TurnResult[], expected: number): boolean {
  return turns.length === expected && expected > 0 && turns.every((t) => t.pass);
}

/** Shared mark-design rules — the same discipline governs single and scenario probes. */
const MARK_RULES = [
  "- mustInclude: 1-3 content-bearing strings that will appear in the reply IFF the task truly succeeded (a computed value, a verbatim token from the task input). Never accept generic words like \"done\" or \"success\".",
  "- mustInclude values MUST be derivable from data embedded in the task text itself. NEVER use remembered world facts (a domain's IP, a live exchange rate, today's date) — live data changes and remembered values go stale.",
  "- Avoid over-precise numeric marks: a mark like \"111.195\" fails when the tool legitimately prints 111.1949. Prefer a verbatim echo token, an integer, or the leading digits of a number (e.g. \"111.1\").",
  "- Budget: the probe agent has ~10 minutes per turn, and a turn that overruns is scored FAIL. Size EVERY turn to fit, the first one included — if a turn needs many upstream calls (one per item in a list), keep the list short: 3-5 items proves the capability as well as 30 does. Avoid tasks whose replies embed large payloads (full base64 images) — ask for byte counts or short prefixes instead.",
];

/** One fast-model JSON call with the deriver's provider/model discipline. */
/**
 * Deadline for one auxiliary model call in the assemble path (selection,
 * probe derivation). These calls run INSIDE the user's assemble turn: without
 * a signal, an upstream that neither answers nor closes (observed live: four
 * proxied sockets ESTABLISHED, session log frozen for 6 minutes) hangs the
 * whole turn forever — the user sees a spinner and nothing else. Generous on
 * purpose: a derivation is seconds on a healthy route, so two minutes only
 * ever fires on a broken one, and the abort feeds the existing failure paths
 * (probe → 未能验证, selection → loud tool error) instead of a silent hang.
 */
export const AUX_CALL_TIMEOUT_MS = 120_000;

async function callDeriver(
  ctx: Context,
  prompt: string,
  llm: { provider?: string; model?: string },
): Promise<Record<string, unknown>> {
  const assembler = new BlockAssembler();
  // Same fast-model + provider-resolution discipline as llmMapRequirement:
  // provider follows host selection, model pins flash unless config overrides.
  const selection = (ctx.get("agentDefaultModel") as { currentSelection?: () => { provider?: string } | undefined } | undefined)?.currentSelection?.();
  const options: GenerateOptions = {
    provider: llm.provider ?? selection?.provider ?? "deepseek-official",
    model: llm.model ?? "deepseek-v4-flash",
    messages: [createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "user" } })],
    signal: AbortSignal.timeout(AUX_CALL_TIMEOUT_MS),
  };
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
  const finish = assembler.finish;
  if (finish.kind === "error" || finish.kind === "aborted") {
    throw new Error(`probe deriver: model call ${finish.kind}: ${finish.failure.message}`);
  }
  let text = "";
  for (const block of assembler.message().content) {
    if (block.type === "text") text += block.text;
  }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`probe deriver returned no JSON: ${text.slice(0, 120)}`);
  return JSON.parse(m[0]) as Record<string, unknown>;
}

/** Ask the fast model for a probe task tailored to the selected parts. */
export async function deriveProbe(
  ctx: Context,
  requirement: string,
  selected: CapabilityEntry[],
  llm: { provider?: string; model?: string },
): Promise<ProbeSpec> {
  const tools = selected.map((c) => `- ${c.tool ?? c.id}: ${c.description.slice(0, 120)}`).join("\n");
  const prompt = [
    "You design a ONE-TURN smoke probe for a freshly assembled agent.",
    `The agent was assembled for this requirement: ${requirement}`,
    "Its tools:",
    tools,
    "",
    "Rules:",
    '- Respond with JSON only: {"task": "...", "mustInclude": ["...", "..."]}',
    "- task: a single instruction the agent can finish in one turn (< 2 minutes) using ONLY the tools above; write it in the requirement's language.",
    "- Prefer self-contained work (compute, transform, generate). Use the network only when the agent's parts are network tools.",
    ...MARK_RULES,
  ].join("\n");
  const parsed = await callDeriver(ctx, prompt, llm) as unknown as ProbeSpec;
  if (typeof parsed.task !== "string" || !Array.isArray(parsed.mustInclude)) {
    throw new Error("probe deriver JSON missing task/mustInclude");
  }
  return { task: parsed.task, mustInclude: parsed.mustInclude.map(String).slice(0, 3) };
}

/** What the deriver decided to run: one turn, or a multi-turn scenario. */
export type ProbePlan =
  | { kind: "single"; probe: ProbeSpec }
  | { kind: "scenario"; scenario: ScenarioSpec };

/**
 * Ask the fast model for a probe PLAN: it decides whether one turn suffices
 * or the requirement deserves a multi-turn scenario.
 *
 * The choice is the model's, not a keyword heuristic on our side — the same
 * task-agnostic discipline the matcher follows. A scenario is only worth
 * running when the agent can actually carry state across turns (its parts
 * write files or rows); a pure calculator has nothing to remember, and a
 * multi-turn probe of one would test the model's short-term memory rather
 * than the assembly.
 *
 * Falls back to the single-turn deriver when the model returns a malformed
 * or empty scenario: verification degrading to a weaker probe beats failing
 * an assembly that is probably fine.
 */
export async function deriveProbePlan(
  ctx: Context,
  requirement: string,
  selected: CapabilityEntry[],
  llm: { provider?: string; model?: string },
): Promise<ProbePlan> {
  const tools = selected.map((c) => `- ${c.tool ?? c.id}: ${c.description.slice(0, 120)}`).join("\n");
  const prompt = [
    "You design an acceptance probe for a freshly assembled agent.",
    `The agent was assembled for this requirement: ${requirement}`,
    "Its tools:",
    tools,
    "",
    "First DECIDE the probe shape:",
    '- "single" — one turn is enough to prove the agent works (pure compute/transform/generate agents).',
    '- "scenario" — 2-4 turns in ONE session, when the requirement implies work that OUTLIVES a turn (filing, bookkeeping, tracking, archiving) AND the tools can actually persist it (files, databases). A later turn then asks about what an earlier turn produced, which proves continuity.',
    "",
    "Then respond with JSON only, in ONE of these two shapes:",
    '{"kind": "single", "task": "...", "mustInclude": ["..."]}',
    '{"kind": "scenario", "goal": "one line: what this proves", "turns": [{"prompt": "...", "mustInclude": ["..."]}, ...]}',
    "",
    "Rules:",
    "- Write prompts in the requirement's language.",
    "- Each turn is one instruction the agent can finish in one turn using ONLY the tools above.",
    "- SCENARIO SHAPE: turn 1 creates state with a distinctive token you invent (e.g. INV-7781); a LATER turn must ask the agent to retrieve or use that state WITHOUT restating it — its marks are how state continuity is judged. Never make a later turn merely repeat turn 1's work.",
    "- Judging is black-box: only each turn's reply text is inspected. Never require the agent to follow specific steps or announce its plan.",
    ...MARK_RULES,
  ].join("\n");

  let parsed: Record<string, unknown>;
  try {
    parsed = await callDeriver(ctx, prompt, llm);
  } catch (error) {
    // A malformed plan is not a reason to skip verification entirely.
    return { kind: "single", probe: await deriveProbe(ctx, requirement, selected, llm) };
  }

  if (parsed.kind === "scenario" && Array.isArray(parsed.turns)) {
    const turns: ScenarioTurn[] = (parsed.turns as Array<Record<string, unknown>>)
      .filter((t) => typeof t.prompt === "string" && Array.isArray(t.mustInclude) && t.mustInclude.length > 0)
      .slice(0, 4)
      .map((t) => ({ prompt: String(t.prompt), mustInclude: (t.mustInclude as unknown[]).map(String).slice(0, 3) }));
    // A one-turn "scenario" is a single probe wearing a costume; two turns is
    // the minimum that can prove anything about continuity.
    if (turns.length >= 2) {
      return { kind: "scenario", scenario: { goal: typeof parsed.goal === "string" ? parsed.goal : "多轮场景验收", turns } };
    }
  }
  if (typeof parsed.task === "string" && Array.isArray(parsed.mustInclude) && parsed.mustInclude.length > 0) {
    return { kind: "single", probe: { task: parsed.task, mustInclude: (parsed.mustInclude as unknown[]).map(String).slice(0, 3) } };
  }
  return { kind: "single", probe: await deriveProbe(ctx, requirement, selected, llm) };
}

/**
 * Text an assistant/message frame delivered to the user.
 *
 * Wire shape: {type:'assistant/message', data:{turn, step, message:{role, content:[blocks]}}}.
 * TEXT blocks only — reasoning text is the model talking to itself, and a
 * mark that appears there but not in the reply did not reach the user.
 */
function frameText(e: any): string {
  const c = e.data?.message?.content ?? e.data?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
  }
  return "";
}

/** A live probe session: one preset, one workdir, many turns. */
interface ProbeSession {
  sessionId: string;
  frames: any[];
  rpc: (method: string, payload: unknown) => Promise<any>;
  close: () => void;
}

/** Open a session bound to the preset and subscribe to its event stream. */
async function openProbeSession(port: number, presetId: string): Promise<ProbeSession> {
  const base = `http://127.0.0.1:${port}`;
  const rpc = async (method: string, payload: unknown): Promise<any> => {
    const res = await fetch(`${base}/api/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: `probe-${Date.now()}-${Math.round(performance.now())}`, method, payload }),
    });
    const j = (await res.json()) as any;
    if (!j.result?.ok) throw new Error(`${method}: ${JSON.stringify(j.result?.error ?? j).slice(0, 800)}`);
    return j.result.value;
  };

  const workdir = mkdtempSync(join(tmpdir(), "assembler-probe-"));
  const { sessionId } = await rpc("session.create", { cwd: workdir, agentPreset: presetId });

  const frames: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events.mux`);
  ws.onmessage = (m: MessageEvent) => {
    try {
      const f = JSON.parse(String(m.data));
      if (f.payload?.type === "session/event" && f.payload.sessionId === sessionId) frames.push(f.payload.event);
    } catch { /* non-JSON frame */ }
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("events.mux websocket failed"));
  });
  return { sessionId, frames, rpc, close: () => { ws.close(); } };
}

/**
 * Send one prompt and return the reply text of THAT turn.
 *
 * Turn boundaries come from counting `turn/end` events rather than from the
 * frame index: a turn's frames arrive after the prompt is accepted, and the
 * count is what distinguishes "this turn finished" from "an earlier one did"
 * when several turns share the session.
 * @returns the turn's reply, or undefined when it never finished in time.
 */
async function sendTurn(session: ProbeSession, prompt: string, timeoutMs: number): Promise<string | undefined> {
  const endsBefore = session.frames.filter((e) => e.type === "turn/end").length;
  const startIndex = session.frames.length;
  await session.rpc("session.prompt", {
    sessionId: session.sessionId,
    mode: "queue",
    content: [{ type: "text", text: prompt }],
  });
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (session.frames.filter((e) => e.type === "turn/end").length > endsBefore) {
      return session.frames
        .slice(startIndex)
        .filter((e) => e.type === "assistant/message")
        .map(frameText)
        .join("\n");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return undefined;
}

/** Run a single-turn probe in a real session bound to the preset. */
export async function runProbe(
  port: number,
  presetId: string,
  probe: ProbeSpec,
  timeoutMs = DEFAULT_TURN_BUDGET_MS,
): Promise<ProbeResult> {
  const session = await openProbeSession(port, presetId);
  try {
    const reply = await sendTurn(session, probe.task, timeoutMs);
    if (reply === undefined) {
      return { status: "FAIL", kind: "single", probe, reason: `probe turn did not finish within ${Math.round(timeoutMs / 1000)}s` };
    }
    const pass = evaluateProbe(probe, reply);
    return { status: pass ? "PASS" : "FAIL", kind: "single", probe, reply: reply.slice(0, 400) };
  } finally {
    session.close();
  }
}

/**
 * Run a multi-turn scenario in ONE session — the same session is what makes
 * continuity testable: a later turn asking about turn 1's work can only
 * succeed if the state really outlived the turn.
 *
 * Every turn is judged by its own marks and ALL must pass; the run stops at
 * the first failure (later turns build on the failed one, so their verdicts
 * would be noise rather than evidence).
 */
export async function runScenario(
  port: number,
  presetId: string,
  scenario: ScenarioSpec,
  timeoutMs = DEFAULT_TURN_BUDGET_MS,
  onPhase?: (line: string) => void,
): Promise<ProbeResult> {
  const session = await openProbeSession(port, presetId);
  const turns: TurnResult[] = [];
  try {
    for (const [i, turn] of scenario.turns.entries()) {
      const turnStart = Date.now();
      const reply = await sendTurn(session, turn.prompt, timeoutMs);
      if (reply === undefined) {
        onPhase?.(`轮 ${String(i + 1)}/${String(scenario.turns.length)} ✗ 超时(${String(Math.round(timeoutMs / 1000))}s)`);
        return {
          status: "FAIL",
          kind: "scenario",
          scenario,
          turns,
          reason: `第 ${String(i + 1)} 轮未在 ${String(Math.round(timeoutMs / 1000))}s 内完成`,
        };
      }
      const pass = marksPresent(turn.mustInclude, reply);
      onPhase?.(`轮 ${String(i + 1)}/${String(scenario.turns.length)} ${pass ? '✓' : '✗'}(${String(Math.round((Date.now() - turnStart) / 1000))}s)`);
      turns.push({ index: i + 1, prompt: turn.prompt, mustInclude: turn.mustInclude, pass, reply: reply.slice(0, 300) });
      if (!pass) {
        return {
          status: "FAIL",
          kind: "scenario",
          scenario,
          turns,
          reason: `第 ${String(i + 1)} 轮未含验收标记 [${turn.mustInclude.join(", ")}]`,
        };
      }
    }
    const pass = evaluateScenario(turns, scenario.turns.length);
    return { status: pass ? "PASS" : "FAIL", kind: "scenario", scenario, turns };
  } finally {
    session.close();
  }
}
