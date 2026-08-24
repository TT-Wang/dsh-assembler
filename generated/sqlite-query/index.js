// @dsh-index/sqlite-query — MCP stdio server wrapping better-sqlite3 11.1.2
// Tools: query (SELECT with params; batch via sqls[]), execute (write/DDL with
// params; multi-statement script in one transaction), list-tables (schema).
// Databases are keyed by their identifier and kept open for the lifetime of the server
// process, so an in-memory (":memory:") or file database created by one tool call is
// reusable by subsequent calls in the same session.
//
// 批量接口是刻意的(接口形态替模型省力,DESIGN.md):实测一次治理探针里模型对本
// 零件打了 26 次 roundtrip(12 execute + 14 query),每次调用前要付一整段推理链;
// 同样的活批成 3-5 次调用,探针墙钟近乎减半。先例:CodeAct(arXiv 2402.01030,
// 循环即批量,步数 −30%)与 Anthropic writing-tools-for-agents(一个调用吃掉一串
// 常见连招)。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// 默认库可被装配器经 env 钉死(装备槽):不传 database 时不再落 :memory:,
// 而是打开 SQLITE_DEFAULT_DB(相对路径按本进程 cwd 解析,即会话工作区)——
// 实测教训:agent 各自发明库名/漏传参数,前端会话和种子会话各写各的,
// 跨会话状态假装持久。钉死默认库 = 同一工作区必然同一份账。
const DEFAULT_DB = process.env.SQLITE_DEFAULT_DB || ':memory:';
/** Most queries one `sqls` batch accepts — bounds the response body (返回体裁剪铁律). */
const MAX_BATCH_QUERIES = 20;
const server = new McpServer({ name: 'sqlite-query', version: '0.0.4' });

/**
 * 装备槽:SQLITE_INIT_DDL_FILE 指向一份幂等 DDL(装配器发射时写进 preset 的
 * equipment/init.sql 并在 mcp 行的 env 里点名)。每个数据库第一次打开时自动应用,
 * 于是 agent 开库就有表——"房间自带家具":库表设计在装配时想好一次,运行时的模型
 * 不再为 schema 付一整段推理链(实测单次 75s)。跨会话还消灭 schema 漂移。
 * DDL 必须幂等(装配器用双次执行门验证过才发射);应用失败会在触发它的那次工具
 * 调用里报清楚,不静默吞。
 */
const INIT_DDL_FILE = process.env.SQLITE_INIT_DDL_FILE ?? '';

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
		if (INIT_DDL_FILE !== '') {
			try {
				const ddl = readFileSync(INIT_DDL_FILE, 'utf8');
				db.transaction(() => {
					db.exec(ddl);
				})();
			} catch (err) {
				db.close();
				throw new Error(
					`预建 schema 应用失败（SQLITE_INIT_DDL_FILE=${INIT_DDL_FILE}）: ${err && err.message ? err.message : String(err)}`
				);
			}
		}
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
	'对 SQLite 数据库执行只读 SQL（通常是 SELECT）并返回结果行。**默认数据库已由部署固定,常规使用请不要传 database 参数**。**需要多个查询时请用 sqls 数组一次批量执行，' +
		'不要逐条多次调用本工具**——返回与 sqls 同序的 [{sql, rows}] 数组。' +
		'参数: database（可选，数据库标识：文件路径或 ":memory:"，默认 ":memory:"；同一会话内相同标识复用同一数据库连接）；' +
		'sql（单条查询，可用 ? 作为参数占位符，配 params 使用）；' +
		'sqls（批量模式：只读 SQL 字符串数组，最多 20 条，不支持 ? 参数——值直接写进语句）；' +
		'params（可选，仅配 sql 用，位置参数数组按顺序绑定 ? 占位符，如 [1, "alice"]）。sql 与 sqls 二选一。',
	{ ...dbArgs, sqls: z.array(z.string()).describe('批量只读查询：SQL 字符串数组（最多 20 条，不支持 ? 参数）。与 sql 二选一。').optional() },
	safe((args) => {
		const db = getDb(args.database);
		if (Array.isArray(args.sqls)) {
			if (args.sqls.length === 0) throw new TypeError('参数 "sqls" 是空数组——至少给一条查询，或改用 sql 参数');
			if (args.sqls.length > MAX_BATCH_QUERIES) {
				throw new TypeError(`一次最多批量 ${MAX_BATCH_QUERIES} 条查询（收到 ${args.sqls.length} 条）——请分批`);
			}
			const out = args.sqls.map((s, i) => {
				if (typeof s !== 'string' || s.trim() === '') throw new TypeError(`sqls[${i}] 必须是非空 SQL 字符串`);
				try {
					return { sql: s, rows: db.prepare(s).all() };
				} catch (err) {
					throw new Error(`sqls[${i}] 执行失败: ${err && err.message ? err.message : String(err)}`);
				}
			});
			return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
		}
		const params = validateSqlArgs(args);
		const rows = db.prepare(args.sql).all(...params);
		return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
	})
);

