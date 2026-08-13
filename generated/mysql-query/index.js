// @dsh-index/mysql-query — MCP stdio server wrapping mysql2 3.10.0 (sidorares/node-mysql2, MIT)
//
// Tools:
//   - mysql-test-connection  测试到 MySQL 服务器的连接（SELECT VERSION()），验证连接配置
//   - mysql-list-tables      列出数据库中的表（SHOW TABLES，可选 LIKE 过滤）
//   - mysql-describe-table   查看一张表的完整结构（SHOW FULL COLUMNS）
//   - mysql-query            执行任意 SQL（SELECT / INSERT / UPDATE / DELETE / DDL），支持 ? 位置参数
//
// 设计说明：
//   - 每次工具调用建立独立连接并在结束时关闭（无状态、可独立调用），连接参数随调用传入；
//   - 启用 supportBigNumbers + bigNumberStrings，BIGINT 等大数以字符串返回，保证 JSON 安全；
//   - 二进制列（BLOB / VARBINARY / BIT 等）以 { $binary, encoding: "base64" } 形式返回；
//   - 参数校验错误与运行错误（连接失败、SQL 语法错误等）均返回清晰的错误文本（isError: true）。

import * as mysqlNs from 'mysql2/promise';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const mysql = mysqlNs.default ?? mysqlNs;

const server = new McpServer({ name: 'mysql-query', version: '0.0.1' });

// ---------------------------------------------------------------------------
// 公共连接参数（所有工具共享）。每个字段都带 describe，便于 LLM 选择器理解用途。
// ---------------------------------------------------------------------------
const connectionFields = {
  host: z
    .string()
    .default('127.0.0.1')
    .describe('MySQL 服务器主机名或 IP 地址，默认 127.0.0.1'),
  port: z
    .number()
    .int()
    .positive()
    .default(3306)
    .describe('MySQL 服务器 TCP 端口，默认 3306'),
  user: z.string().default('root').describe('登录用户名，默认 root'),
  password: z
    .string()
    .default('')
    .describe('登录密码，默认空字符串'),
  database: z
    .string()
    .optional()
    .describe('默认数据库名（连接后未指定库名的 SQL 将在此库执行），可选'),
  ssl: z
    .union([z.boolean(), z.string()])
    .optional()
    .describe(
      '是否启用 TLS 加密连接：true 使用默认 CA 配置；传字符串为 mysql2 的 ssl 配置名（如 "Amazon RDS"）；不传则明文连接'
    ),
  connectTimeout: z
    .number()
    .int()
    .positive()
    .default(10000)
    .describe('连接超时（毫秒），默认 10000，超时返回清晰错误'),
};

/**
 * 由工具参数构造 mysql2 连接配置。
 * @param {Record<string, unknown>} args
 */
function buildConnectionOptions(args) {
  const opts = {
    host: args.host,
    port: args.port,
    user: args.user,
    password: args.password,
    connectTimeout: args.connectTimeout,
    supportBigNumbers: true,
    bigNumberStrings: true,
  };
  if (args.database !== undefined) opts.database = args.database;
  if (args.ssl !== undefined) {
    // true -> 默认 TLS 配置；字符串 -> mysql2 命名配置（如 'Amazon RDS'）
    opts.ssl = args.ssl === true ? {} : args.ssl;
  }
  return opts;
}

/**
 * 建立连接、执行回调、确保连接被关闭。
 * @param {Record<string, unknown>} args
 * @param {(conn: import('mysql2/promise').Connection) => Promise<unknown>} fn
 */
async function withConnection(args, fn) {
  const conn = await mysql.createConnection(buildConnectionOptions(args));
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(() => {
      /* 忽略关闭时的错误 */
    });
  }
}

/**
 * 将查询结果安全地序列化为 JSON 文本：
 *  - Buffer（二进制列） -> { $binary: '<base64>', encoding: 'base64', originalType: 'Buffer' }
 *  - Date -> ISO 字符串（JSON.stringify 默认行为）
 *  - bigint -> 字符串（理论上 bigNumberStrings 已避免，兜底处理）
 */
