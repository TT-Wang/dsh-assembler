/**
 * @dsh-index/csv-parse — MCP stdio server wrapping papaparse 5.4.1.
 *
 * Tools (exposed to the dsh mcp-client as mcp__csv-parse__<toolname>):
 *   - parse-csv      : CSV text -> JSON (rows as objects or arrays) + parse errors + meta
 *   - unparse-csv    : JSON data -> CSV text (inverse of parse-csv)
 *   - validate-csv   : well-formedness check + delimiter/line-ending detection + error summary
 *
 * papaparse is a pure-JS, dependency-free parser; all parsing is synchronous
 * in-process, so these tools work offline with no external services.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import Papa from 'papaparse'

const server = new McpServer({
  name: 'csv-parse',
  version: '0.0.1',
  instructions:
    'CSV parsing and generation powered by papaparse 5.4.1. ' +
    'Use parse-csv to convert CSV text into JSON rows, unparse-csv to serialize JSON back to CSV, ' +
    'and validate-csv to cheaply check well-formedness and detect the delimiter.',
})

/** Standard MCP text result. */
function ok(text) {
  return { content: [{ type: 'text', text }] }
}

/** Standard MCP error result (returned, not thrown, so the client always gets a readable message). */
function fail(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}

function errText(err) {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Tool 1: parse-csv
// ---------------------------------------------------------------------------
server.tool(
  'parse-csv',
  'Parse CSV text into structured JSON using papaparse. Returns {data, errors, meta}: ' +
    'data is an array of rows (objects when header=true, arrays when header=false), ' +
    'errors lists row-level parse problems (e.g. unterminated quotes), and meta reports the ' +
    'detected delimiter, line ending and field names. ' +
    'Function-valued papaparse options (transform, transformHeader, dynamicTyping functions) ' +
    'cannot cross the MCP boundary and are not exposed.',
  {
    csv: z.string().min(1, 'csv must be a non-empty string').describe('The CSV text to parse (required).'),
    header: z
      .boolean()
      .optional()
      .describe('Use the first row as column names so rows become objects. Default: true. Set false to get arrays of arrays.'),
    delimiter: z
      .string()
      .optional()
      .describe('Field delimiter, e.g. "," or "\\t". Default: auto-detected from the input.'),
    dynamicTyping: z
      .boolean()
      .optional()
      .describe('Convert numeric, boolean and empty string fields to native JS types. Default: false (all values stay strings).'),
    skipEmptyLines: z
      .union([z.boolean(), z.literal('greedy')])
      .optional()
      .describe('Skip empty lines: true (blank lines), false (keep), or "greedy" (also skip lines that are all whitespace). Default: false.'),
    newline: z
      .string()
      .optional()
      .describe('Line ending used to split rows, e.g. "\\n" or "\\r\\n". Default: auto-detected.'),
    comments: z
      .string()
      .optional()
      .describe('A single character that marks comment rows to skip, e.g. "#". Default: none.'),
    quoteChar: z
      .string()
      .optional()
      .describe('Character used to quote fields. Default: \'"\'.'),
    preview: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Only parse the first N data rows (useful for large inputs). Default: parse the whole input.'),
  },
  async ({ csv, header, delimiter, dynamicTyping, skipEmptyLines, newline, comments, quoteChar, preview }) => {
    try {
      const config = {
        header: header ?? true,
        dynamicTyping: dynamicTyping ?? false,
        skipEmptyLines: skipEmptyLines ?? false,
      }
      if (delimiter !== undefined) config.delimiter = delimiter
      if (newline !== undefined) config.newline = newline
      if (comments !== undefined) config.comments = comments
      if (quoteChar !== undefined) config.quoteChar = quoteChar
      if (preview !== undefined) config.preview = preview
      const result = Papa.parse(csv, config)
      return ok(JSON.stringify(result, null, 2))
    } catch (err) {
      return fail(`parse-csv failed: ${errText(err)}`)
    }
  }
)

// ---------------------------------------------------------------------------
// Tool 2: unparse-csv
// ---------------------------------------------------------------------------
server.tool(
  'unparse-csv',
  'Serialize JSON data into a CSV string using papaparse — the inverse of parse-csv. ' +
    'Accepts an array of objects (object keys become the header row), an array of arrays ' +
    '(each inner array is one row), an array of strings (single column), or a single string ' +
    '(one cell). Returns the CSV text.',
  {
    data: z
      .any()
      .describe('The data to serialize (required): an array of objects, an array of arrays, an array of strings, or a string.'),
    delimiter: z.string().optional().describe('Field delimiter. Default: ",".'),
    newline: z.string().optional().describe('Line ending. Default: "\\r\\n".'),
    header: z
      .boolean()
      .optional()
      .describe('Write a header row with the object keys when data is an array of objects. Default: true.'),
    columns: z
      .array(z.string())
      .optional()
      .describe('For array-of-objects input: the keys to write and their column order. Default: all keys in first-object order.'),
    quotes: z
      .boolean()
      .optional()
      .describe('Wrap every field in double quotes in the output. Default: false (fields are quoted only when needed).'),
    skipEmptyLines: z.boolean().optional().describe('Skip empty lines in the output. Default: false.'),
  },
  async ({ data, delimiter, newline, header, columns, quotes, skipEmptyLines }) => {
    try {
      if (data === null || data === undefined) {
        return fail('unparse-csv: "data" is required — pass an array of objects/arrays/strings or a string.')
      }
      if (typeof data === 'object' && !Array.isArray(data)) {
        // Single object: papaparse treats it as a one-row table; wrap for clarity.
        data = [data]
      }
      const config = {}
      if (delimiter !== undefined) config.delimiter = delimiter
      if (newline !== undefined) config.newline = newline
      if (header !== undefined) config.header = header
      if (columns !== undefined) config.columns = columns
      if (quotes !== undefined) config.quotes = quotes
      if (skipEmptyLines !== undefined) config.skipEmptyLines = skipEmptyLines
      const csv = Papa.unparse(data, config)
      return ok(csv)
    } catch (err) {
      return fail(`unparse-csv failed: ${errText(err)}`)
    }
  }
)

// ---------------------------------------------------------------------------
// Tool 3: validate-csv
// ---------------------------------------------------------------------------
server.tool(
  'validate-csv',
  'Check whether CSV text is well-formed without extracting its data. Parses with header=false and ' +
    'returns a summary: valid (no parse errors), detected delimiter, detected line ending, row count, ' +
    'field count of the first row, and the list of parse errors (e.g. unterminated quotes). ' +
    'Useful as a cheap pre-check before parse-csv, or to discover the delimiter of an unknown file.',
  {
    csv: z.string().min(1, 'csv must be a non-empty string').describe('The CSV text to validate (required).'),
    delimiter: z
      .string()
      .optional()
      .describe('Field delimiter to assume. Default: auto-detected from the input.'),
  },
  async ({ csv, delimiter }) => {
    try {
      const config = { header: false, skipEmptyLines: 'greedy' }
      if (delimiter !== undefined) config.delimiter = delimiter
      const result = Papa.parse(csv, config)
      const firstRow = Array.isArray(result.data) && result.data.length > 0 ? result.data[0] : []
      const summary = {
        valid: result.errors.length === 0,
        delimiter: result.meta.delimiter,
        linebreak: result.meta.linebreak,
        rowCount: result.data.length,
        fieldCount: Array.isArray(firstRow) ? firstRow.length : 0,
        errors: result.errors,
      }
      return ok(JSON.stringify(summary, null, 2))
    } catch (err) {
      return fail(`validate-csv failed: ${errText(err)}`)
    }
  }
)

// ---------------------------------------------------------------------------
// Connect over stdio
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport()
await server.connect(transport)
