// smoke.mjs — 冒烟验证 @dsh-index/postgres-query MCP stdio server
//
// 策略：本机运行着 Postgres.app（PostgreSQL 18.0，本用户 trust 认证，密码为空），
// 因此用真实 PG 服务器做端到端验证：
//   - listTools() 返回 4 个工具
//   - 4 个工具各真实调用一次（test-connection / create+insert+select via query /
//     list-tables / describe-table，含 $1 参数绑定与 bytea 二进制列 base64）
//   - 缺参校验：不带 sql 调用 postgres-query 应返回清晰错误（-32602）
//   - 连接失败：连一个已关闭的端口应返回清晰错误（ECONNREFUSED）
//   - 清理：DROP TABLE 冒烟用临时表
//
// 运行：node smoke.mjs（在 generated/postgres-query 目录下）
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = process.env.PG_SMOKE_HOST || 'localhost';
const PORT = Number(process.env.PG_SMOKE_PORT || 5432);
const USER = process.env.PG_SMOKE_USER || undefined;
const DATABASE = process.env.PG_SMOKE_DATABASE || 'postgres';
const TABLE = 'dsh_smoke_people';

let pass = 0;
let fail = 0;

function assert(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${extra ? `  -> ${extra}` : ''}`);
  }
}

/** 取 CallToolResult 的文本内容 */
function textOf(result) {
  const part = Array.isArray(result.content) ? result.content[0] : null;
  return part && part.type === 'text' ? part.text : '';
}

/** 连接配置对象（缺省 user 时由 pg 默认取当前系统用户） */
const connArgs = { host: SERVER, port: PORT, database: DATABASE };
if (USER !== undefined) connArgs.user = USER;

console.log(`PG 目标: ${USER ?? '(OS user)'}@${SERVER}:${PORT}/${DATABASE}\n`);

// ---------------------------------------------------------------------------
// 1. 启动 MCP client，连接 index.js 子进程
// ---------------------------------------------------------------------------
const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js'],
});
const client = new Client({ name: 'smoke-client', version: '0.0.1' });
await client.connect(transport);

// ---------------------------------------------------------------------------
// 2. listTools
// ---------------------------------------------------------------------------
console.log('[1] listTools');
const toolsResp = await client.listTools();
const toolNames = toolsResp.tools.map((t) => t.name);
const expectedTools = [
  'postgres-test-connection',
  'postgres-list-tables',
  'postgres-describe-table',
  'postgres-query',
];
assert(toolsResp.tools.length === 4, `工具数量 = 4 (实际 ${toolsResp.tools.length})`);
for (const name of expectedTools) {
  assert(toolNames.includes(name), `包含工具 ${name}`);
}
for (const t of toolsResp.tools) {
  assert(
    typeof t.description === 'string' && t.description.length > 40,
    `工具 ${t.name} 描述可读 (>40 字符)`
  );
}

// ---------------------------------------------------------------------------
// 3. postgres-test-connection（真实连接）
// ---------------------------------------------------------------------------
console.log('\n[2] postgres-test-connection');
const t1 = await client.callTool({ name: 'postgres-test-connection', arguments: connArgs });
assert(t1.isError !== true, '连接成功不报错', textOf(t1));
const t1j = JSON.parse(textOf(t1));
assert(t1j.connected === true, 'connected === true');
assert(/PostgreSQL \d+\.\d+/.test(t1j.version || ''), `version 含 PostgreSQL 版本号: ${t1j.version?.slice(0, 30)}...`);
assert(t1j.database === DATABASE, `current_database = ${DATABASE}`);

// ---------------------------------------------------------------------------
// 4. postgres-query：建表（DDL，真实执行）
// ---------------------------------------------------------------------------
console.log('\n[3] postgres-query: CREATE TABLE');
const t2 = await client.callTool({
  name: 'postgres-query',
  arguments: {
    ...connArgs,
    sql:
      `CREATE TABLE IF NOT EXISTS ${TABLE} (` +
      'id serial PRIMARY KEY, ' +
      'name text NOT NULL, ' +
      'age integer, ' +
      'balance numeric(10,2), ' +
      'active boolean, ' +
      'created_at timestamptz DEFAULT now(), ' +
      'photo bytea)',
  },
});
assert(t2.isError !== true, 'CREATE TABLE 成功', textOf(t2));
const t2j = JSON.parse(textOf(t2));
assert(t2j.command === 'CREATE', `command = CREATE (实际 ${t2j.command})`);

// ---------------------------------------------------------------------------
// 5. postgres-query：参数化 INSERT（$1/$2/$3 绑定）
// ---------------------------------------------------------------------------
console.log('\n[4] postgres-query: 参数化 INSERT');
const t3 = await client.callTool({
  name: 'postgres-query',
  arguments: {
    ...connArgs,
    sql: `INSERT INTO ${TABLE} (name, age, balance, active, photo) VALUES ($1, $2, $3, $4, $5)`,
    params: ['张三', 30, 12345.67, true, { $binary: Buffer.from('hello-bytea').toString('base64') }],
  },
});
assert(t3.isError !== true, 'INSERT 成功', textOf(t3));
const t3j = JSON.parse(textOf(t3));
assert(t3j.command === 'INSERT' && t3j.rowCount === 1, `INSERT rowCount = 1 (command=${t3j.command}, rowCount=${t3j.rowCount})`);

// ---------------------------------------------------------------------------
// 6. postgres-query：参数化 SELECT + bytea base64 + numeric 字符串
// ---------------------------------------------------------------------------
console.log('\n[5] postgres-query: 参数化 SELECT');
const t4 = await client.callTool({
  name: 'postgres-query',
  arguments: {
    ...connArgs,
    sql: `SELECT id, name, age, balance, active, photo, created_at FROM ${TABLE} WHERE name = $1`,
    params: ['张三'],
  },
});
assert(t4.isError !== true, 'SELECT 成功', textOf(t4));
const t4j = JSON.parse(textOf(t4));
assert(t4j.command === 'SELECT', `command = SELECT (实际 ${t4j.command})`);
assert(Array.isArray(t4j.rows) && t4j.rows.length === 1, '返回 1 行');
const row = t4j.rows[0];
assert(row.name === '张三', `name = 张三 (实际 ${row.name})`);
assert(row.balance === '12345.67', `numeric 以字符串返回 = "12345.67" (实际 ${JSON.stringify(row.balance)})`);
assert(
  row.photo && row.photo.$binary === Buffer.from('hello-bytea').toString('base64') && row.photo.encoding === 'base64',
  'bytea 二进制列以 { $binary, encoding: "base64" } 返回'
);
assert(
  typeof row.created_at === 'string' && !isNaN(Date.parse(row.created_at)),
  `timestamptz 以 ISO 字符串返回 (实际 ${row.created_at})`
);
assert(Array.isArray(t4j.fields) && t4j.fields.length >= 6, 'fields 元数据非空');
assert(t4j.fields.some((f) => f.name === 'photo' && typeof f.dataTypeID === 'number'), 'fields 含 photo 列元数据');

// ---------------------------------------------------------------------------
// 7. postgres-list-tables（真实查询）
// ---------------------------------------------------------------------------
console.log('\n[6] postgres-list-tables');
const t5 = await client.callTool({
  name: 'postgres-list-tables',
  arguments: { ...connArgs, schema: 'public' },
});
assert(t5.isError !== true, 'list-tables 成功', textOf(t5));
const t5j = JSON.parse(textOf(t5));
assert(Array.isArray(t5j.tables) && t5j.tables.some((tb) => tb.name === TABLE), `tables 含 ${TABLE}`);
const tbl = t5j.tables.find((tb) => tb.name === TABLE);
assert(tbl && tbl.type === 'BASE TABLE', `类型 = BASE TABLE (实际 ${tbl && tbl.type})`);

// ---------------------------------------------------------------------------
// 8. postgres-describe-table（真实查询，含主键标注）
// ---------------------------------------------------------------------------
console.log('\n[7] postgres-describe-table');
const t6 = await client.callTool({
  name: 'postgres-describe-table',
  arguments: { ...connArgs, schema: 'public', table: TABLE },
});
assert(t6.isError !== true, 'describe-table 成功', textOf(t6));
const t6j = JSON.parse(textOf(t6));
assert(t6j.table === TABLE && t6j.columnCount >= 7, `columnCount >= 7 (实际 ${t6j.columnCount})`);
const idCol = t6j.columns.find((c) => c.name === 'id');
assert(idCol && idCol.isPrimaryKey === true, 'id 列 isPrimaryKey = true');
const photoCol = t6j.columns.find((c) => c.name === 'photo');
assert(photoCol && photoCol.udtName === 'bytea', `photo 列 udtName = bytea (实际 ${photoCol && photoCol.udtName})`);
const balCol = t6j.columns.find((c) => c.name === 'balance');
assert(balCol && balCol.numericPrecision === 10 && balCol.numericScale === 2, 'balance numeric(10,2) 精度正确');

// ---------------------------------------------------------------------------
// 9. 缺参校验：不带 sql 调用 postgres-query
// ---------------------------------------------------------------------------
console.log('\n[8] 缺参校验 (无 sql)');
const t7 = await client.callTool({ name: 'postgres-query', arguments: { ...connArgs } });
const t7txt = textOf(t7);
assert(t7.isError === true, '缺 sql 返回 isError=true');
assert(t7txt.includes('-32602') || t7txt.includes('validation'), `错误文本含 -32602/validation: ${t7txt.slice(0, 120)}`);
assert(t7txt.includes('sql'), `错误文本指明缺失字段 sql: ${t7txt.slice(0, 120)}`);

// ---------------------------------------------------------------------------
// 10. 连接失败：连一个已关闭的端口
// ---------------------------------------------------------------------------
console.log('\n[9] 连接失败 (已关闭端口)');
const probe = net.createServer();
probe.listen(0);
await new Promise((r) => probe.once('listening', r));
const closedPort = probe.address().port;
await new Promise((r) => probe.close(r));
const t8 = await client.callTool({
  name: 'postgres-test-connection',
  arguments: { host: '127.0.0.1', port: closedPort, database: DATABASE },
});
const t8txt = textOf(t8);
assert(t8.isError === true, '连已关闭端口返回 isError=true');
assert(/ECONNREFUSED|Connection refused|connect ECONNREFUSED/i.test(t8txt), `错误文本含 ECONNREFUSED: ${t8txt.slice(0, 120)}`);

// ---------------------------------------------------------------------------
// 11. 清理：DROP TABLE 临时表
// ---------------------------------------------------------------------------
console.log('\n[10] 清理');
const t9 = await client.callTool({
  name: 'postgres-query',
  arguments: { ...connArgs, sql: `DROP TABLE IF EXISTS ${TABLE}` },
});
assert(t9.isError !== true, 'DROP TABLE 成功', textOf(t9));

// ---------------------------------------------------------------------------
// 12. 批量接口(v0.0.2):多语句脚本一次调用、结果逐条、隐式事务回滚
// ---------------------------------------------------------------------------
console.log('\n[11] 多语句脚本批量');
const BT = 'smoke_batch_v2';
const b1 = await client.callTool({
  name: 'postgres-query',
  arguments: {
    ...connArgs,
    sql: `DROP TABLE IF EXISTS ${BT}; CREATE TABLE ${BT} (id INT PRIMARY KEY, pkg TEXT); ` +
      `INSERT INTO ${BT} VALUES (1, 'express'), (2, 'lodash'); SELECT count(*) AS n FROM ${BT};`,
  },
});
const b1txt = textOf(b1);
assert(b1.isError !== true, '脚本执行成功', b1txt.slice(0, 150));
const b1obj = (() => { try { return JSON.parse(b1txt); } catch { return null; } })();
assert(b1obj?.batch === true && b1obj.statements === 4, `batch=true 且逐条结果(4 条,得 ${b1obj?.statements})`);
assert(String(b1obj?.results?.[3]?.rows?.[0]?.n) === '2', `脚本内 SELECT 可读(count=2,得 ${b1obj?.results?.[3]?.rows?.[0]?.n})`);

// 隐式事务:第二条撞主键 → 整个脚本回滚,第一条 INSERT 不落库
const b2 = await client.callTool({
  name: 'postgres-query',
  arguments: {
    ...connArgs,
    sql: `INSERT INTO ${BT} VALUES (3, 'should-roll-back'); INSERT INTO ${BT} VALUES (1, 'dup-key');`,
  },
});
assert(b2.isError === true, '脚本中途失败返回 isError', textOf(b2).slice(0, 120));
const b3 = await client.callTool({
  name: 'postgres-query',
  arguments: { ...connArgs, sql: `SELECT count(*) AS n FROM ${BT}` },
});
const b3obj = (() => { try { return JSON.parse(textOf(b3)); } catch { return null; } })();
assert(String(b3obj?.rows?.[0]?.n) === '2', `失败脚本整体回滚(行数仍 2,得 ${b3obj?.rows?.[0]?.n})`);

// 脚本 + params 是矛盾请求 → pg 明确报错,不静默截断
const b4 = await client.callTool({
  name: 'postgres-query',
  arguments: { ...connArgs, sql: `SELECT $1::text; SELECT 2;`, params: ['x'] },
});
assert(b4.isError === true && /multiple commands/i.test(textOf(b4)), '脚本+params 明确报错', textOf(b4).slice(0, 120));

await client.callTool({ name: 'postgres-query', arguments: { ...connArgs, sql: `DROP TABLE IF EXISTS ${BT}` } });

// ---------------------------------------------------------------------------
// 13. 关闭连接，验证子进程干净退出
// ---------------------------------------------------------------------------
await client.close();
assert(true, 'MCP client 关闭');

console.log(`\n======== 冒烟结果: ${pass} PASS / ${fail} FAIL ========`);
process.exit(fail === 0 ? 0 : 1);