function serialize(value) {
  return JSON.stringify(
    value,
    (key, val) => {
      if (val && typeof val === 'object' && val.type === 'Buffer' && Array.isArray(val.data)) {
        return {
          $binary: Buffer.from(val.data).toString('base64'),
          encoding: 'base64',
          originalType: 'Buffer',
        };
      }
      if (typeof val === 'bigint') return val.toString();
      return val;
    },
    2
  );
}

/** 包装处理器：校验与运行错误一律转为清晰错误文本返回，不让异常泄漏到 MCP 层。 */
function safe(handler) {
  return async (args) => {
    try {
      const result = await handler(args);
      return { content: [{ type: 'text', text: serialize(result) }] };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      const code = err && err.code ? ` [${err.code}]` : '';
      return {
        content: [{ type: 'text', text: `错误: ${message}${code}` }],
        isError: true,
      };
    }
  };
}

// ---------------------------------------------------------------------------
// 工具 1：mysql-test-connection — 测试连接可用性并返回服务器版本信息
// ---------------------------------------------------------------------------
server.tool(
  'mysql-test-connection',
  '测试到 MySQL 服务器的连接是否可用：建立连接并执行 SELECT VERSION()，返回服务器版本、连接 ID、当前数据库等诊断信息。适合在正式查询前先用它验证 host/port/user/password 等连接配置是否正确。参数: host（主机，默认 127.0.0.1）、port（端口，默认 3306）、user（用户名，默认 root）、password（密码，默认空）、database（可选，默认库）、ssl（可选）、connectTimeout（可选，毫秒，默认 10000）。',
  // 注意：SDK 1.30 的 server.tool() 分离参数重载只接受 zod 原始 shape（字段对象），
  // 不接受 z.object() 实例（会被误判为 ToolAnnotations 而抛错），因此这里直接传 shape。
  connectionFields,
  safe(async (args) => {
    return withConnection(args, async (conn) => {
      const [rows] = await conn.query(
        'SELECT VERSION() AS version, @@version_comment AS version_comment, ' +
          'CONNECTION_ID() AS connection_id, DATABASE() AS current_database'
      );
      const r = rows[0] || {};
      return {
        connected: true,
        host: args.host,
        port: args.port,
        user: args.user,
        version: r.version ?? null,
        versionComment: r.version_comment ?? null,
        connectionId: r.connection_id ?? null,
        currentDatabase: r.current_database ?? null,
      };
    });
  })
);

// ---------------------------------------------------------------------------
// 工具 2：mysql-list-tables — 列出数据库中的表
// ---------------------------------------------------------------------------
server.tool(
  'mysql-list-tables',
  '连接 MySQL 并列出数据库中的全部表（SHOW TABLES），返回表名数组。适合在查询前探索库中有哪些表。参数: 连接配置同 mysql-test-connection（host/port/user/password/database/ssl/connectTimeout）；like（可选，SQL LIKE 模式，仅返回匹配的表名，如 "user%"）。',
  {
    ...connectionFields,
    like: z
      .string()
      .optional()
      .describe('可选的 SQL LIKE 模式，仅列出匹配的表名，如 "user%"'),
  },
  safe(async (args) => {
    return withConnection(args, async (conn) => {
      const sql = args.like !== undefined ? 'SHOW TABLES LIKE ?' : 'SHOW TABLES';
      const params = args.like !== undefined ? [args.like] : [];
      const [rows] = await conn.query(sql, params);
      // SHOW TABLES 的行是 { Tables_in_<db>: '表名' } 形式的单列对象，取第一个值
      const tables = rows.map((row) => {
        const values = Object.values(row);
        return values.length > 0 ? String(values[0]) : null;
      });
      return { database: args.database ?? null, tableCount: tables.length, tables };
    });
  })
);

