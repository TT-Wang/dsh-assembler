#!/usr/bin/env node
/**
 * @dsh-index/pdf-extract — MCP stdio server wrapping pdf-parse@1.1.1 (MIT).
 *
 * Capability points (tools):
 *   - get-pdf-text     : extract full text (+ page statistics) from a local PDF file
 *   - get-pdf-info     : read PDF page count / info / metadata without extracting body text
 *   - search-pdf-text  : case-insensitive keyword search over the extracted PDF text
 *
 * Run: node index.js   (speaks MCP over stdio; connect with any MCP client)
 */
import fs from "node:fs";
// 注意：不导入 npm 入口 "pdf-parse"（其 index.js 含 isDebugMode = !module.parent 调试块，
// 在 ESM 环境下 module.parent 为 undefined 会触发读 test/data 的调试代码导致启动崩溃）。
// 直接导入真正的实现模块 pdf-parse/lib/pdf-parse.js，规避该上游怪癖。
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "pdf-extract", version: "0.0.1" });

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Read a local PDF file into a Buffer. Throws with a clear message. */
function readPdfFile(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new Error("path 必须是非空字符串（本地 PDF 文件路径）");
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`无法访问文件 "${filePath}"（文件不存在或无权限）`);
  }
  if (!stat.isFile()) {
    throw new Error(`"${filePath}" 不是普通文件`);
  }
  return fs.readFileSync(filePath);
}

/** Run pdf-parse; maxPages<=0 means all pages. Returns the parsed result object. */
async function parsePdf(filePath, maxPages = 0) {
  const buffer = readPdfFile(filePath);
  return pdfParse(buffer, { max: maxPages });
}

/** Normalize pdf.js metadata (may be a string, a Metadata instance, or null). */
function normalizeMetadata(metadata) {
  if (metadata == null) return null;
  if (typeof metadata === "string") return metadata;
  if (typeof metadata.raw === "string") return metadata.raw;
  try {
    const s = String(metadata);
    return s && s !== "[object Object]" ? s : null;
  } catch {
    return null;
  }
}

function okText(text) {
  return { content: [{ type: "text", text }] };
}

function errText(message) {
  return { content: [{ type: "text", text: `ERROR: ${message}` }], isError: true };
}

function wrap(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return errText(e && e.message ? e.message : String(e));
    }
  };
}

/* ------------------------------------------------------------------ */
/* tools                                                               */
/* ------------------------------------------------------------------ */

server.tool(
  "get-pdf-text",
  "从本地 PDF 文件提取全部文本内容（含页数/已渲染页数/pdf.js 版本统计）。" +
    "适合把 PDF 正文转成纯文本供 LLM 阅读、摘要或后续检索；可选 maxPages 只提取前 N 页以节省时间。",
  {
    path: z.string().describe("本地 PDF 文件的路径（绝对路径，或相对 MCP 服务器工作目录的路径）。"),
    maxPages: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("最多提取前 N 页的文本；0 或省略表示提取全部页。"),
  },
  wrap(async ({ path, maxPages }) => {
    const d = await parsePdf(path, maxPages ?? 0);
    const header =
      `numPages=${d.numpages} renderedPages=${d.numrender} pdfjsVersion=${d.version} file="${path}"`;
    return okText(header + "\n----- extracted text -----\n" + d.text);
  })
);

server.tool(
  "get-pdf-info",
  "读取本地 PDF 的元数据：页数(numPages)、info(标题/作者/创建工具/Producer 等)、metadata(XMP 原始元数据)、pdf.js 版本。" +
    "不提取正文文本，适合快速判断 PDF 结构、页数与来源信息。",
  {
    path: z.string().describe("本地 PDF 文件的路径（绝对路径，或相对 MCP 服务器工作目录的路径）。"),
  },
  wrap(async ({ path }) => {
    const d = await parsePdf(path, 0);
    const summary = {
      file: path,
      numPages: d.numpages,
      info: d.info ?? null,
      metadata: normalizeMetadata(d.metadata),
      pdfjsVersion: d.version,
    };
    return okText(JSON.stringify(summary, null, 2));
  })
);

server.tool(
  "search-pdf-text",
  "在本地 PDF 的提取文本中做大小写不敏感的关键词搜索，返回命中的行号、命中行文本与命中总数。" +
    "适合判断文档是否包含某主题/人名/编号，避免把整篇文本读给模型。",
  {
    path: z.string().describe("本地 PDF 文件的路径（绝对路径，或相对 MCP 服务器工作目录的路径）。"),
    query: z.string().min(1).describe("要搜索的关键词或短语（大小写不敏感的子串匹配，非正则）。"),
    maxPages: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("最多搜索前 N 页；0 或省略表示搜索全部页。"),
  },
  wrap(async ({ path, query, maxPages }) => {
    const d = await parsePdf(path, maxPages ?? 0);
    const q = query.toLowerCase();
    const hits = [];
    d.text.split("\n").forEach((line, i) => {
      if (line.toLowerCase().includes(q)) {
        hits.push({ line: i + 1, text: line.slice(0, 300) });
      }
    });
    const result = {
      file: path,
      query,
      numPages: d.numpages,
      searchedPages: d.numrender,
      totalMatches: hits.length,
      hits: hits.slice(0, 200),
    };
    return okText(JSON.stringify(result, null, 2));
  })
);

/* ------------------------------------------------------------------ */
/* stdio transport: clean startup & shutdown                            */
/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);
// connect() 在 transport.start() 后即返回（不会阻塞），server 靠 transport 的事件循环存活。
// 客户端断开时 stdin 收到 EOF，这里显式处理"干净退出"：给挂起的 stdout 写操作留一点
// 刷新时间后以 0 退出；若事件循环先自行排空则自然退出，两者不冲突。
process.stdin.on("end", () => {
  setTimeout(() => process.exit(0), 150).unref();
});