server.tool(
	'execute',
	'对 SQLite 数据库执行写操作或 DDL（INSERT/UPDATE/DELETE/CREATE/ALTER 等）并返回变更统计 JSON。**默认数据库已由部署固定,常规使用请不要传 database 参数**。' +
		'**请尽量把一批相关写操作合并成一次调用，不要逐条多次调用本工具**：' +
		'不带 params 时 sql 可以是多条分号分隔的语句脚本（建表+批量写入一次完成，整个脚本在一个事务里执行，' +
		'任一条失败则全部回滚；脚本内不要写 BEGIN/COMMIT）；多行插入优先写成 INSERT INTO t VALUES (...),(...),(...) 单语句。' +
		'参数: database（可选，同 query 工具）；sql（必填：单条语句可配 ? 占位符 + params；多条语句脚本不支持 params，值直接写进 SQL）；' +
		'params（可选，仅单条语句可用，位置参数数组按顺序绑定 ? 占位符）。' +
		'返回：单条 { changes, lastInsertRowid }；脚本 { script: true, changes(合计), lastInsertRowid }。',
	dbArgs,
	safe((args) => {
		const db = getDb(args.database);
		const params = validateSqlArgs(args);
		try {
			const info = db.prepare(args.sql).run(...params);
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify({ changes: info.changes, lastInsertRowid: info.lastInsertRowid }, null, 2),
					},
				],
			};
		} catch (err) {
			// Not a multi-statement script → the error is the answer (syntax, constraint…).
			if (!/more than one statement/i.test(String(err && err.message ? err.message : err))) throw err;
			if (params.length > 0) {
				throw new TypeError('多条语句的脚本不支持 params 绑定——要么拆成单条带 ? 的语句，要么把值直接写进 SQL 字面量');
			}
			// Script path: one transaction, all-or-nothing. changes 用 total_changes()
			// 差值统计（exec 不逐条报数），回滚时抛错原样透出。
			const before = db.prepare('SELECT total_changes() AS c').get().c;
			db.transaction(() => {
				db.exec(args.sql);
			})();
			const after = db.prepare('SELECT total_changes() AS c').get().c;
			const rowid = db.prepare('SELECT last_insert_rowid() AS r').get().r;
			return {
				content: [
					{ type: 'text', text: JSON.stringify({ script: true, changes: after - before, lastInsertRowid: rowid }, null, 2) },
				],
			};
		}
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


// ── 服务脸(进程脸直连账的物理通道;零件分类法 2026-08-24)─────────────────
// 页面/机器可绕开模型直接读写本 preset 的账:确定性流(查/汇总/表渲染)不再
// 每次烧一个 agent 回合。安全模型:127.0.0.1 随机端口 + 每次启动随机 token;
// token 经两条同信任域通道分发——workspace/.service.json(host 的 /.service
// 路由同源伺服给页面)与 service-info 工具(agent 侧发现)。写入安全靠装备
// DDL 的 CHECK/NOT NULL 自卫:不管哪张脸来写,坏数据进不了库。
// 契约:单条语句;ATTACH/DETACH/VACUUM 拒;返回行数上限 500(返回体裁剪铁律)。
const SERVICE_TOKEN = randomBytes(16).toString('hex');
const FORBIDDEN_SQL = /^\s*(ATTACH|DETACH|VACUUM)\b/i;
const MAX_FACE_ROWS = 500;