// ---------------------------------------------------------------------------
// 工具 3：mysql-describe-table — 查看表的完整结构
// ---------------------------------------------------------------------------
server.tool(
  'mysql-describe-table',
  '连接 MySQL 并查看一张表的完整结构（SHOW FULL COLUMNS），返回每一列的 Field（列名）、Type（类型，含长度/精度）、Collation（字符集排序规则）、Null（是否可空）、Key（索引键，PRI/UNI/MUL）、Default（默认值）、Extra（额外属性，如 auto_increment）。适合在编写 SQL 前确认列名与类型。参数: 连接配置同 mysql-test-connection；table（必填，表名，按 MySQL 规则大小写敏感）。',
  {
    ...connectionFields,
    table: z.string().min(1).describe('要查看结构的表名（必填）'),
  },
  safe(async (args) => {
    return withConnection(args, async (conn) => {
      // ?? 占位符：mysql2 会按标识符（反引号包裹）安全转义表名
      const [rows] = await conn.query('SHOW FULL COLUMNS FROM ??', [args.table]);
      const columns = rows.map((row) => ({
        field: row.Field,
        type: row.Type,
        collation: row.Collation ?? null,
        null: row.Null,
        key: row.Key ?? '',
        default: row.Default ?? null,
        extra: row.Extra ?? '',
        comment: row.Comment ?? null,
      }));
      return { table: args.table, columnCount: columns.length, columns };
    });
  })
);

// ---------------------------------------------------------------------------
// 工具 4：mysql-query — 执行任意 SQL（核心工具）
// ---------------------------------------------------------------------------
server.tool(
  'mysql-query',
  '对 MySQL 服务器执行一条 SQL 语句（SELECT / INSERT / UPDATE / DELETE / DDL 均可），支持 ? 位置参数。返回 JSON：SELECT 类语句返回 rows（结果行数组，字段名为键；二进制列如 BLOB/VARBINARY 以 { $binary: <base64>, encoding: "base64" } 返回）与 fields（字段元数据 name/type）；写语句返回 { affectedRows, insertId, warningStatus, info } 等。BIGINT 大数以字符串返回以保证 JSON 安全。注意：执行写语句是真实副作用操作。参数: host/port/user/password/database/ssl/connectTimeout（连接配置，同 mysql-test-connection）；sql（必填，SQL 文本，? 为占位符）；params（可选，位置参数数组，按顺序绑定到 ?，仅支持 ? 占位符形式）。',
  {
    ...connectionFields,
    sql: z.string().min(1).describe('要执行的 SQL 语句（必填），? 为位置参数占位符'),
    params: z
      .array(z.union([z.string(), z.number(), z.boolean(), z.null(), z.bigint()]))
      .optional()
      .describe('可选的位置参数数组，按顺序绑定到 SQL 中的 ? 占位符'),
  },
  safe(async (args) => {
    if (!args.sql || typeof args.sql !== 'string' || args.sql.trim() === '') {
      throw new TypeError('参数 "sql" 必填，且必须是包含 SQL 语句的非空字符串');
    }
    const params = args.params ?? [];
    if (!Array.isArray(params)) {
      throw new TypeError('参数 "params"（可选）必须是数组，元素按顺序绑定到 SQL 中的 ? 占位符');
    }
    return withConnection(args, async (conn) => {
      const [result, fields] = await conn.query(args.sql, params);
      if (Array.isArray(result)) {
        // SELECT 类结果
        return {
          kind: 'rows',
          rowCount: result.length,
          rows: result,
          fields: (fields || []).map((f) => ({
            name: f.name,
            type: f.columnType,
            length: f.columnLength,
            charset: f.characterSet,
            flags: f.flags,
          })),
        };
      }
      // 写 / DDL 类结果（OkPacket / ResultSetHeader）
      return {
        kind: 'ok',
        affectedRows: result.affectedRows ?? 0,
        insertId: result.insertId ?? null,
        warningStatus: result.warningStatus ?? 0,
        info: result.info ?? '',
      };
    });
  })
);

// ---------------------------------------------------------------------------
// 启动 stdio 传输。stdin 关闭（EOF）后传输结束、服务器优雅退出。
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
