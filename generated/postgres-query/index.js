// @dsh-index/postgres-query — MCP stdio server wrapping pg 8.12.0 (brianc/node-postgres, MIT)
//
// Tools:
//   - postgres-test-connection  测试到 PostgreSQL 服务器的连接（SELECT version()），验证连接配置
//   - postgres-list-tables      按 schema 列出表/视图（information_schema.tables）
//   - postgres-describe-table   查看一张表的完整结构（information_schema.columns + 主键标注）
//   - postgres-query            执行任意 SQL（SELECT / INSERT / UPDATE / DELETE / DDL），支持 $1/$2 位置参数绑定
//
// 设计说明：
//   - 每次工具调用建立独立连接并在结束时关闭（无状态、可独立调用），连接参数随调用传入；
//   - pg 默认将 numeric / bigint 以字符串返回（保证 JSON 安全），timestamp 返回 Date（序列化为 ISO 字符串）；
//   - 二进制列（bytea 等）以 Buffer 返回，工具序列化为 { $binary: <base64>, encoding: "base64" }；
//   - 参数校验错误与运行错误（连接失败、SQL 语法错误等）均返回清晰的错误文本（isError: true）。

import pg from 'pg';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const { Client } = pg;

const server = new McpServer({ name: 'postgres-query', version: '0.0.1' });

// ---------------------------------------------------------------------------
// 公共连接参数（所有工具共享）。每个字段都带 describe，便于 LLM 选择器理解用途。
// 与上游 pg 默认值保持一致：host=localhost、port=5432、user=当前操作系统用户、database 继承自 user。
// ---------------------------------------------------------------------------
const connectionFields = {
  connectionString: z
    .string()
    .optional()
    .describe(
      '完整的 PostgreSQL 连接字符串（libpq 格式，如 "postgres://user:pass@host:5432/db?sslmode=no-verify"）。提供时覆盖 host/port/user/password/database 等单独字段，可选'
    ),
  host: z
    .string()
    .default('localhost')
    .describe('PostgreSQL 服务器主机名或 IP 地址，默认 localhost'),
  port: z
    .number()
    .int()
    .positive()
    .default(5432)
    .describe('PostgreSQL 服务器 TCP 端口，默认 5432'),
  user: z
    .string()
    .optional()
    .describe('登录用户名，不传则默认当前操作系统用户'),
  password: z
    .string()
    .optional()
    .describe('登录密码，不传则默认空（本机 trust 认证可直接连接）'),
  database: z
    .string()
    .optional()
    .describe('要连接的数据库名，不传则默认与用户名相同'),
  ssl: z
    .union([z.boolean(), z.string()])
    .optional()
    .describe(
      '是否启用 TLS：true 使用默认 CA 校验；"no-verify" 等价 { rejectUnauthorized: false }（自签证书开发环境常用）；"disable" 强制明文；不传则按 PGSSLMODE 环境变量或默认关闭'
    ),
  connectTimeoutMillis: z
    .number()
    .int()
    .positive()
    .default(10000)
    .describe('连接超时（毫秒），默认 10000，超时返回清晰错误'),
};

/**
 * 由工具参数构造 pg Client 配置。
 * @param {Record<string, unknown>} args
 */
function buildClientConfig(args) {
  const cfg = {
    host: args.host,
    port: args.port,
    connectTimeoutMillis: args.connectTimeoutMillis,
    query_timeout: args.queryTimeoutMillis ?? 30000,
  };
  if (args.connectionString !== undefined) cfg.connectionString = args.connectionString;
  if (args.user !== undefined) cfg.user = args.user;
  if (args.password !== undefined) cfg.password = args.password;
  if (args.database !== undefined) cfg.database = args.database;
  if (args.ssl !== undefined) {
    if (args.ssl === 'no-verify') cfg.ssl = { rejectUnauthorized: false };
    else if (args.ssl === 'disable') cfg.ssl = false;
    else cfg.ssl = args.ssl;
  }
  return cfg;
}

/**
 * 把 pg 结果值序列化为 JSON 安全形式：Buffer（bytea）→ { $binary, encoding: "base64" }，
 * Date（timestamp）→ ISO 字符串，其余原样返回（numeric/bigint 在 pg 中本就是字符串）。
 * @param {unknown} value
 * @returns {unknown}
 */
function serializeValue(value) {
  if (Buffer.isBuffer(value)) {
    return { $binary: value.toString('base64'), encoding: 'base64' };
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((v) => serializeValue(v));
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = serializeValue(v);
    return out;
  }
  return value;
}

/**
 * 统一的错误文本：把任何异常转成清晰的单行错误信息。
 * @param {unknown} err
 */
function errorText(err) {
  const e = /** @type {any} */ (err);
  const code = e && e.code ? ` [${e.code}]` : '';
  return `错误: ${e && e.message ? e.message : String(err)}${code}`;
}

/**
 * 包装工具回调：捕获所有异常，返回 isError: true 的 MCP 工具错误结果。
 * @param {(args: any) => Promise<Record<string, unknown>>} fn
 */
