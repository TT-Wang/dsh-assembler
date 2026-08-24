// DeepSeek 补全(非流式,单发)。纪律与 ai-call 零件同款:key 只从环境变量读、
// 永不落文件;max_tokens 地板 256(推理模型思维链吃预算的实测教训);无 key 抛
// 结构化错误(code:'no-key'),由 server 转成可行动指引。
const API_BASE = process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com";

export async function complete({ system, prompt, model = "deepseek-v4-flash", maxTokens = 1024 }) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    const err = new Error("未配置 DEEPSEEK_API_KEY:在启动 app 的环境里 export 后重启即可(key 不写进任何文件);表单/SQL 直连不受影响");
    err.code = "no-key";
    throw err;
  }
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: Math.max(256, maxTokens),
      messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`模型调用失败 HTTP ${res.status}:${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content ?? "";
}
