// smoke.mjs — 冒烟验证 @dsh-index/mysql-query MCP stdio server
//
// 策略：本机没有真实 MySQL 服务器，因此用 mysql2 自带的 createServer() 在进程内
// 起一个 mock MySQL 服务器（复用上游测试 common.createServer 的握手方式），
// 再通过 MCP Client + StdioClientTransport 拉起 index.js 子进程做端到端验证：
//   - listTools() 返回 4 个工具
//   - 4 个工具各真实调用一次（mysql-test-connection / mysql-list-tables /
//     mysql-describe-table / mysql-query 含参数绑定与二进制列 base64）
//   - 缺参校验：不带 sql 调用 mysql-query 应返回清晰错误
//   - 连接失败：连一个已关闭的端口应返回清晰错误（ECONNREFUSED）
//
// 运行：node smoke.mjs（在 generated/mysql-query 目录下）
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import mysqlCore from 'mysql2';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;

// mock mysql2 server 自身的协议序列号警告（上游测试同样存在，不影响数据正确性）会刷屏，
// 全程静音 console.error；FAIL 行改用 process.stderr.write 输出，不受静音影响。
const originalConsoleError = console.error;
console.error = () => {};

function assert(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    process.stderr.write(`  FAIL  ${label}${extra ? `  -> ${extra}` : ''}\n`);
  }
}

/** 取 CallToolResult 的文本内容 */
function textOf(result) {
  const part = Array.isArray(result.content) ? result.content[0] : null;
  return part && part.type === 'text' ? part.text : '';
}

// ---------------------------------------------------------------------------
// 1. 进程内 mock MySQL 服务器
// ---------------------------------------------------------------------------
const mockServer = mysqlCore.createServer();
mockServer.listen(0);
const mockNetServer = mockServer._server;
await new Promise((resolve) => mockNetServer.once('listening', resolve));
const mockPort = mockNetServer.address().port;

// capabilityFlags：去掉 COMPRESS(0x20) 与 SSL(0x800) 位，强制明文连接
let mockFlags = 0xffffff;
mockFlags = mockFlags ^ 0x20 ^ 0x800;

/** 构造列定义：字符串列用 utf8 字符集(33)，二进制列用 BINARY 字符集(63) */
function col(name, columnType, columnLength = 255, characterSet = 33) {
  return {
    catalog: 'def',
    schema: '',
    table: '',
    orgTable: '',
    name,
    orgName: '',
    characterSet,
    columnLength,
    columnType,
    flags: 0,
    decimals: 0,
  };
}

mockServer.on('connection', (conn) => {
  conn.on('error', () => {
    /* 忽略 mock 侧断开 */
  });
  conn.serverHandshake({
    protocolVersion: 10,
    serverVersion: '8.0.33-mock',
    connectionId: 1234,
    statusFlags: 2,
    characterSet: 8,
    capabilityFlags: mockFlags,
    authCallback: (params, cb) => cb(null), // 接受任意用户名密码
  });
  conn.on('query', (sql) => {
    const q = sql.trim().toLowerCase();
    if (q.startsWith('select version()')) {
      conn.writeTextResult([{ version: '8.0.33-mock' }], [col('version', 253)]);
    } else if (q.startsWith('show tables')) {
      // 工具把 like 拼成 SHOW TABLES LIKE 'user%'，mock 按是否含 LIKE 过滤
      const withLike = q.includes('like');
      conn.writeTextResult(
        withLike ? [{ t: 'users' }] : [{ t: 'users' }, { t: 'orders' }],
        [col('t', 253)]
      );
    } else if (q.startsWith('show full columns')) {
      conn.writeTextResult(
        [
          { Field: 'id', Type: 'int', Null: 'NO', Key: 'PRI', Default: 'NULL', Extra: 'auto_increment' },
          { Field: 'name', Type: 'varchar(255)', Null: 'YES', Key: '', Default: 'NULL', Extra: '' },
          { Field: 'email', Type: 'varchar(255)', Null: 'YES', Key: 'UNI', Default: 'NULL', Extra: '' },
        ],
        [
          col('Field', 253), col('Type', 253), col('Null', 253),
          col('Key', 253), col('Default', 253), col('Extra', 253),
        ]
      );
    } else if (q.startsWith('select photo')) {
      // BINARY 字符集列 -> 客户端按 Buffer 返回 -> 工具应转成 base64
      conn.writeTextResult([{ photo: 'ffd8ff' }], [col('photo', 253, 255, 63)]);
    } else if (q.startsWith('select')) {
      conn.writeTextResult(
        [{ id: '1', name: 'Alice', email: 'alice@example.com' }],
        [col('id', 8), col('name', 253), col('email', 253)]
      );
    } else if (/^(insert|update|delete)\b/.test(q)) {
      conn.writeOk({ affectedRows: 1, insertId: 42 });
    } else {
      conn.writeError({ code: 1064, message: 'You have an error in your SQL syntax (mock)' });
    }
  });
});

