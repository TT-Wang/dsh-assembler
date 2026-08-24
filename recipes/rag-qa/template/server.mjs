// RAG 问答服务:检索(本地 BM25)+ 回答(DeepSeek 流式)+ 引用可核(/corpus 原文可点开)。
// 零依赖(node:http);检索半边不吃凭证——未配 key 时照样检索并给出可行动错误。
//
// 边界守则(每条都是真实故障模式):
// - 请求体坏 → 400,绝不让 async handler 未捕获拒绝(那会带崩整个进程)
// - 头未发出前完成所有可失败步骤(读索引/建会话式资源),错误才有资格变成真 HTTP 状态码
// - 客户端中途关页 → abort 上游模型调用,停止为没人看的页面付费
// - res 'error' 兜底:写到一半对端消失的 EPIPE 不许变成未捕获异常
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { buildIndex, search } from "./lib/search.mjs";
import { streamAnswer } from "./lib/ai.mjs";

const ROOT = import.meta.dirname;
const PUB = path.join(ROOT, "public");
const CORPUS = path.join(ROOT, "corpus");
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "app.config.json"), "utf8"));
const CHUNKS = fs.existsSync(path.join(ROOT, "data", "index.json"))
  ? JSON.parse(fs.readFileSync(path.join(ROOT, "data", "index.json"), "utf8"))
  : [];
const INDEX = buildIndex(CHUNKS);
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".md": "text/plain; charset=utf-8", ".mdx": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".htm": "text/html; charset=utf-8" };

const sse = (res, obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

http.createServer(async (req, res) => {
  res.on("error", () => {});
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";

  if (req.method === "GET" && pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, chunks: CHUNKS.length, keyConfigured: Boolean(process.env.DEEPSEEK_API_KEY) }));
    return;
  }

  if (req.method === "GET" && pathname === "/api/meta") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      appName: CFG.APP_NAME ?? "知识问答",
      roleLine: CFG.ROLE_LINE ?? "",
      examples: String(CFG.EXAMPLE_QUESTIONS ?? "").split("|").map((s) => s.trim()).filter(Boolean),
      keyConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
    }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/ask") {
    let question;
    try {
      let body = "";
      for await (const part of req) { body += part; if (body.length > 64 * 1024) throw new Error("too large"); }
      const parsed = JSON.parse(body);
      if (typeof parsed.question !== "string" || !parsed.question.trim()) throw new Error("bad");
      question = parsed.question.trim();
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "需要 JSON 体 { question: string }(≤64KB)" }));
      return;
    }
    const hits = search(INDEX, CHUNKS, question);
    const sources = hits.map((c) => ({ source: c.source, heading: c.heading, url: `/corpus/${c.source}`, text: c.text }));
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    try {
      if (hits.length === 0) {
        // 检索零命中如实说,不让模型编——sources 事件仍发(空数组),前端好渲染
        sse(res, { sources: [] });
        sse(res, { delta: "语料里检索不到与这个问题相关的内容。换个说法试试,或确认相关文档已在语料里。" });
      } else {
        const context = hits.map((c, i) => `[${i + 1}] ${c.source} — ${c.heading}\n${c.text}`).join("\n\n");
        const prompt = `只依据下面的编号资料回答问题;引用资料时用 [1][2] 这样的行内标注;资料不足以回答就如实说明。用提问的语言回答,纯文本短段落(不要 markdown 语法)。\n\n${context}\n\n问题:${question}`;
        for await (const ev of streamAnswer({ system: CFG.ROLE_LINE ?? "", prompt, model: CFG.MODEL || "deepseek-v4-flash", signal: ac.signal })) {
          if (ev.kind === "thinking") sse(res, { thinking: ev.text });
          else sse(res, { delta: ev.text });
        }
        // 来源殿后:带全文文本——前端 [n] 弹层必须能展示答案背后的原文块,编号 1:1 对应
        sse(res, { sources });
      }
    } catch (error) {
      // 凭证契约:接口先就位,key 后补——未配 key 时检索结果照给、错误可行动
      if (error?.code === "no-key") { sse(res, { sources }); sse(res, { error: String(error.message) }); }
      else if (!ac.signal.aborted) sse(res, { error: `回答生成失败:${error instanceof Error ? error.message : String(error)}` });
    } finally {
      if (!res.writableEnded) res.end();
    }
    return;
  }

  // 静态:/corpus/* 只读伺服原文(引用链接必须能解析到真文件),其余走 public/
  const inCorpus = pathname.startsWith("/corpus/");
  const base = inCorpus ? CORPUS : PUB;
  const rel = inCorpus ? decodeURIComponent(pathname.slice("/corpus/".length)) : pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const file = path.normalize(path.join(base, rel));
  if ((file.startsWith(base + path.sep) || file === path.join(base, "index.html")) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] ?? "text/plain; charset=utf-8" });
    res.end(fs.readFileSync(file));
  } else {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}).listen(Number(process.env.PORT ?? 4630), "127.0.0.1", function () {
  console.log(`ready http://127.0.0.1:${this.address().port} — ${CHUNKS.length} chunks, key=${process.env.DEEPSEEK_API_KEY ? "configured" : "MISSING"}`);
});
