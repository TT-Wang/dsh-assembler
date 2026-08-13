/**
 * Smoke test for @dsh-index/csv-parse MCP stdio server.
 * Connects a real MCP client, lists tools, and exercises every tool
 * (one real parse round-trip, one missing-required-param validation path).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

function textOf(result) {
  const t = result && result.content && result.content[0]
  return t ? t.text : JSON.stringify(result)
}

const transport = new StdioClientTransport({ command: 'node', args: ['index.js'] })
const client = new Client({ name: 'csv-parse-smoke', version: '0.0.1' })
await client.connect(transport)

const { tools } = await client.listTools()
console.log(`TOOLS (${tools.length}):`)
for (const t of tools) console.log(`- ${t.name}: ${(t.description || '').slice(0, 80)}...`)
console.log('---')

// 1) parse-csv: real call with header + dynamic typing
const r1 = await client.callTool({
  name: 'parse-csv',
  arguments: { csv: 'name,age,city\nAlice,30,Tokyo\nBob,25,Osaka', header: true, dynamicTyping: true },
})
console.log('parse-csv (typed objects):')
console.log(textOf(r1))
console.log('---')

// 2) unparse-csv: serialize objects back to CSV (round-trip half)
const r2 = await client.callTool({
  name: 'unparse-csv',
  arguments: { data: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }] },
})
console.log('unparse-csv:')
console.log(textOf(r2))
console.log('---')

// 3) parse-csv: missing required param -> schema validation error must come back as text
const r3 = await client.callTool({ name: 'parse-csv', arguments: {} })
console.log('parse-csv (missing csv -> validation error):')
console.log(textOf(r3))
console.log('---')

// 4) validate-csv: well-formed input
const r4 = await client.callTool({ name: 'validate-csv', arguments: { csv: 'a,b\n1,2\n' } })
console.log('validate-csv (ok):')
console.log(textOf(r4))
console.log('---')

// 5) validate-csv: malformed input (unterminated quote) must report invalid
const r5 = await client.callTool({ name: 'validate-csv', arguments: { csv: 'a,b\n"oops,2\n' } })
console.log('validate-csv (malformed):')
console.log(textOf(r5))
console.log('---')

// 6) unparse-csv: bad type -> clear error
const r6 = await client.callTool({ name: 'unparse-csv', arguments: { data: 42 } })
console.log('unparse-csv (number data):')
console.log(textOf(r6))

await client.close()
console.log('SMOKE DONE')