function safe(fn) {
  return async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await fn(args), null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  };
}

/**
 * 建立连接 → 执行 fn → finally 关闭连接。
 * @param {Record<string, unknown>} args
 * @param {(client: import('pg').Client) => Promise<Record<string, unknown>>} fn
 */
async function withConnection(args, fn) {
  const client = new Client(buildClientConfig(args));
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 工具 1：postgres-test-connection — 测试连接可用性并返回服务器诊断信息
// ---------------------------------------------------------------------------
server.tool(
  'postgres-test-connection',
  '测试到 PostgreSQL 服务器的连接是否可用：建立连接并执行 SELECT version()，返回服务器版本、当前数据库、当前用户、服务器地址、服务器时间等诊断信息。适合在正式查询前先用它验证 connectionString/host/port/user/password/database 等连接配置是否正确。参数: 连接配置同 postgres-query（connectionString 可选，host 默认 localhost，port 默认 5432，user 默认当前系统用户，password 可选，database 可选，ssl 可选，connectTimeoutMillis 默认 10000）。',
  connectionFields,
  safe(async (args) => {
    return withConnection(args, async (client) => {
      const res = await client.query(
        'SELECT version() AS version, current_database() AS database, current_user AS user, ' +
          'inet_server_addr() AS server_address, inet_server_port() AS server_port, now() AS now'
      );
      const r = res.rows[0] || {};
      return {
        connected: true,
        host: args.host,
        port: args.port,
        user: args.user ?? r.user ?? null,
        database: r.database ?? null,
        version: r.version ?? null,
        serverAddress: r.server_address ?? null,
        serverPort: r.server_port ?? null,
        serverTime: r.now ?? null,
      };
    });
  })
);

// ---------------------------------------------------------------------------
// 工具 2：postgres-list-tables — 按 schema 列出表/视图
// ---------------------------------------------------------------------------
server.tool(
  'postgres-list-tables',
  '连接 PostgreSQL 并按 schema 列出表与视图（information_schema.tables），返回表名与类型数组及数量。适合在查询前探索库中有哪些表。参数: 连接配置同 postgres-test-connection（connectionString/host/port/user/password/database/ssl/connectTimeoutMillis）；schema（可选，schema 名，默认 public）；includeViews（可选，是否包含视图，默认 true）。',
  {
    ...connectionFields,
    schema: z.string().default('public').describe('要列出的 schema 名，默认 public'),
    includeViews: z
      .boolean()
      .default(true)
      .describe('是否包含视图（table_type = VIEW），默认 true'),
  },
  safe(async (args) => {
    return withConnection(args, async (client) => {
      const tableTypes = args.includeViews ? "'BASE TABLE','VIEW'" : "'BASE TABLE'";
      const res = await client.query(
        `SELECT table_name AS name, table_type AS type
         FROM information_schema.tables
         WHERE table_schema = $1 AND table_type IN (${tableTypes})
         ORDER BY table_name`,
        [args.schema]
      );
      return {
        schema: args.schema,
        tableCount: res.rowCount ?? res.rows.length,
        tables: res.rows.map((r) => ({ name: r.name, type: r.type })),
      };
    });
  })
);

// ---------------------------------------------------------------------------
// 工具 3：postgres-describe-table — 查看一张表的完整结构（含主键标注）
// ---------------------------------------------------------------------------
server.tool(
  'postgres-describe-table',
  '连接 PostgreSQL 并查看一张表（或视图）的完整结构（information_schema.columns，左连接主键约束标注 isPrimaryKey），返回每列的 name/ordinal/dataType/udtName/isNullable/columnDefault/charMaxLength/numericPrecision/numericScale。适合在编写 SQL 前确认列名、类型与主键。参数: 连接配置同 postgres-test-connection；schema（可选，默认 public）；table（必填，表名）。',
  {
    ...connectionFields,
    schema: z.string().default('public').describe('表所在的 schema 名，默认 public'),
    table: z.string().describe('要查看结构的表名（必填）'),
  },
  safe(async (args) => {
    return withConnection(args, async (client) => {
      const res = await client.query(
        `SELECT c.column_name AS name,
                c.ordinal_position AS ordinal,
                c.data_type AS data_type,
                c.udt_name AS udt_name,
                c.is_nullable AS is_nullable,
                c.column_default AS column_default,
                c.character_maximum_length AS char_max_length,
                c.numeric_precision AS numeric_precision,
                c.numeric_scale AS numeric_scale,
                (pk.constraint_name IS NOT NULL) AS is_primary_key
         FROM information_schema.columns c
         LEFT JOIN (
           SELECT kcu.column_name, kcu.table_name, kcu.table_schema, tc.constraint_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
            AND tc.table_name = kcu.table_name
           WHERE tc.constraint_type = 'PRIMARY KEY'
         ) pk
           ON pk.table_schema = c.table_schema
          AND pk.table_name = c.table_name
          AND pk.column_name = c.column_name
         WHERE c.table_schema = $1 AND c.table_name = $2
         ORDER BY c.ordinal_position`,
        [args.schema, args.table]
      );
      return {
        schema: args.schema,
        table: args.table,
        columnCount: res.rows.length,
        columns: res.rows.map((r) => ({
          name: r.name,
          ordinal: r.ordinal,
          dataType: r.data_type,
          udtName: r.udt_name,
          isNullable: r.is_nullable === 'YES',
          columnDefault: r.column_default,
          charMaxLength: r.char_max_length,
          numericPrecision: r.numeric_precision,
          numericScale: r.numeric_scale,
          isPrimaryKey: r.is_primary_key,
        })),
      };
    });
  })
);

// ---------------------------------------------------------------------------
// 工具 4：postgres-query — 执行任意 SQL，支持 $1/$2 位置参数绑定
// ---------------------------------------------------------------------------
server.tool(
  'postgres-query',
  '连接 PostgreSQL 并执行任意 SQL（SELECT / INSERT / UPDATE / DELETE / DDL），支持 $1/$2 位置参数绑定（参数数组按序对应）。' +
    '**请尽量把一批相关语句合并成一次调用，不要逐条多次调用本工具**：不带 params 时 sql 可以是多条分号分隔的语句脚本' +
    '（建表+批量写入+查询一次完成，整个脚本在同一连接的隐式事务中执行，任一条失败整体回滚；脚本内不要写 BEGIN/COMMIT），' +
    '此时返回 { batch: true, statements, results: [每条语句的 { command, rowCount, rows, fields }] }；' +
    '多行插入优先写成 INSERT INTO t VALUES (...),(...),(...) 单语句。' +
    '单条语句返回 { command, rowCount, rows, fields }：rows 为行对象数组（字段名为键，numeric/bigint 以字符串返回保证 JSON 安全，bytea 二进制列以 { $binary: <base64>, encoding: "base64" } 返回，timestamp 为 ISO 字符串），fields 为列元数据（name/dataTypeID/dataTypeSize/format）。' +
    '注意：本工具直接执行传入的 SQL，可能修改数据，需谨慎使用。参数: 连接配置同 postgres-test-connection（connectionString 可选，host 默认 localhost，port 默认 5432，user 默认当前系统用户，password 可选，database 可选，ssl 可选，connectTimeoutMillis 默认 10000）；sql（必填，SQL 文本：单条可用 $1/$2 占位符配 params；多条分号分隔脚本不支持 params，值直接写进 SQL）；params（可选，仅单条语句可用，位置参数数组，元素可为字符串/数字/布尔/null，二进制参数用 { $binary: "<base64>" } 形式）；queryTimeoutMillis（可选，单条查询超时毫秒，默认 30000）。',
  {
    ...connectionFields,
    sql: z.string().describe('要执行的 SQL 文本（必填），参数占位符用 $1、$2 等位置形式'),
    params: z
      .array(
        z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.null(),
          z
            .object({ $binary: z.string() })
            .describe('二进制参数，形如 { $binary: "<base64>" }，将被解码为 Buffer 发送（如 bytea 列）'),
        ])
      )
      .optional()
      .describe('可选的查询参数数组，按顺序对应 SQL 中的 $1/$2/... 占位符'),
    queryTimeoutMillis: z
      .number()
      .int()
      .positive()
      .default(30000)
      .describe('单条查询超时（毫秒），默认 30000，超时返回清晰错误'),
  },
  safe(async (args) => {
    return withConnection(args, async (client) => {
      const values = (args.params !== undefined ? args.params : []).map((p) =>
        p !== null && typeof p === 'object' && '$binary' in p
          ? Buffer.from(/** @type {string} */ (p.$binary), 'base64')
          : p
      );
      // 多语句脚本必须走简单协议:pg 在 values 非空时切 extended protocol,
      // 那里多语句直接报 "cannot insert multiple commands"——裁决交给 pg 本身,
      // 错误文本已足够行动(拆成单条,或把值写进字面量)。
      const res = await client.query({
        text: args.sql,
        values,
        query_timeout: args.queryTimeoutMillis,
      });
      const shape = (one) => ({
        command: one.command,
        rowCount: one.rowCount,
        rows: (one.rows || []).map((row) => {
          const out = {};
          for (const [k, v] of Object.entries(row)) out[k] = serializeValue(v);
          return out;
        }),
        fields: (one.fields || []).map((f) => ({
          name: f.name,
          dataTypeID: f.dataTypeID,
          dataTypeSize: f.dataTypeSize,
          format: f.format,
        })),
      });
      // 多语句脚本（简单协议）返回结果数组——此前这里按单结果读取，多语句调用
      // 会静默返回 { command: undefined, rows: [] } 的空壳,批量能力名存实亡。
      if (Array.isArray(res)) {
        return { batch: true, statements: res.length, results: res.map(shape) };
      }
      return shape(res);
    });
  })
);

// ---------------------------------------------------------------------------
// 启动 stdio 传输。stdin 关闭（EOF）后传输结束、服务器优雅退出。
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
