// DeepSeek 补全(流式)。纪律与装配器 ai-call 零件同款:
// - key 只从环境变量读(DEEPSEEK_API_KEY),永不落文件、永不回显
// - max_tokens 地板 256:推理模型的思维链吃 completion 预算,小预算会把可见
//   答案吃成空串(实测教训)
// - 未配 key 抛结构化错误(code:'no-key'),由 server 转成可行动的 error 事件
const API_BASE = process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com";

export async function* streamAnswer({ system, prompt, model = "deepseek-v4-flash", maxTokens = 2048, signal }) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    const err = new Error("未配置 DEEPSEEK_API_KEY:在启动 app 的环境里 export DEEPSEEK_API_KEY=<你的 key> 后重启即可(key 不写进任何文件)");
    err.code = "no-key";
    throw err;
  }
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: Math.max(256, maxTokens),
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`模型调用失败 HTTP ${res.status}:${body.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") return;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      const delta = ev.choices?.[0]?.delta ?? {};
      // 推理模型的思维链走独立通道:前台可见但绝不混进答案(混了引用会脏)
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "")
        yield { kind: "thinking", text: delta.reasoning_content };
      if (typeof delta.content === "string" && delta.content !== "")
        yield { kind: "delta", text: delta.content };
    }
  }
}
