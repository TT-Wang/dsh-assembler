// @dsh-index/number-format
// MCP stdio server exposing numeral.js v2.0.6 (MIT) number capabilities:
//   format-number   - format a value with a numeral.js format string
//   unformat-number - parse a formatted string back into a number
//   arithmetic      - float-safe add/subtract/multiply/divide/difference
//   validate-number - check whether a string is a valid numeral-formatted number
//
// Upstream: adamwdraper/Numeral-js @ tag 2.0.6 (npm: numeral@2.0.6), MIT.
// API verification: npm numeral@2.0.6 (main ./numeral.js) matches the git tag 2.0.6 source.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import numeral from 'numeral';

const server = new McpServer({ name: 'number-format', version: '0.0.1' });

/**
 * Parse a value (number or string) into a plain number via numeral.
 * Returns null when the value cannot be parsed (e.g. NaN or non-numeric string).
 */
function toNumber(value) {
  return numeral(value).value();
}

server.tool(
  'format-number',
  'Format a number into a human-readable string using a numeral.js v2.0.6 format string. ' +
    '`value` may be a JSON number or a string numeral can parse first (e.g. "1,000" -> 1000, "50%" -> 0.5, "$1,234.56" -> 1234.56, "1.5MB" -> 1500000). ' +
    'Common format strings: "0,0" thousands separators (1000 -> "1,000"); "0,0.00" fixed decimals (1000 -> "1,000.00"); ' +
    '"$0,0.00" currency with the current locale symbol, default $ ("$1,000.00"); "0%" percentage, value scaled by 100 (0.5 -> "50%"); ' +
    '"0a" abbreviations k/m/b/t (1500 -> "2k"); "0o" ordinals (1 -> "1st"); "0.00e+0" exponential (1234 -> "1.23e+3"); ' +
    '"0b" bytes base-1000 (1500000 -> "1.5MB") and "0ib" bytes base-1024; "00:00:00" hours:minutes:seconds (3661 -> "01:01:01"); ' +
    '"0BPS" basis points, value scaled by 10000 (0.005 -> "50BPS"); "0000" leading zeros (12 -> "0012"). ' +
    '`rounding` selects Math.round (default), Math.floor, or Math.ceil applied to the formatted result. ' +
    'Returns the formatted string as plain text, or a message prefixed with "error:" when the value cannot be parsed.',
  {
    value: z.union([z.number(), z.string()]).describe('The number to format, or a numeral-parseable numeric string (e.g. "1,000", "50%", "$1,234.56").'),
    format: z.string().default('0,0').describe('numeral.js format string; see the tool description for the grammar. Defaults to "0,0".'),
    rounding: z.enum(['round', 'floor', 'ceil']).default('round').describe('Rounding mode applied to the formatted result. Defaults to "round".')
  },
  async ({ value, format, rounding }) => {
    try {
      const n = toNumber(value);
      if (n === null || Number.isNaN(n)) {
        return { content: [{ type: 'text', text: `error: cannot parse "${String(value)}" as a number` }] };
      }
      const roundFn = rounding === 'floor' ? Math.floor : rounding === 'ceil' ? Math.ceil : Math.round;
      return { content: [{ type: 'text', text: numeral(n).format(format, roundFn) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
);

server.tool(
  'unformat-number',
  'Parse a human-formatted number string back into a plain numeric value using numeral.js v2.0.6 — the inverse of format-number. ' +
    'Examples: "1,000" -> 1000; "$1,234.56" -> 1234.56; "50%" -> 0.5; "1.5MB" -> 1500000; "2k" -> 2000; "1st" -> 1; "01:01:01" -> 3661; "50BPS" -> 0.005. ' +
    'Returns the numeric value as plain text (e.g. "1000"), or a message prefixed with "error:" when the string contains no parseable number.',
  {
    input: z.string().describe('The formatted number string to parse (e.g. "1,000", "$12.50", "50%", "1.5MB"). Empty or non-numeric strings yield an error result.')
  },
  async ({ input }) => {
    try {
      const value = numeral(input).value();
      if (value === null || Number.isNaN(value)) {
        return { content: [{ type: 'text', text: `error: cannot parse "${input}" as a number` }] };
      }
      return { content: [{ type: 'text', text: String(value) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
);

server.tool(
  'arithmetic',
  'Perform float-safe arithmetic between two numbers using numeral.js v2.0.6 (intermediate values are rounded by a correction factor to avoid JavaScript floating-point drift). ' +
    'Operations: add (a+b), subtract (a-b), multiply (a*b), divide (a/b), difference (absolute value of a-b). ' +
    'Examples: add(0.1, 0.2) -> 0.3 (not 0.30000000000000004); multiply(1.005, 100) -> 100.5; difference(5, 8) -> 3. ' +
    'Returns the numeric result as plain text, or a message prefixed with "error:" (division by zero is rejected).',
  {
    operation: z.enum(['add', 'subtract', 'multiply', 'divide', 'difference']).describe('Arithmetic operation to apply to a and b.'),
    a: z.number().describe('First operand.'),
    b: z.number().describe('Second operand.')
  },
  async ({ operation, a, b }) => {
    try {
      if (operation === 'divide' && b === 0) {
        return { content: [{ type: 'text', text: 'error: division by zero (result would be Infinity)' }] };
      }
      const result = numeral(a)[operation](b).value();
      return { content: [{ type: 'text', text: String(result) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
);

server.tool(
  'validate-number',
  'Check whether a string is a valid numeral-formatted number using numeral.js v2.0.6 numeral.validate(). ' +
    'Accepts plain digit strings ("123"), thousands separators with decimals ("1,234.56"), an optional currency symbol prefix ("$1,234.56"), and abbreviation suffixes ("1.5m"). ' +
    'Caveat: percentage ("50%"), byte ("1.5MB") and time ("01:01:01") strings are NOT considered valid by numeral.validate even though unformat-number parses them — use unformat-number for those. ' +
    'Returns JSON text of the form {"valid": boolean, "input": string, "value": number|null}, where value is the parsed number when valid, else null.',
  {
    input: z.string().describe('The string to validate (e.g. "123", "1,234.56", "$50", "1.5m").')
  },
  async ({ input }) => {
    try {
      const valid = numeral.validate(input);
      const value = valid ? numeral(input).value() : null;
      return { content: [{ type: 'text', text: JSON.stringify({ valid, input, value }) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
