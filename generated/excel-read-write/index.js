// MCP stdio server wrapping exceljs 4.4.0 (MIT) — capability id: excel-read-write
// Tools: read-xlsx-file, write-xlsx-file, read-csv-file, write-csv-file
//
// Runs as: node index.js   (stdio transport, JSON-RPC over stdin/stdout)
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// 路径锚点:相对路径解析进 PART_WORKDIR(发射端注入的 preset 工作区),不是零件 cwd。
const PART_WORKDIR = process.env.PART_WORKDIR || process.cwd();
const anchorPath = (p) => path.resolve(PART_WORKDIR, String(p));
import ExcelJS from 'exceljs';

const { Workbook, ValueType } = ExcelJS;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Normalize a single cell into a JSON-safe scalar (or small object):
//   null for empty cells; numbers/strings/booleans as-is; dates -> ISO string;
//   formula cells -> cached result, or "=formula" text when no cached result;
//   hyperlink cells -> display text; error cells -> error code string.
function normalizeCell(cell) {
  if (!cell) return null;
  const raw = cell.value;
  if (raw === null || raw === undefined) return null;
  switch (cell.type) {
    case ValueType.Number:
      return typeof raw === 'number' ? raw : Number(raw);
    case ValueType.String:
      return String(raw);
    case ValueType.Boolean:
      return Boolean(raw);
    case ValueType.Date:
      return raw instanceof Date ? raw.toISOString() : new Date(raw).toISOString();
    case ValueType.Hyperlink:
      return raw && typeof raw === 'object' ? String(raw.text || raw.hyperlink || '') : String(raw);
    case ValueType.Formula:
      if (raw && raw.result !== null && raw.result !== undefined) return normalizeCell({ type: cell.resultType || ValueType.String, value: raw.result });
      return raw && typeof raw === 'object' ? `=${raw.formula || ''}` : String(raw);
    case ValueType.Error:
      return raw && typeof raw === 'object' ? String(raw.error || '') : String(raw);
    case ValueType.RichText:
      return raw && typeof raw === 'object' && Array.isArray(raw.richText)
        ? raw.richText.map((p) => p && p.text).join('')
        : String(raw);
    default:
      if (typeof raw === 'object') {
        try { return JSON.stringify(raw); } catch { return String(raw); }
      }
      return raw;
  }
}

// "A1:C5" -> {rowStart,rowEnd,colStart,colEnd}; open-ended when no range given.
function parseRange(ws, cellRange) {
  const rowStart = 1;
  const rowEnd = ws.actualRowCount || 0;
  const colStart = 1;
  const colEnd = ws.columnCount || 1;
  if (!cellRange) return { rowStart, rowEnd, colStart, colEnd };
  const m = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(String(cellRange).trim());
  if (!m) throw new Error(`Invalid cellRange "${cellRange}" — expected e.g. "A1" or "B2:D10"`);
  const colLettersToNumber = (letters) => {
    let n = 0;
    for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
  };
  const c1 = colLettersToNumber(m[1]);
  const r1 = parseInt(m[2], 10);
  const c2 = m[3] ? colLettersToNumber(m[3]) : c1;
  const r2 = m[4] ? parseInt(m[4], 10) : r1;
  if (r1 < 1 || c1 < 1 || r2 < r1 || c2 < c1) {
    throw new Error(`Invalid cellRange "${cellRange}" — columns/rows must be positive and ordered`);
  }
  return { rowStart: r1, rowEnd: r2, colStart: c1, colEnd: c2 };
}

// Read one worksheet into a 2D array of normalized values.
function readSheet(ws, cellRange) {
  const { rowStart, rowEnd, colStart, colEnd } = parseRange(ws, cellRange);
  const data = [];
  for (let r = rowStart; r <= rowEnd; r++) {
    const row = ws.getRow(r);
    const cells = [];
    for (let c = colStart; c <= colEnd; c++) {
      cells.push(normalizeCell(row.getCell(c)));
    }
    data.push(cells);
  }
  return {
    name: ws.name,
    rowStart,
    rowEnd,
    colStart,
    colEnd,
    rowCount: rowEnd >= rowStart ? rowEnd - rowStart + 1 : 0,
    columnCount: colEnd - colStart + 1,
    data,
  };
}

