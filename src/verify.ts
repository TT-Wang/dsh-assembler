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

export interface ProbeResult {
  status: "PASS" | "FAIL" | "SKIPPED";
  probe?: ProbeSpec;
  /** Final assistant reply (truncated) — the evidence the verdict judged. */
  reply?: string;
  /** Why the run degraded to SKIPPED, when it did. */
  reason?: string;
}

/** Pure verdict: every mark present, case-insensitive. Unit-tested. */
export function evaluateProbe(spec: ProbeSpec, reply: string): boolean {
  const hay = reply.toLowerCase();
  return spec.mustInclude.length > 0 && spec.mustInclude.every((m) => hay.includes(m.toLowerCase()));
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
    "- mustInclude: 1-3 content-bearing strings that will appear in the reply IFF the task truly succeeded (a computed value, a verbatim token from the task input). Never accept generic words like \"done\" or \"success\".",
    "- mustInclude values MUST be derivable from data embedded in the task text itself. NEVER use remembered world facts (a domain's IP, a live exchange rate, today's date) — live data changes and remembered values go stale.",
    "- Avoid over-precise numeric marks: a mark like \"111.195\" fails when the tool legitimately prints 111.1949. Prefer a verbatim echo token, an integer, or the leading digits of a number (e.g. \"111.1\").",
    "- Budget: the probe agent has ~4 minutes. Avoid tasks whose replies embed large payloads (full base64 images) — ask for byte counts or short prefixes instead.",
  ].join("\n");
  const assembler = new BlockAssembler();
  // Same fast-model + provider-resolution discipline as llmMapRequirement:
  // provider follows host selection, model pins flash unless config overrides.
  const selection = (ctx.get("agentDefaultModel") as { currentSelection?: () => { provider?: string } | undefined } | undefined)?.currentSelection?.();
  const options: GenerateOptions = {
    provider: llm.provider ?? selection?.provider ?? "deepseek-official",
    model: llm.model ?? "deepseek-v4-flash",
    messages: [createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "user" } })],
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
  const parsed = JSON.parse(m[0]) as ProbeSpec;
  if (typeof parsed.task !== "string" || !Array.isArray(parsed.mustInclude)) {
    throw new Error("probe deriver JSON missing task/mustInclude");
  }
  return { task: parsed.task, mustInclude: parsed.mustInclude.map(String).slice(0, 3) };
}

/** Run the probe in a real session bound to the preset, over the local wire. */
export async function runProbe(
  port: number,
  presetId: string,
  probe: ProbeSpec,
  timeoutMs = 300_000,
): Promise<ProbeResult> {
  const base = `http://127.0.0.1:${port}`;
  const rpc = async (method: string, payload: unknown): Promise<any> => {
    const res = await fetch(`${base}/api/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: `probe-${Date.now()}`, method, payload }),
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

  try {
    await rpc("session.prompt", {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: probe.task }],
    });
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (frames.some((e) => e.type === "turn/end")) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!frames.some((e) => e.type === "turn/end")) {
      return { status: "FAIL", probe, reason: `probe turn did not finish within ${Math.round(timeoutMs / 1000)}s` };
    }
    // Wire shape: {type:'assistant/message', data:{turn, step, message:{role, content:[blocks]}}}.
    // Judge TEXT blocks only — reasoning text is the model talking to itself,
    // and a mark that appears there but not in the reply did not reach the user.
    const reply = frames
      .filter((e) => e.type === "assistant/message")
      .map((e) => {
        const c = e.data?.message?.content ?? e.data?.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) {
          return c.map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
        }
        return "";
      })
      .join("\n");
    const pass = evaluateProbe(probe, reply);
    return { status: pass ? "PASS" : "FAIL", probe, reply: reply.slice(0, 400) };
  } finally {
    ws.close();
  }
}
