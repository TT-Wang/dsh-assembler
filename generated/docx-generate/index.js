#!/usr/bin/env node
/**
 * @dsh-index/docx-generate — MCP stdio server wrapping dolanmiu/docx v8.5.0.
 *
 * Tools:
 *  1. docx-generate-text    — build a .docx from declarative text content (title/headings/body/bullets/numbered lists)
 *  2. docx-generate-table   — build a .docx containing a table from 2D string data
 *  3. docx-patch-document   — patch an existing .docx (base64) by replacing {{token}} placeholders / appending content
 *
 * All tools return a JSON text payload; generated documents are base64-encoded .docx bytes.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
    AlignmentType,
    Document,
    HeadingLevel,
    Packer,
    Paragraph,
    PatchType,
    Table,
    TableCell,
    TableRow,
    TextRun,
    WidthType,
    patchDocument,
} from "docx";

import { writeFileSync, mkdirSync, readFileSync as readFileSyncFs } from "node:fs";
import * as nodePath from "node:path";

// 路径锚点:相对路径一律解析进部署方钉的工作区(PART_WORKDIR,发射端注入),
// 而不是零件进程的 cwd(= host 检出目录)——市场战役 s23 实锤:docx 写进了 host 检出。
const PART_WORKDIR = process.env.PART_WORKDIR || process.cwd();
const log = (...args) => console.error("[docx-generate]", ...args);

const ALIGNMENTS = {
    left: AlignmentType.LEFT,
    center: AlignmentType.CENTER,
    right: AlignmentType.RIGHT,
    justified: AlignmentType.JUSTIFIED,
};

const HEADINGS = {
    heading1: HeadingLevel.HEADING_1,
    heading2: HeadingLevel.HEADING_2,
    heading3: HeadingLevel.HEADING_3,
};

// A tiny, self-contained numbering config so "numbered" list items work out of the box.
const DEFAULT_NUMBERING = {
    config: [
        {
            reference: "dsh-default-numbering",
            levels: [
                {
                    level: 0,
                    format: "decimal",
                    text: "%1.",
                    alignment: AlignmentType.LEFT,
                },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Shared builders
// ---------------------------------------------------------------------------

/** Build a TextRun from a user-provided text item (subset of IRunOptions). */
function buildTextRun(item) {
    return new TextRun({
        text: item.text,
        bold: item.bold ?? false,
        italics: item.italic ?? false,
        ...(item.sizePt ? { size: Math.round(item.sizePt * 2) } : {}), // docx uses half-points
        ...(item.color ? { color: String(item.color).replace(/^#/, "") } : {}),
        ...(item.font ? { font: item.font } : {}),
    });
}

/**
 * Build a Paragraph from a user-provided item.
 * `item.type` selects body / heading1-3 / bullet / numbered.
 */
function buildParagraph(item) {
    const run = buildTextRun(item);
    const alignment = item.alignment ? ALIGNMENTS[item.alignment] : undefined;

    if (item.type === "heading1" || item.type === "heading2" || item.type === "heading3") {
        return new Paragraph({
            heading: HEADINGS[item.type],
            alignment: alignment ?? AlignmentType.LEFT,
            children: [run],
        });
    }
    if (item.type === "bullet") {
        return new Paragraph({
            bullet: { level: 0 },
            children: [run],
        });
    }
    if (item.type === "numbered") {
        return new Paragraph({
            numbering: { reference: "dsh-default-numbering", level: 0 },
            children: [run],
        });
    }
    // body (default)
    return new Paragraph({
        alignment: alignment ?? AlignmentType.LEFT,
        spacing: {
            after: item.spacingAfterPt ? Math.round(item.spacingAfterPt * 20) : 120, // twips
        },
        children: [run],
    });
}

/**
 * Serialize a generated docx Buffer to a tool result JSON string.
 * savePath given → write inside the workspace and return the path WITHOUT
 * base64: binary must travel between parts as files, not through the model
 * context (a 15KB base64 the agent retypes into the next call costs minutes).
 */
function okResult(buffer, fileName, savePath) {
    if (savePath !== undefined) {
        const root = PART_WORKDIR;
        const target = nodePath.resolve(root, savePath);
        if (target !== root && !target.startsWith(root + nodePath.sep)) {
            throw new Error(`savePath 越出工作区: ${savePath}`);
        }
        mkdirSync(nodePath.dirname(target), { recursive: true });
        writeFileSync(target, buffer);
        return JSON.stringify({ ok: true, format: "docx", fileName, byteLength: buffer.length, savedTo: target });
    }
    return JSON.stringify({
        ok: true,
        format: "docx",
        fileName,
        byteLength: buffer.length,
        base64: buffer.toString("base64"),
        hint: `Decode the base64 field to obtain the .docx file (e.g. Buffer.from(base64, 'base64')).`,
    });
}

function errResult(message) {
    return JSON.stringify({ ok: false, error: String(message) });
}

async function safe(fn) {
    try {
        return await fn();
    } catch (err) {
        log("tool failed:", err && err.stack ? err.stack : err);
        return { content: [{ type: "text", text: errResult(err && err.message ? err.message : err) }] };
    }
}

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------

const server = new McpServer(
    {
        name: "@dsh-index/docx-generate",
        version: "0.0.1",
    },
    {
        capabilities: {
            tools: {},
        },
    },
);

server.tool(
    "docx-generate-text",
    "生成纯文本型 Word 文档（.docx）。输入声明式的段落列表：支持文档标题(title)、一级/二级/三级标题、正文段落、项目符号列表、编号列表；每段可设加粗(bold)、斜体(italic)、对齐(alignment)、字号(sizePt, pt)、颜色(color, 十六进制)、字体(font)。返回 JSON，其中 base64 字段为 .docx 文件内容（可直接解码保存或用 docx-patch-document / 其他工具落盘）。适合：报告、笔记、说明文档、信函、简历等。",
    {
        savePath: z.string().optional().describe("落盘路径(相对工作区,如 out/doc.docx);给了就写文件、返回 savedTo 且不回传 base64——推荐,二进制不过对话上下文"),
        title: z
            .string()
            .optional()
            .describe("文档大标题（居中，使用 TITLE 样式）。不传则文档无标题。"),
        paragraphs: z
            .array(
                z.object({
                    text: z.string().describe("该段的文本内容。"),
                    type: z
                        .enum(["body", "heading1", "heading2", "heading3", "bullet", "numbered"])
                        .optional()
                        .describe("段落类型：body=正文（默认）；heading1/heading2/heading3=各级标题；bullet=项目符号列表项；numbered=自动编号列表项。"),
                    bold: z.boolean().optional().describe("是否加粗。"),
                    italic: z.boolean().optional().describe("是否斜体。"),
                    alignment: z
                        .enum(["left", "center", "right", "justified"])
                        .optional()
                        .describe("段落对齐方式，默认 left。"),
                    sizePt: z
                        .number()
                        .min(8)
                        .max(72)
                        .optional()
                        .describe("字号（单位 pt，1pt=1/72 英寸；默认正文约 12pt）。"),
                    color: z
                        .string()
                        .optional()
                        .describe("文字颜色，十六进制，如 \"FF0000\" 或 \"#FF0000\"。"),
                    font: z.string().optional().describe("字体名，如 \"SimSun\"（宋体）、\"Calibri\"、\"Arial\"。"),
                    spacingAfterPt: z
                        .number()
                        .min(0)
                        .max(60)
                        .optional()
                        .describe("段后间距（pt），仅对正文段落生效。"),
                }),
            )
            .min(1)
            .describe("按顺序渲染的文档内容段落列表（至少 1 段）。"),
    },
    async (params) =>
        safe(async () => {
            const { title, paragraphs } = params;
            const children = [];

            if (title) {
                children.push(
                    new Paragraph({
                        text: title,
                        heading: HeadingLevel.TITLE,
                        alignment: AlignmentType.CENTER,
                        spacing: { after: 240 },
                    }),
                );
            }

            for (const item of paragraphs) {
                children.push(buildParagraph(item));
            }

            const doc = new Document({
                numbering: DEFAULT_NUMBERING,
                creator: "docx-generate (MCP)",
                sections: [{ children }],
            });
            const buf = await Packer.toBuffer(doc);
            return { content: [{ type: "text", text: okResult(buf, "document.docx", params.savePath) }] };
        }),
);

server.tool(
    "docx-generate-table",
    "生成以表格为主的 Word 文档（.docx）。输入二维字符串数据（可选表头行 + 数据行），可选每列宽度百分比与单元格对齐方式；表头自动加粗并标记为表格表头（跨页重复）。返回 JSON，其中 base64 字段为 .docx 文件内容。适合：数据报表、对比表、结构化清单、批量数据展示。",
    {
        savePath: z.string().optional().describe("落盘路径(相对工作区,如 out/doc.docx);给了就写文件、返回 savedTo 且不回传 base64——推荐,二进制不过对话上下文"),
        title: z
            .string()
            .optional()
            .describe("表格上方的文档标题（居中）。不传则只有表格。"),
        headerRow: z
            .array(z.string())
            .optional()
            .describe("表头行：每列标题文本。提供后首行加粗并标记为表头。"),
        rows: z
            .array(z.array(z.string()))
            .min(1)
            .describe("数据行：每行是一个字符串数组。行内列数不能超过表头列数（若提供表头）；未提供表头时按最长行补齐。"),
        columnWidths: z
            .array(z.number().min(1).max(100))
            .optional()
            .describe("每列宽度（百分比，总和建议不超过 100）。不传则自动均分。"),
        alignment: z
            .enum(["left", "center", "right", "justified"])
            .optional()
            .describe("单元格内容对齐方式，默认 left。"),
    },
    async (params) =>
        safe(async () => {
            const { title, headerRow = [], rows, columnWidths, alignment } = params;

            const maxCols = Math.max(headerRow.length, ...rows.map((r) => r.length));
            if (maxCols === 0) {
                return {
                    content: [{ type: "text", text: errResult("rows 为空或所有行都为空，无法生成表格") }],
                };
            }
            if (headerRow.length > 0 && rows.some((r) => r.length > headerRow.length)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: errResult(
                                `存在数据行的列数(${Math.max(...rows.map((r) => r.length))})超过表头列数(${headerRow.length})，请对齐列数`,
                            ),
                        },
                    ],
                };
            }
            if (columnWidths && columnWidths.length !== maxCols) {
                return {
                    content: [
                        {
                            type: "text",
                            text: errResult(`columnWidths 长度(${columnWidths.length})必须等于表格列数(${maxCols})`),
                        },
                    ],
                };
            }

            const pad = (arr) => {
                const out = [...arr];
                while (out.length < maxCols) out.push("");
                return out;
            };

            const cellParagraph = (text, opts = {}) =>
                new Paragraph({
                    alignment: alignment ? ALIGNMENTS[alignment] : AlignmentType.LEFT,
                    children: [
                        new TextRun({
                            text,
                            bold: opts.bold ?? false,
                            italics: opts.italic ?? false,
                        }),
                    ],
                });

            const makeCell = (text, colIdx, opts = {}) =>
                new TableCell({
                    ...(columnWidths
                        ? { width: { size: columnWidths[colIdx], type: WidthType.PERCENTAGE } }
                        : {}),
                    children: [cellParagraph(text, opts)],
                });

            const tableRows = [];
            if (headerRow.length > 0) {
                tableRows.push(
                    new TableRow({
                        tableHeader: true,
                        children: headerRow.map((h, i) => makeCell(h, i, { bold: true })),
                    }),
                );
            }
            for (const row of rows) {
                tableRows.push(
                    new TableRow({
                        children: pad(row).map((cell, i) => makeCell(cell, i)),
                    }),
                );
            }

            const children = [];
            if (title) {
                children.push(
                    new Paragraph({
                        text: title,
                        heading: HeadingLevel.TITLE,
                        alignment: AlignmentType.CENTER,
                        spacing: { after: 240 },
                    }),
                );
            }
            children.push(
                new Table({
                    width: { size: 100, type: WidthType.PERCENTAGE },
                    rows: tableRows,
                }),
            );

            const doc = new Document({
                creator: "docx-generate (MCP)",
                sections: [{ children }],
            });
            const buf = await Packer.toBuffer(doc);
            return { content: [{ type: "text", text: okResult(buf, "table.docx", params.savePath) }] };
        }),
);