// Map a JSON value array into exceljs cell values: strings starting with "="
// become formula cells, everything else is stored verbatim.
function toCellValues(rowValues) {
  return (rowValues || []).map((v) => {
    if (typeof v === 'string' && v.startsWith('=') && v.length > 1) {
      return { formula: v.slice(1) };
    }
    return v;
  });
}

function summaryOf(ws) {
  return {
    name: ws.name,
    rowCount: ws.actualRowCount,
    columnCount: ws.columnCount,
  };
}

function ok(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function fail(message) {
  return { content: [{ type: 'text', text: `ERROR: ${message}` }] };
}

// run a tool handler, converting thrown errors into a clean error text result
function guard(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      return fail(err && err.message ? err.message : String(err));
    }
  };
}

// ---------------------------------------------------------------------------
// server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'excel-read-write', version: '0.0.1' });

server.tool(
  'read-xlsx-file',
  'Read an Excel .xlsx file and return its worksheets as JSON row data. ' +
    'Useful for inspecting spreadsheet contents, exported tables, or generated reports. ' +
    'Each worksheet is returned as a 2D array (rows of cells); empty cells are null, ' +
    'numbers/strings/booleans pass through, dates become ISO 8601 strings, formula cells ' +
    'become their cached result (or "=formula" text when no cached result), error cells ' +
    'become their error code (e.g. "#N/A").',
  {
    filePath: z.string().min(1).describe('Absolute or relative path of the .xlsx file to read.'),
    sheetName: z
      .string()
      .optional()
      .describe('Read only this worksheet (by tab name). Omit to read every worksheet.'),
    cellRange: z
      .string()
      .optional()
      .describe('Optional cell range to limit the read, e.g. "A1:C5". Omit to read the full used range.'),
  },
  guard(async ({ filePath, sheetName, cellRange }) => {
    filePath = anchorPath(filePath);
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    const wb = new Workbook();
    await wb.xlsx.readFile(filePath);
    const sheetNames = wb.worksheets.map((w) => w.name);
    const targets = sheetName ? [wb.getWorksheet(sheetName)] : wb.worksheets;
    if (!targets[0]) throw new Error(`Worksheet not found: ${sheetName}`);
    const sheets = targets.map((ws) => readSheet(ws, cellRange));
    return ok({ file: filePath, sheetNames, sheets });
  })
);

server.tool(
  'write-xlsx-file',
  'Create a new Excel .xlsx file (or overwrite an existing one) from row-major JSON data. ' +
    'Accepts one or more worksheets; each worksheet is a 2D array of cell values ' +
    '(strings, numbers, booleans or null for empty cells). A string cell starting with ' +
    '"=" (e.g. "=SUM(A1:A3)") is stored as a live Excel formula. Returns a summary of ' +
    'the written file: path, whether it was overwritten, and per-sheet row/column counts.',
  {
    filePath: z.string().min(1).describe('Path of the .xlsx file to create or overwrite.'),
    overwrite: z
      .boolean()
      .optional()
      .describe('When false, refuse to overwrite an existing file (default true).'),
    sheets: z
      .array(
        z.object({
          name: z.string().min(1).describe('Worksheet (tab) name.'),
          rows: z
            .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
            .describe('Row-major cell data. Strings starting with "=" become formulas.'),
        })
      )
      .min(1)
      .describe('Worksheets to write into the file.'),
  },
  guard(async ({ filePath, overwrite, sheets }) => {
    filePath = anchorPath(filePath);
    const existed = fs.existsSync(filePath);
    if (existed && overwrite === false) {
      throw new Error(`Refusing to overwrite existing file: ${filePath}`);
    }
    const wb = new Workbook();
    const written = [];
    for (const s of sheets) {
      const ws = wb.addWorksheet(s.name);
      for (const rowValues of s.rows || []) {
        ws.addRow(toCellValues(rowValues));
      }
      written.push(summaryOf(ws));
    }
    const dir = path.dirname(path.resolve(filePath));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await wb.xlsx.writeFile(filePath);
    return ok({ file: filePath, overwritten: existed, sheets: written });
  })
);

