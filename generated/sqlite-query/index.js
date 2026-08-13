// @dsh-index/sqlite-query — MCP stdio server wrapping better-sqlite3 11.1.2
// Tools: query (SELECT with params), execute (write/DDL with params), list-tables (schema).
// Databases are keyed by their identifier and kept open for the lifetime of the server
// process, so an in-memory (":memory:") or file database created by one tool call is
// reusable by subsequent calls in the same session.
import Database from 'better-sqlite3';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const DEFAULT_DB = ':memory:';
const server = new McpServer({ name: 'sqlite-query', version: '0.0.1' });

/** Map of database identifier -> open better-sqlite3 Database instance. */
const dbs = new Map();

/**
 * Resolve (and lazily open) a database by identifier.
 * @param {unknown} key raw value of the "database" argument
 * @returns {Database}
 */
function getDb(key) {
	const id = key == null || key === '' ? DEFAULT_DB : key;
	if (typeof id !== 'string') {
		throw new TypeError('参数 "database" 必须是字符串（文件路径或 ":memory:"）');
	}
	let db = dbs.get(id);
	if (!db) {
		// For ":memory:" this creates an anonymous in-memory database; for any other
		// string it opens/creates that file path relative to the server's cwd.
		db = new Database(id);
		dbs.set(id, db);
	}
	return db;
}

/** Validate the shared "sql"/"params" arguments of query & execute. */
function validateSqlArgs(args) {
	if (typeof args.sql !== 'string' || args.sql.trim() === '') {
		throw new TypeError('参数 "sql" 必填，且必须是包含 SQL 语句的非空字符串');
	}
	const params = args.params === undefined ? [] : args.params;
	if (!Array.isArray(params)) {
		throw new TypeError('参数 "params"（可选）必须是数组，元素按顺序绑定到 SQL 中的 ? 占位符');
	}
	return params;
}

/** Wrap a handler so validation errors and runtime errors are returned as tool output text. */
function safe(handler) {
	return async (args) => {
		try {
			return await handler(args);
		} catch (err) {
			return { content: [{ type: 'text', text: `错误: ${err && err.message ? err.message : String(err)}` }] };
		}
	};
}

/** Shared zod schema: all fields optional; strict checks happen inside the handlers
 *  so their error messages reach the caller as tool output text. */
const dbArgs = {
	database: z.string().describe('数据库标识：文件路径或 ":memory:"（默认）。同一会话内复用同一连接。').optional(),
	sql: z.string().describe('SQL 语句，可用 ? 作为参数占位符。').optional(),
	params: z.any().describe('可选的位置绑定参数数组，按顺序对应 SQL 中的 ? 占位符。').optional(),
};

server.tool(
	'query',
	'对 SQLite 数据库执行一条只读 SQL 语句（通常是 SELECT）并返回全部结果行（JSON 数组）。' +
		'适合任何需要从 SQLite 中读取数据的场景。参数: database（可选，数据库标识：文件路径或 ":memory:"，默认 ":memory:"；' +
		'同一会话内相同标识复用同一数据库连接）；sql（必填，SQL 语句，可用 ? 作为参数占位符）；' +
		'params（可选，位置参数数组，按顺序绑定到 ? 占位符，如 [1, "alice"]）。',
	dbArgs,
	safe((args) => {
		const db = getDb(args.database);
		const params = validateSqlArgs(args);
		const rows = db.prepare(args.sql).all(...params);
		return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
	})
);

server.tool(
	'execute',
	'对 SQLite 数据库执行一条写操作或 DDL 语句（INSERT/UPDATE/DELETE/CREATE/ALTER 等，单条语句）' +
		'并返回变更统计 { changes, lastInsertRowid }（JSON）。适合建表、插入、更新、删除等修改性操作。' +
		'参数: database（可选，同 query 工具）；sql（必填，单条写语句，可用 ? 占位符）；' +
		'params（可选，位置参数数组，按顺序绑定到 ? 占位符）。',
	dbArgs,
	safe((args) => {
		const db = getDb(args.database);
		const params = validateSqlArgs(args);
		const info = db.prepare(args.sql).run(...params);
		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify({ changes: info.changes, lastInsertRowid: info.lastInsertRowid }, null, 2),
				},
			],
		};
	})
);

server.tool(
	'list-tables',
	'列出 SQLite 数据库中所有的表和视图（来自 sqlite_master），返回 JSON 数组，' +
		'每项包含 name（表/视图名）、type（table 或 view）、sql（建表/建视图语句，可为空）。' +
		'适合在查询前探索数据库结构。参数: database（可选，同 query 工具）。',
	{ database: dbArgs.database },
	safe((args) => {
		const db = getDb(args.database);
		const rows = db
			.prepare(
				"SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name"
			)
			.all();
		return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
	})
);

await server.connect(new StdioServerTransport());
