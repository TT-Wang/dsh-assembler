/**
 * smoke.mjs — 冒烟验证 @dsh-index/pdf-extract (MCP stdio server, wraps pdf-parse@1.1.1)
 *
 * 测试输入：sample.pdf = pdf-parse@1.1.1 自带官方测试文件 test/data/01-valid.pdf
 *           （14 页真实学术论文 PDF，与上游同一 pdf.js 版本自测所用，权威可靠）
 *
 *  1) 用 MCP Client + StdioClientTransport 连接 node index.js
 *  2) listTools() 打印工具清单
 *  3) 真实调用 get-pdf-text / get-pdf-info / search-pdf-text
 *  4) 缺参调用 → 期望 -32602 校验错误；不存在的文件 → 期望工具内错误文本
 *  5) 独立进程验证：stdin 关闭后 server 干净退出(exit 0)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(__dirname, "sample.pdf");
const EXPECT_PAGES = 14;
let failures = 0;

function check(name, cond, detail) {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

check("sample.pdf 存在（上游官方测试 PDF）", fs.existsSync(SAMPLE_PDF), `${SAMPLE_PDF} (${fs.statSync(SAMPLE_PDF).size} bytes)`);

/* ---------- MCP 客户端冒烟 ---------- */
const transport = new StdioClientTransport({
  command: "node",
  args: ["index.js"],
  cwd: __dirname,
});
const client = new Client({ name: "smoke-pdf-extract", version: "0.0.1" });
await client.connect(transport);

// listTools
const { tools } = await client.listTools();
check("listTools", tools.length >= 3, `returned ${tools.length} tools`);
for (const t of tools) {
  console.log(`   - ${t.name}: ${(t.description || "").slice(0, 90)}`);
}
const names = tools.map((t) => t.name);
check("tool get-pdf-text present", names.includes("get-pdf-text"));
check("tool get-pdf-info present", names.includes("get-pdf-info"));
check("tool search-pdf-text present", names.includes("search-pdf-text"));

// call 1: get-pdf-text（只取第 1 页）
const t1 = await client.callTool({ name: "get-pdf-text", arguments: { path: SAMPLE_PDF, maxPages: 1 } });
const t1text = t1.content.map((c) => c.text).join("\n");
check("get-pdf-text 成功往返且非错误", t1.isError !== true);
check("get-pdf-text 报告总页数=14", t1text.includes(`numPages=${EXPECT_PAGES}`), t1text.split("\n")[0]);
check("get-pdf-text 提取到第 1 页文本", t1text.includes("Trace-based") && t1text.includes("Just-in-Time"));

// call 2: get-pdf-info
const t2 = await client.callTool({ name: "get-pdf-info", arguments: { path: SAMPLE_PDF } });
const t2text = t2.content.map((c) => c.text).join("\n");
check("get-pdf-info 成功往返且非错误", t2.isError !== true);
check("get-pdf-info 含页数与 pdfjsVersion", t2text.includes(`"numPages": ${EXPECT_PAGES}`) && t2text.includes("pdfjsVersion"));
check("get-pdf-info 含 info 元数据", t2text.includes("Creator") || t2text.includes("Producer"), t2text.slice(0, 160).replace(/\n/g, " "));

// call 3: search-pdf-text（大小写不敏感）
const t3 = await client.callTool({
  name: "search-pdf-text",
  arguments: { path: SAMPLE_PDF, query: "just-in-time", maxPages: 1 },
});
const t3text = t3.content.map((c) => c.text).join("\n");
check("search-pdf-text 成功往返且非错误", t3.isError !== true);
check("search-pdf-text 大小写不敏感命中", /"totalMatches": [1-9]/.test(t3text) && t3text.includes("Just-in-Time"), t3text.slice(0, 200).replace(/\n/g, " "));

// call 4: 缺参调用 → 期望 -32602 校验错误（SDK 以 isError 结果返回，不抛异常）
const t4 = await client.callTool({ name: "get-pdf-text", arguments: {} });
const t4text = t4.content.map((c) => c.text).join("\n");
check("缺参调用触发参数校验(-32602)", t4.isError === true && t4text.includes("-32602"), t4text.slice(0, 120));

// call 5: 不存在的文件 → 期望工具内错误文本(isError)
const t5 = await client.callTool({
  name: "get-pdf-text",
  arguments: { path: "/definitely/not/a/real/file.pdf" },
});
const t5text = t5.content.map((c) => c.text).join("\n");
check("不存在的文件返回 isError 错误文本", t5.isError === true && t5text.startsWith("ERROR:"), t5text.slice(0, 80));

// call 6: 非 PDF 文件 → 期望清晰解析错误
const junk = path.join(__dirname, "junk.txt");
fs.writeFileSync(junk, "this is not a pdf at all\n");
const t6 = await client.callTool({ name: "get-pdf-text", arguments: { path: junk } });
const t6text = t6.content.map((c) => c.text).join("\n");
fs.unlinkSync(junk);
check("非 PDF 文件返回清晰错误", t6.isError === true && t6text.startsWith("ERROR:"), t6text.slice(0, 100));

await client.close();
console.log("[info] MCP client closed");

/* ---------- stdin 关闭后 server 干净退出 ---------- */
const child = spawn("node", ["index.js"], { cwd: __dirname });
const exitCode = await new Promise((resolve) => {
  child.on("exit", (code) => resolve(code));
  child.stdin.end(); // 直接关闭 stdin
  setTimeout(() => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      resolve("HANG");
    }
  }, 5000).unref();
});
check("stdin 关闭后 server 干净退出(exit 0)", exitCode === 0, `exit=${exitCode}`);

/* ---------- 汇总 ---------- */
console.log(failures === 0 ? "\nSMOKE RESULT: ALL PASS" : `\nSMOKE RESULT: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