const faceServer = createServer((req, res) => {
	const cors = () => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Service-Token');
	};
	const json = (code, obj) => {
		cors();
		res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify(obj));
	};
	if (req.method === 'OPTIONS') { cors(); res.writeHead(204); res.end(); return; }
	const pathname = (req.url ?? '/').split('?')[0];
	// 鉴权:头 X-Service-Token 或查询串 ?token=(二者等价)。查询串是必要的——
	// <audio src>/<img src>/下载链接无法带自定义头,只认 URL;字节类服务脸若只收头,
	// 页面就永远取不到字节(实测:B3 语音便签墙因取不到脸整题颗粒无收)。
	const presented = req.headers['x-service-token'] ?? (() => { try { return new URL(req.url ?? '/', 'http://local').searchParams.get('token'); } catch { return null; } })();
	if (presented !== SERVICE_TOKEN) return json(401, { error: 'bad or missing service token(头 X-Service-Token 或 ?token= 均可)' });

	if (req.method === 'GET' && pathname === '/schema') {
		try {
			const db = getDb(undefined);
			const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
			const out = tables.map((t) => ({
				name: t.name,
				columns: db.prepare(`PRAGMA table_info("${t.name.replace(/"/g, '""')}")`).all()
					.map((c) => ({ name: c.name, type: c.type, notnull: c.notnull === 1, dflt: c.dflt_value ?? null, pk: c.pk > 0 })),
			}));
			return json(200, { tables: out });
		} catch (error) {
			return json(500, { error: String(error?.message ?? error) });
		}
	}

	if (req.method === 'POST' && pathname === '/sql') {
		let body = '';
		req.on('data', (d) => { body += d; if (body.length > 256 * 1024) req.destroy(); });
		req.on('end', () => {
			try {
				const parsed = JSON.parse(body || '{}');
				const sql = typeof parsed.sql === 'string' ? parsed.sql.trim() : '';
				if (sql === '') return json(400, { error: '需要 { sql, params? }' });
				if (FORBIDDEN_SQL.test(sql)) return json(403, { error: '服务脸拒绝 ATTACH/DETACH/VACUUM' });
				const db = getDb(undefined); // 服务脸只对默认库(本 preset 的账)开放,不许指别的库
				const stmt = db.prepare(sql); // 多条语句 better-sqlite3 在此抛错
				const params = Array.isArray(parsed.params) ? parsed.params : [];
				if (stmt.reader) {
					const rows = stmt.all(...params);
					return json(200, { rows: rows.slice(0, MAX_FACE_ROWS), truncated: rows.length > MAX_FACE_ROWS });
				}
				const info = stmt.run(...params);
				return json(200, { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) });
			} catch (error) {
				return json(400, { error: String(error?.message ?? error) });
			}
		});
		return;
	}
	return json(404, { error: 'not found' });
});
faceServer.listen(0, '127.0.0.1');
faceServer.unref(); // 质检门契约:stdio 关闭进程必须退场,常驻监听不得钉住进程
const facePort = await new Promise((r) => faceServer.once('listening', () => r(faceServer.address().port)));
const FACE_URL = `http://127.0.0.1:${facePort}`;

// 端点档案落 workspace/.service.json(merge 语义:别的零件也会写自己的条目)。
// host 的 /assembler/ui/<preset>/.service 路由同源伺服它——页面零轮次发现端点。
const workdir = process.env.PART_WORKDIR ?? '';
if (workdir !== '') {
	try {
		mkdirSync(workdir, { recursive: true });
		const svcPath = join(workdir, '.service.json');
		const existing = existsSync(svcPath) ? JSON.parse(readFileSync(svcPath, 'utf8')) : {};
		existing.sqlite = { url: FACE_URL, token: SERVICE_TOKEN, pid: process.pid, startedAt: new Date().toISOString() };
		writeFileSync(svcPath, JSON.stringify(existing, null, 2));
	} catch { /* 档案写不进不拦工具面;service-info 仍可发现 */ }
}

server.registerTool(
	'service-info',
	{
		title: '服务脸发现',
		description: '返回本零件的 HTTP 直连端点(服务脸):页面/程序可绕开模型直接读写本 preset 的默认库。返回 { url, token };调用方以 X-Service-Token 头携带 token 访问 GET /schema 与 POST /sql。',
		inputSchema: {},
	},
	async () => ({ content: [{ type: 'text', text: JSON.stringify({ url: FACE_URL, token: SERVICE_TOKEN, endpoints: ['GET /schema', 'POST /sql {sql, params?}'] }) }] })
);

await server.connect(new StdioServerTransport());
