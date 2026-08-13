// smoke.mjs — MCP stdio smoke test for @dsh-index/number-format
// Connects a real MCP client to `node index.js`, lists tools, exercises
// format/unformat roundtrip, arithmetic, validation, and missing-param handling.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function textOf(result) {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -> ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const transport = new StdioClientTransport({ command: 'node', args: ['index.js'] });
const client = new Client({ name: 'number-format-smoke', version: '0.0.1' });
await client.connect(transport);

// 1) listTools
const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
console.log('LIST_TOOLS:', JSON.stringify(names));
check('listTools returns 4 tools', names.length === 4, names.join(', '));
check('all expected tools present',
  ['format-number', 'unformat-number', 'arithmetic', 'validate-number'].every((n) => names.includes(n)),
  JSON.stringify(names));

// 2) real tool roundtrips
const fmt = await client.callTool({ name: 'format-number', arguments: { value: 1000, format: '0,0' } });
const fmtText = textOf(fmt);
console.log('FORMAT 1000 "0,0" ->', JSON.stringify(fmt));
check('format 1000 -> "1,000"', fmtText === '1,000', fmtText);

const unfmt = await client.callTool({ name: 'unformat-number', arguments: { input: '1,000' } });
const unfmtText = textOf(unfmt);
console.log('UNFORMAT "1,000" ->', JSON.stringify(unfmt));
check('unformat "1,000" -> 1000', unfmtText === '1000', unfmtText);
check('format->unformat roundtrip consistent', fmtText === '1,000' && unfmtText === '1000', `${fmtText} <-> ${unfmtText}`);

// extra capability probes
const pct = await client.callTool({ name: 'format-number', arguments: { value: 0.5, format: '0%' } });
console.log('FORMAT 0.5 "0%" ->', JSON.stringify(pct));
check('format 0.5 as percent -> "50%"', textOf(pct) === '50%', textOf(pct));

const cur = await client.callTool({ name: 'format-number', arguments: { value: 1234.5, format: '$0,0.00' } });
console.log('FORMAT 1234.5 "$0,0.00" ->', JSON.stringify(cur));
check('format currency -> "$1,234.50"', textOf(cur) === '$1,234.50', textOf(cur));

const arith = await client.callTool({ name: 'arithmetic', arguments: { operation: 'add', a: 0.1, b: 0.2 } });
console.log('ARITH 0.1+0.2 ->', JSON.stringify(arith));
check('arithmetic add 0.1+0.2 -> 0.3 (float-safe)', textOf(arith) === '0.3', textOf(arith));

const val = await client.callTool({ name: 'validate-number', arguments: { input: '1,234.56' } });
console.log('VALIDATE "1,234.56" ->', JSON.stringify(val));
check('validate "1,234.56" -> valid true', textOf(val) === JSON.stringify({ valid: true, input: '1,234.56', value: 1234.56 }), textOf(val));

const bad = await client.callTool({ name: 'unformat-number', arguments: { input: 'not-a-number' } });
console.log('UNFORMAT "not-a-number" ->', JSON.stringify(bad));
check('unformat garbage -> "error:" text', textOf(bad).startsWith('error:'), textOf(bad));

// 3) missing required param -> SDK returns isError result
const missing = await client.callTool({ name: 'unformat-number', arguments: {} });
console.log('MISSING REQUIRED PARAM ->', JSON.stringify(missing));
const missingIsError = missing && (missing.isError === true || /error/i.test(textOf(missing)));
check('missing required param yields error result', missingIsError, JSON.stringify(missing));

await client.close();
console.log(failures === 0 ? 'SMOKE_OK' : `SMOKE_FAILED (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
