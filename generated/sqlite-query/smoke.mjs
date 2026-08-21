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

	// ── 批量接口（v0.0.2）：治"逐条 roundtrip"的实测病 ──────────────────────
	// 8) execute 多语句脚本：建表 + 3 行写入一次完成，changes 报合计
	r = await client.callTool({
		name: 'execute',
		arguments: {
			sql: "CREATE TABLE scans (id INTEGER PRIMARY KEY, pkg TEXT, vulns INTEGER);\n" +
				"INSERT INTO scans (pkg, vulns) VALUES ('express', 2);\n" +
				"INSERT INTO scans (pkg, vulns) VALUES ('lodash', 1);\n" +
				"INSERT INTO scans (pkg, vulns) VALUES ('dayjs', 0);",
		},
	});
	check('execute 多语句脚本一次完成', r.content[0].text.includes('"script": true') && r.content[0].text.includes('"changes": 3'), r.content[0].text);

	// 9) 脚本原子性：中间一条撞唯一键 → 整个脚本回滚，前面的 INSERT 不落库
	r = await client.callTool({
		name: 'execute',
		arguments: {
			sql: "INSERT INTO scans (pkg, vulns) VALUES ('should-roll-back', 9);\n" +
				"INSERT INTO scans (id, pkg, vulns) VALUES (1, 'dup-id', 0);",
		},
	});
	check('脚本中途失败返回错误', r.content[0].text.startsWith('错误:'), r.content[0].text);
	r = await client.callTool({ name: 'query', arguments: { sql: "SELECT COUNT(*) AS n FROM scans" } });
	check('失败脚本整体回滚（行数仍为 3）', r.content[0].text.includes('"n": 3'), r.content[0].text);

	// 10) 脚本带 params → 明确拒绝并指路
	r = await client.callTool({
		name: 'execute',
		arguments: { sql: "INSERT INTO scans (pkg) VALUES (?); INSERT INTO scans (pkg) VALUES (?);", params: ['a', 'b'] },
	});
	check('多语句 + params -> 拒绝并说明', r.content[0].text.startsWith('错误:') && r.content[0].text.includes('params'), r.content[0].text);

	// 11) query 批量：两条查询一次调用，结果同序
	r = await client.callTool({
		name: 'query',
		arguments: { sqls: ["SELECT COUNT(*) AS n FROM scans", "SELECT pkg FROM scans WHERE vulns = 0"] },
	});
	check('query sqls 批量同序返回', (() => {
		try {
			const out = JSON.parse(r.content[0].text);
			return Array.isArray(out) && out.length === 2 && out[0].rows[0].n === 3 && out[1].rows[0].pkg === 'dayjs';
		} catch { return false; }
	})(), r.content[0].text.slice(0, 200));

	// 12) query 批量第 2 条坏 → 报错点名下标
	r = await client.callTool({ name: 'query', arguments: { sqls: ["SELECT 1 AS ok", "SELECT * FROM no_such"] } });
	check('批量错误点名 sqls[1]', r.content[0].text.startsWith('错误:') && r.content[0].text.includes('sqls[1]'), r.content[0].text);

	// 13) 单条语句路径回归不变（老契约字节级同型）
	r = await client.callTool({ name: 'execute', arguments: { sql: 'DELETE FROM scans WHERE pkg = ?', params: ['express'] } });
	check('单条 + params 契约不变', r.content[0].text.includes('"changes": 1'), r.content[0].text);

	await client.close();

	// ── 装备槽（v0.0.3）：SQLITE_INIT_DDL_FILE 预建 schema ─────────────────
	// 单独 spawn 一个带 env 的 server 实例：开库即有表、二库同建（幂等）、坏 DDL 报清楚。
	{
		const { writeFileSync, mkdtempSync } = await import('node:fs');
		const { join } = await import('node:path');
		const { tmpdir } = await import('node:os');
		const tmp = mkdtempSync(join(tmpdir(), 'sqlite-init-'));
		const ddlPath = join(tmp, 'init.sql');
		writeFileSync(ddlPath, 'CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY, item TEXT, amount REAL);\nCREATE INDEX IF NOT EXISTS idx_ledger_item ON ledger(item);');
		const t2 = new StdioClientTransport({ command: 'node', args: ['index.js'], env: { ...process.env, SQLITE_INIT_DDL_FILE: ddlPath } });
		const c2 = new Client({ name: 'sqlite-init-smoke', version: '0.0.1' });
		await c2.connect(t2);
		let r2 = await c2.callTool({ name: 'list-tables', arguments: {} });
		check('装备槽:开库即有预建表', r2.content[0].text.includes('"name": "ledger"'), r2.content[0].text.slice(0, 120));
		r2 = await c2.callTool({ name: 'execute', arguments: { sql: 'INSERT INTO ledger (item, amount) VALUES (?, ?)', params: ['coffee', 4.5] } });
		check('预建表可直接写入', r2.content[0].text.includes('"changes": 1'), r2.content[0].text);
		r2 = await c2.callTool({ name: 'list-tables', arguments: { database: join(tmp, 'second.db') } });
		check('第二个库同样自动预建(幂等 DDL)', r2.content[0].text.includes('"name": "ledger"'), r2.content[0].text.slice(0, 120));
		await c2.close();
		// 坏 DDL:应用失败必须在工具结果里说清是 init 的问题,不静默吞
		const badPath = join(tmp, 'bad.sql');
		writeFileSync(badPath, 'CREATE TABLE broken (');
		const t3 = new StdioClientTransport({ command: 'node', args: ['index.js'], env: { ...process.env, SQLITE_INIT_DDL_FILE: badPath } });
		const c3 = new Client({ name: 'sqlite-init-bad-smoke', version: '0.0.1' });
		await c3.connect(t3);
		const r3 = await c3.callTool({ name: 'list-tables', arguments: {} });
		check('坏 DDL → 报错点名预建 schema 失败', r3.content[0].text.startsWith('错误:') && r3.content[0].text.includes('预建 schema'), r3.content[0].text.slice(0, 140));
		await c3.close();
	}
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
