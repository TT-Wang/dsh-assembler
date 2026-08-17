#!/usr/bin/env node
/**
 * Smoke test for @dsh-index/docx-generate MCP stdio server.
 *
 * 1. listTools() — print tool catalog
 * 2. docx-generate-text — real call, verify base64 payload is a ZIP (PK magic) containing word/document.xml
 * 3. docx-generate-table — real call, verify ZIP + document.xml
 * 4. docx-patch-document — round-trip: generate → patch → verify patched output
 * 5. Missing-argument call — verify schema validation error surfaces as an error response
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results = [];
const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// --- minimal ZIP reader: scan bytes for PK\x03\x04 and the entry name ---
function zipHasEntry(buf, entryName) {
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return false; // "PK"
    const ascii = buf.toString("latin1");
    return ascii.includes(entryName);
}

async function decodeToolResult(content) {
    // content: [{type:'text', text: JSON}]
    const text = content.map((c) => c.text).join("\n");
    return JSON.parse(text);
}

const transport = new StdioClientTransport({
    command: "node",
    args: ["index.js"],
    cwd: new URL(".", import.meta.url).pathname,
    stderr: "pipe",
});

// capture server stderr for diagnostics
let stderrBuf = "";
transport.stderr.on("data", (d) => {
    stderrBuf += d.toString();
});

const client = new Client({ name: "docx-generate-smoke", version: "0.0.1" });

let failures = 0;

try {
    await client.connect(transport);

    // 1. listTools
    const toolsResp = await client.listTools();
    const tools = toolsResp.tools;
    console.log("\n=== Tool catalog ===");
    for (const t of tools) {
        console.log(`  - ${t.name}: ${(t.description || "").slice(0, 90)}...`);
    }
    const expected = ["docx-generate-text", "docx-generate-table", "docx-patch-document"];
    const missing = expected.filter((n) => !tools.some((t) => t.name === n));
    record("listTools (3 tools)", tools.length === 3 && missing.length === 0, `found ${tools.length}, missing=[${missing}]`);

    // 2. docx-generate-text real call
    const textResp = await client.callTool({
        name: "docx-generate-text",
        arguments: {
            title: "冒烟测试报告",
            paragraphs: [
                { text: "这是正文第一段。", type: "body" },
                { text: "一级标题下的内容", type: "heading1" },
                { text: "加粗的项目符号项", type: "bullet", bold: true },
                { text: "第一个编号项", type: "numbered" },
                { text: "居中且标红的段落", type: "body", alignment: "center", color: "#FF0000", sizePt: 16 },
            ],
        },
    });
    const textRes = await decodeToolResult(textResp.content);
    record("docx-generate-text call ok", textRes.ok === true && !!textRes.base64, `byteLength=${textRes.byteLength}`);
    const textBuf = Buffer.from(textRes.base64, "base64");
    record("text output is ZIP (PK magic)", zipHasEntry(textBuf, "PK"), "magic PK present");
    record("text zip has word/document.xml", zipHasEntry(textBuf, "word/document.xml"), "entry present");

    // write to temp file for manual inspection
    const dir = await mkdtemp(join(tmpdir(), "docx-smoke-"));
    const textFile = join(dir, "text.docx");
    await writeFile(textFile, textBuf);
    record("text docx written to temp", true, textFile);

    // 3. docx-generate-table real call
    const tableResp = await client.callTool({
        name: "docx-generate-table",
        arguments: {
            title: "销售报表",
            headerRow: ["产品", "Q1", "Q2", "Q3"],
            rows: [
                ["苹果", "120", "150", "180"],
                ["香蕉", "80", "90", "100"],
                ["橙子", "60", "75", "95"],
            ],
            columnWidths: [40, 20, 20, 20],
            alignment: "center",
        },
    });
    const tableRes = await decodeToolResult(tableResp.content);
    record("docx-generate-table call ok", tableRes.ok === true && !!tableRes.base64, `byteLength=${tableRes.byteLength}`);
    const tableBuf = Buffer.from(tableRes.base64, "base64");
    record("table output is ZIP + word/document.xml", zipHasEntry(tableBuf, "PK") && zipHasEntry(tableBuf, "word/document.xml"), "entries present");
    const tableFile = join(dir, "table.docx");
    await writeFile(tableFile, tableBuf);
    record("table docx written to temp", true, tableFile);

    // 4. docx-patch-document round trip
    const patchResp = await client.callTool({
        name: "docx-patch-document",
        arguments: {
            inputBase64: textRes.base64,
            patches: {
                token_test: {
                    type: "paragraph",
                    children: [{ text: "被替换的占位符内容" }],
                },
            },
            keepOriginalStyles: true,
        },
    });
    const patchRes = await decodeToolResult(patchResp.content);
    record("docx-patch-document call ok", patchRes.ok === true && !!patchRes.base64, `byteLength=${patchRes.byteLength}`);
    const patchedBuf = Buffer.from(patchRes.base64, "base64");
    record("patched output is ZIP + word/document.xml", zipHasEntry(patchedBuf, "PK") && zipHasEntry(patchedBuf, "word/document.xml"), "entries present");
    const patchFile = join(dir, "patched.docx");
    await writeFile(patchFile, patchedBuf);
    record("patched docx written to temp", true, patchFile);

    // 5. missing-argument call — validation must be rejected by the server
    // (MCP SDK 1.3x surfaces validation failures as isError=true error responses, not client throws)
    try {
        const badArgsResp = await client.callTool({ name: "docx-generate-text", arguments: {} });
        const badArgsText = badArgsResp.content.map((c) => c.text).join("\n");
        const rejected = badArgsResp.isError === true || /error|invalid|required/i.test(badArgsText);
        record("missing-arg rejected with error", rejected, badArgsText.slice(0, 140));
    } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        record("missing-arg rejected with error", /paragraphs|参数|Invalid|missing/i.test(msg), msg.slice(0, 120));
    }

    // 6. invalid patch key (bad char) — tool-level error text
    const badPatchResp = await client.callTool({
        name: "docx-patch-document",
        arguments: {
            inputBase64: textRes.base64,
            patches: { "bad key!": { type: "paragraph", children: [{ text: "x" }] } },
        },
    });
    const badPatchRes = await decodeToolResult(badPatchResp.content);
    record("invalid patch key returns error text", badPatchRes.ok === false, badPatchRes.error?.slice(0, 80));

    
// savePath / inputPath 模式:二进制走文件不过上下文
{
  const _os = await import('node:os'); const _p = await import('node:path'); const _fs = await import('node:fs');
  const wd = _fs.mkdtempSync(_p.join(_os.tmpdir(), 'docx-save-'));
  const t2 = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname], cwd: wd });
  const c2 = new Client({ name: 'smoke2', version: '0.0.1' });
  await c2.connect(t2);
  const rs = await c2.callTool({ name: 'docx-generate-text', arguments: { title: 'SaveTest', paragraphs: [{ type: 'body', text: 'roundtrip-mark-9To2' }], savePath: 'out/a.docx' } });
  const js = JSON.parse(rs.content.map((b) => b.text ?? '').join(''));
  record('savePath 返回 savedTo 无 base64', js.ok === true && js.savedTo !== undefined && js.base64 === undefined, JSON.stringify(js).slice(0, 120));
  const head = _fs.readFileSync(_p.join(wd, 'out/a.docx')).subarray(0, 2).toString();
  record('savePath 落盘 PK 魔数', head === 'PK');
  const rp = await c2.callTool({ name: 'docx-patch-document', arguments: { inputPath: 'out/a.docx', patches: { addendum: { type: 'document', children: [{ type: 'body', text: 'patched-mark' }] } }, savePath: 'out/b.docx' } });
  const jp = JSON.parse(rp.content.map((b) => b.text ?? '').join(''));
  record('inputPath→savePath 修补链路(零 base64)', jp.ok === true && jp.savedTo !== undefined, JSON.stringify(jp).slice(0, 120));
  const resc = await c2.callTool({ name: 'docx-generate-text', arguments: { paragraphs: [{ type: 'body', text: 'x' }], savePath: '../esc.docx' } });
  record('savePath 越界被拒', JSON.stringify(resc).includes('越出工作区'));
  await c2.close();
}

await client.close();
} catch (err) {
    failures++;
    record("smoke run (fatal)", false, String(err && err.message ? err.message : err));
} finally {
    try {
        await transport.close();
    } catch {
        /* ignore */
    }
}

console.log("\n--- server stderr (last 5 lines) ---");
console.log(stderrBuf.split("\n").filter(Boolean).slice(-5).join("\n"));

const failed = results.filter((r) => !r.ok).length + failures;
console.log(`\nSMOKE RESULT: ${results.length + (failures ? 1 : 0)} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