// 找一个确定已关闭的端口用于“连接失败”用例
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, resolve));
const closedPort = probe.address().port;
await new Promise((resolve) => probe.close(resolve));

// ---------------------------------------------------------------------------
// 2. 启动 MCP server 子进程并连接
// ---------------------------------------------------------------------------
const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js'],
  cwd: __dirname,
  stderr: 'pipe',
});
const childStderr = [];
transport.stderr.on('data', (d) => childStderr.push(String(d)));

const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(transport);
console.log('MCP server 子进程已连接 (node index.js)');

const conn = { host: '127.0.0.1', port: mockPort, user: 'root', password: '' };

try {
  // -------------------------------------------------------------------------
  // 3. listTools
  // -------------------------------------------------------------------------
  console.log('\n[1] listTools');
  const { tools } = await client.listTools();
  assert(tools.length === 4, `工具数量为 4（实际 ${tools.length}）`, JSON.stringify(tools.map((t) => t.name)));
  const names = tools.map((t) => t.name).sort();
  assert(
    JSON.stringify(names) ===
      JSON.stringify(['mysql-describe-table', 'mysql-list-tables', 'mysql-query', 'mysql-test-connection'].sort()),
    `工具名集合正确: ${names.join(', ')}`,
    names.join(',')
  );
  for (const t of tools) {
    assert(
      typeof t.description === 'string' && t.description.length > 20,
      `工具 ${t.name} 有可读的描述（${t.description.length} 字符）`
    );
    assert(t.inputSchema && t.inputSchema.properties && Object.keys(t.inputSchema.properties).length >= 6, `工具 ${t.name} 声明了输入参数 schema`);
  }

  // -------------------------------------------------------------------------
  // 4. mysql-test-connection（真实往返）
  // -------------------------------------------------------------------------
  console.log('\n[2] mysql-test-connection');
  let res = await client.callTool({ name: 'mysql-test-connection', arguments: conn });
  assert(!res.isError, 'test-connection 调用未报错', textOf(res));
  let data = JSON.parse(textOf(res));
  assert(data.connected === true, 'connected === true');
  assert(data.version === '8.0.33-mock', `version === '8.0.33-mock'（实际 ${data.version}）`, data.version);
  assert(data.host === '127.0.0.1' && data.port === mockPort, 'host/port 回显正确');

  // -------------------------------------------------------------------------
  // 5. mysql-list-tables（含 LIKE 过滤）
  // -------------------------------------------------------------------------
  console.log('\n[3] mysql-list-tables');
  res = await client.callTool({ name: 'mysql-list-tables', arguments: { ...conn, database: 'testdb' } });
  assert(!res.isError, 'list-tables 调用未报错', textOf(res));
  data = JSON.parse(textOf(res));
  assert(data.tableCount === 2, `tableCount === 2（实际 ${data.tableCount}）`, data.tableCount);
  assert(data.tables.includes('users') && data.tables.includes('orders'), '表列表包含 users 与 orders', data.tables.join(','));
  assert(data.database === 'testdb', 'database 回显 testdb');

  res = await client.callTool({ name: 'mysql-list-tables', arguments: { ...conn, like: 'user%' } });
  data = JSON.parse(textOf(res));
  assert(data.tables.length === 1 && data.tables[0] === 'users', `like='user%' 只返回 users（实际 ${data.tables.join(',')}）`, data.tables.join(','));

  // -------------------------------------------------------------------------
  // 6. mysql-describe-table
  // -------------------------------------------------------------------------
  console.log('\n[4] mysql-describe-table');
  res = await client.callTool({ name: 'mysql-describe-table', arguments: { ...conn, table: 'users' } });
  assert(!res.isError, 'describe-table 调用未报错', textOf(res));
  data = JSON.parse(textOf(res));
  assert(data.table === 'users', 'table === users');
  assert(data.columnCount === 3, `columnCount === 3（实际 ${data.columnCount}）`, data.columnCount);
  const fields = data.columns.map((c) => c.field);
  assert(
    JSON.stringify(fields) === JSON.stringify(['id', 'name', 'email']),
    `列顺序为 id/name/email（实际 ${fields.join(',')}）`,
    fields.join(',')
  );
  const idCol = data.columns.find((c) => c.field === 'id');
  assert(idCol && idCol.type === 'int' && idCol.key === 'PRI' && idCol.extra === 'auto_increment', 'id 列为 int/PRI/auto_increment');

  // -------------------------------------------------------------------------
  // 7. mysql-query：SELECT + 参数绑定
  // -------------------------------------------------------------------------
  console.log('\n[5] mysql-query (SELECT + ? 参数)');
  res = await client.callTool({
    name: 'mysql-query',
    arguments: { ...conn, sql: 'SELECT id, name, email FROM users WHERE id = ?', params: [1] },
  });
  assert(!res.isError, 'query SELECT 调用未报错', textOf(res));
  data = JSON.parse(textOf(res));
  assert(data.kind === 'rows', `kind === 'rows'（实际 ${data.kind}）`, data.kind);
  assert(data.rowCount === 1 && data.rows.length === 1, '返回 1 行');
  assert(data.rows[0].name === 'Alice', `rows[0].name === 'Alice'（实际 ${data.rows[0].name}）`, data.rows[0].name);
  assert(data.rows[0].email === 'alice@example.com', 'rows[0].email 正确');
  // bigNumberStrings: BIGINT 以字符串返回
  assert(data.rows[0].id === '1', `id(BIGINT) 以字符串返回 '1'（实际 ${JSON.stringify(data.rows[0].id)}）`, data.rows[0].id);
  assert(Array.isArray(data.fields) && data.fields.length === 3 && data.fields[0].name === 'id', 'fields 元数据包含 3 列且首列为 id');

  // -------------------------------------------------------------------------
  // 8. mysql-query：写语句（INSERT -> affectedRows/insertId）
  // -------------------------------------------------------------------------
  console.log('\n[6] mysql-query (INSERT)');
  res = await client.callTool({
    name: 'mysql-query',
    arguments: { ...conn, sql: "INSERT INTO users (name) VALUES ('Bob')" },
  });
  assert(!res.isError, 'query INSERT 调用未报错', textOf(res));
  data = JSON.parse(textOf(res));
  assert(data.kind === 'ok', `kind === 'ok'（实际 ${data.kind}）`, data.kind);
  assert(data.affectedRows === 1, `affectedRows === 1（实际 ${data.affectedRows}）`, data.affectedRows);
  assert(data.insertId === 42, `insertId === 42（实际 ${data.insertId}）`, data.insertId);

  // -------------------------------------------------------------------------
  // 9. mysql-query：二进制列 -> base64
  // -------------------------------------------------------------------------
  console.log('\n[7] mysql-query (BINARY 列 -> base64)');
  res = await client.callTool({
    name: 'mysql-query',
    arguments: { ...conn, sql: 'SELECT photo FROM users WHERE id = 2' },
  });
  assert(!res.isError, 'query 二进制列调用未报错', textOf(res));
  data = JSON.parse(textOf(res));
  const photo = data.rows[0].photo;
  assert(
    photo && photo.$binary === Buffer.from('ffd8ff', 'ascii').toString('base64'),
    `二进制列以 { $binary: base64 } 返回（实际 ${JSON.stringify(photo)}）`,
    JSON.stringify(photo)
  );
  assert(photo.encoding === 'base64', 'encoding 标注为 base64');

  // -------------------------------------------------------------------------
  // 10. 缺参校验：不带 sql（SDK 以 isError 结果返回 "Invalid arguments" 错误文本）
  // -------------------------------------------------------------------------
  console.log('\n[8] 缺参校验（mysql-query 不带 sql）');
  res = await client.callTool({ name: 'mysql-query', arguments: conn });
  const missingText = textOf(res);
  assert(res.isError === true, '缺 sql 时 isError === true');
  assert(
    /Invalid arguments for tool mysql-query/.test(missingText) && /sql/.test(missingText),
    `返回清晰缺参错误（${missingText.slice(0, 120)}）`,
    missingText.slice(0, 200)
  );

  // -------------------------------------------------------------------------
  // 11. 连接失败：连已关闭的端口
  // -------------------------------------------------------------------------
  console.log('\n[9] 连接失败（端口已关闭）');
  res = await client.callTool({
    name: 'mysql-query',
    arguments: { ...conn, port: closedPort, sql: 'SELECT 1', connectTimeout: 3000 },
  });
  const errText = textOf(res);
  assert(res.isError === true, 'isError === true');
  assert(/错误:/.test(errText) && /ECONNREFUSED|connect/.test(errText), `返回清晰连接错误（${errText.slice(0, 120)}）`, errText.slice(0, 200));

  // -------------------------------------------------------------------------
  // 12. SQL 语法错误路径
  // -------------------------------------------------------------------------
  console.log('\n[10] SQL 语法错误');
  res = await client.callTool({ name: 'mysql-query', arguments: { ...conn, sql: 'SELEC 1' } });
  const syntaxText = textOf(res);
  assert(res.isError === true, 'isError === true');
  assert(/错误:/.test(syntaxText) && /1064|syntax/i.test(syntaxText), `返回清晰语法错误（${syntaxText.slice(0, 120)}）`, syntaxText.slice(0, 200));
} finally {
  // -------------------------------------------------------------------------
  // 13. 清理：关闭客户端与 mock 服务器；子进程应随 stdin 关闭而退出
  // -------------------------------------------------------------------------
  await transport.close();
  mockServer._server.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
}

console.error = originalConsoleError; // 恢复 console.error 后输出汇总

console.log('\n----------------------------------------');
console.log(`结果: ${pass} PASS / ${fail} FAIL`);
const realChildStderr = childStderr.filter((l) => !/packets out of order/.test(l));
if (realChildStderr.length > 0) {
  console.log('--- MCP server 子进程 stderr ---');
  console.log(realChildStderr.join(''));
}
if (fail > 0) process.exit(1);