server.tool(
    "docx-patch-document",
    "就地修补一个已有的 .docx（模板填充 / 邮件合并）：输入 base64 编码的 .docx，给出 patches 映射——每个 key 对应文档中的占位符 token（形如 {{key}}，key 不带花括号）；type=paragraph 时用指定段落替换文档中的该 token；type=document 时把指定段落追加到文档末尾。返回修补后的 base64 .docx。典型用途：用真实数据填充 Word 模板中的 {{name}}、{{date}} 等占位符。",
    {
        inputBase64: z.string().optional().describe("要修补的 .docx 的 base64(与 inputPath 二选一;体积大,优先用 inputPath)。"),
        inputPath: z.string().optional().describe("要修补的 .docx 的工作区内路径(与 inputBase64 二选一,推荐)。"),
        savePath: z.string().optional().describe("落盘路径(相对工作区,如 out/doc.docx);给了就写文件、返回 savedTo 且不回传 base64——推荐,二进制不过对话上下文"),
        patches: z
            .record(
                z.object({
                    type: z
                        .enum(["paragraph", "document"])
                        .describe("paragraph=把该 key 的占位符（文档中的 {{key}}）替换为 children 段落；document=把 children 段落追加到文档末尾。"),
                    children: z
                        .array(
                            z.object({
                                text: z.string().describe("文本内容。"),
                                type: z
                                    .enum(["body", "heading1", "heading2", "heading3", "bullet", "numbered"])
                                    .optional()
                                    .describe("段落类型，默认 body。"),
                                bold: z.boolean().optional().describe("是否加粗。"),
                                italic: z.boolean().optional().describe("是否斜体。"),
                                alignment: z
                                    .enum(["left", "center", "right", "justified"])
                                    .optional()
                                    .describe("对齐方式，默认 left。"),
                            }),
                        )
                        .min(1)
                        .describe("要注入的段落列表（至少 1 段）。"),
                }),
            )
            .refine((v) => Object.keys(v).length >= 1, { message: "patches 至少需要 1 个补丁 key" })
            .describe("补丁映射：key 为占位符 token 名（对应文档中的 {{key}}，key 不带花括号）。"),
        keepOriginalStyles: z
            .boolean()
            .optional()
            .describe("是否尽量保留原文档样式（默认 true）。"),
    },
    async (params) =>
        safe(async () => {
            const { inputBase64, inputPath, patches, keepOriginalStyles } = params;
            if ((inputBase64 === undefined) === (inputPath === undefined)) {
                throw new Error("inputBase64 与 inputPath 必须且只能给一个");
            }

            let inputBuffer;
            try {
                inputBuffer = inputPath !== undefined
                    ? (() => {
                        const root = PART_WORKDIR;
                        const t = nodePath.resolve(root, inputPath);
                        if (t !== root && !t.startsWith(root + nodePath.sep)) throw new Error(`inputPath 越出工作区: ${inputPath}`);
                        return readFileSyncFs(t);
                    })()
                    : Buffer.from(inputBase64, "base64");
            } catch {
                return {
                    content: [{ type: "text", text: errResult("inputBase64 不是合法的 base64 字符串") }],
                };
            }
            if (inputBuffer.length === 0) {
                return {
                    content: [{ type: "text", text: errResult("inputBase64 解码后为空，请提供有效的 .docx 内容") }],
                };
            }

            const patchMap = {};
            for (const [key, patch] of Object.entries(patches)) {
                if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: errResult(
                                    `patch key "${key}" 含非法字符：仅允许字母/数字/下划线/点/横线（对应文档中的 {{${key}}} 占位符）`,
                                ),
                            },
                        ],
                    };
                }
                const children = patch.children.map((item) => buildParagraph(item));
                patchMap[key] =
                    patch.type === "document"
                        ? { type: PatchType.DOCUMENT, children }
                        : { type: PatchType.PARAGRAPH, children };
            }

            const patched = await patchDocument(inputBuffer, {
                patches: patchMap,
                keepOriginalStyles: keepOriginalStyles ?? true,
            });

            const buf = Buffer.from(patched);
            return { content: [{ type: "text", text: okResult(buf, "patched.docx", params.savePath) }] };
        }),
);

// ---------------------------------------------------------------------------
// Transport: stdio; keep stdout exclusively for the MCP protocol.
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
log("server ready on stdio");

// Clean exit when stdin closes (e.g. parent process terminates).
process.stdin.on("end", async () => {
    log("stdin closed, shutting down");
    try {
        await server.close();
    } catch {
        /* ignore */
    }
    process.exit(0);
});
