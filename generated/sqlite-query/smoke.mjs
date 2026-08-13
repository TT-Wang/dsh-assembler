// Smoke test for @dsh-index/sqlite-query: connects via MCP stdio, lists tools,
// then exercises execute/query/list-tables and the argument-validation error paths.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'node', args: ['index.js'] });
const client = new Client({ name: 'sqlite-query-smoke', version: '0.0.1' });

let failures = 0;
const check = (label, ok, detail) => {
	console.log(`${ok ? 'PASS' : 'FAIL'} | ${label} | ${detail}`);
	if (!ok) failures += 1;
};

try {
	await client.connect(transport);

	const { tools } = await client.listTools();
	console.log(`\nlistTools -> ${tools.length} tools:`);
	for (const t of tools) console.log(`  - ${t.name}: ${String(t.description).split('\n')[0]}`);
	check('listTools', tools.length === 3, `expected 3 tools, got ${tools.length}`);

	// 1) execute: DDL (no params)
	let r = await client.callTool({
		name: 'execute',
		arguments: { sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)' },
	});
	check('execute CREATE TABLE', r.content[0].text.includes('"changes": 0'), r.content[0].text);

	// 2) execute: INSERT with positional params
	r = await client.callTool({
		name: 'execute',
		arguments: { sql: 'INSERT INTO users (name, age) VALUES (?, ?)', params: ['Alice', 30] },
	});
	check('execute INSERT with params', r.content[0].text.includes('"changes": 1') && r.content[0].text.includes('"lastInsertRowid": 1'), r.content[0].text);

	// 3) query: SELECT with params, reusing the same in-memory db
	r = await client.callTool({
		name: 'query',
		arguments: { sql: 'SELECT * FROM users WHERE age >= ? ORDER BY id', params: [25] },
	});
	check('query SELECT with params', r.content[0].text.includes('"name": "Alice"'), r.content[0].text);

	// 4) list-tables
	r = await client.callTool({ name: 'list-tables', arguments: {} });
	check('list-tables', r.content[0].text.includes('"name": "users"'), r.content[0].text);

	// 5) missing sql -> handler validation error text
	r = await client.callTool({ name: 'query', arguments: {} });
	check('query missing sql -> error', r.content[0].text.startsWith('错误:'), r.content[0].text);

	// 6) params not an array -> handler validation error text
	try {
		r = await client.callTool({ name: 'query', arguments: { sql: 'SELECT 1', params: 'nope' } });
		check('query bad params -> error', r.content[0].text.startsWith('错误:'), r.content[0].text);
	} catch (e) {
		check('query bad params -> error', true, `rejected at SDK boundary: ${e.message}`);
	}

	// 7) bad sql -> sqlite error surfaced as text
	r = await client.callTool({ name: 'query', arguments: { sql: 'SELECT * FROM no_such_table' } });
	check('query bad sql -> error', r.content[0].text.startsWith('错误:'), r.content[0].text);

	await client.close();
} catch (e) {
	console.error('SMOKE CRASHED:', e);
	failures += 1;
} finally {
	try {
		await transport.close();
	} catch {
		/* ignore */
	}
}

console.log(`\n${failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures} failure(s))`}`);
process.exit(failures === 0 ? 0 : 1);