server.tool(
  'read-csv-file',
  'Read a CSV text file and return its content as JSON row data. ' +
    'Parses the file with fast-csv semantics: numeric-looking values become numbers, ' +
    'ISO-like dates become dates, empty fields become null. Useful for consuming ' +
    'CSV exports or data dumps as structured data.',
  {
    filePath: z.string().min(1).describe('Path of the .csv file to read.'),
    delimiter: z
      .string()
      .length(1)
      .optional()
      .describe('Field delimiter character (default ",").'),
    sheetName: z
      .string()
      .optional()
      .describe('Internal worksheet name for the parsed data (default "Sheet1").'),
  },
  guard(async ({ filePath, delimiter, sheetName }) => {
    filePath = anchorPath(filePath);
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    const wb = new Workbook();
    const parserOptions = delimiter ? { delimiter } : undefined;
    const ws = await wb.csv.readFile(filePath, {
      sheetName: sheetName || 'Sheet1',
      ...(parserOptions ? { parserOptions } : {}),
    });
    return ok({ file: filePath, ...readSheet(ws, undefined) });
  })
);

server.tool(
  'write-csv-file',
  'Write a CSV text file from row-major JSON data. ' +
    'Each inner array is one CSV record; values may be strings, numbers, booleans or ' +
    'null (empty field). The file is written as UTF-8. Returns the written path and ' +
    'the number of rows/columns written.',
  {
    filePath: z.string().min(1).describe('Path of the .csv file to create or overwrite.'),
    rows: z
      .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
      .describe('Row-major data: each inner array becomes one CSV record.'),
    delimiter: z
      .string()
      .length(1)
      .optional()
      .describe('Field delimiter character (default ",").'),
    sheetName: z
      .string()
      .optional()
      .describe('Internal worksheet name for the data (default "Sheet1").'),
  },
  guard(async ({ filePath, rows, delimiter, sheetName }) => {
    filePath = anchorPath(filePath);
    const wb = new Workbook();
    const ws = wb.addWorksheet(sheetName || 'Sheet1');
    for (const rowValues of rows || []) {
      ws.addRow(toCellValues(rowValues));
    }
    const formatterOptions = delimiter ? { delimiter } : undefined;
    await wb.csv.writeFile(filePath, {
      sheetName: ws.name,
      includeEmptyRows: false,
      ...(formatterOptions ? { formatterOptions } : {}),
    });
    return ok({ file: filePath, sheet: ws.name, rowCount: ws.actualRowCount, columnCount: ws.columnCount });
  })
);

// ---------------------------------------------------------------------------
// bootstrap: connect stdio transport, exit cleanly when stdin closes
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
let closed = false;
transport.onclose = async () => {
  if (closed) return; // guard against close() re-entrancy (server.close -> transport.close -> onclose)
  closed = true;
  // Give stdout one more tick to flush pending responses, then exit cleanly.
  setImmediate(() => process.exit(0));
};

// StdioServerTransport.close() is only invoked on parse errors; also shut down
// cleanly when the client closes stdin (normal end of an MCP stdio session).
process.stdin.on('end', () => { void transport.close(); });
process.stdin.on('close', () => { void transport.close(); });

try {
  await server.connect(transport);
} catch (err) {
  console.error(`[excel-read-write] failed to start: ${err && err.message}`);
  process.exit(1);
}
