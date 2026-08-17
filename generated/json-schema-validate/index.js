#!/usr/bin/env node
/**
 * MCP stdio server: JSON Schema 校验工具 on top of ajv@8。
 * 能力点:拿 schema 校验 JSON 数据(结构化错误明细)、单独体检 schema 本身——
 * agent 生成/收到一份 JSON 时,一轮内判定它合不合约定。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// ajv 是 CJS(module.exports = exports = Ajv),ESM 默认导入直接拿到类;
// 2020-12 方言的类不在主入口,按 README 从 dist/2020.js 深导入(包无 exports map,须带 .js)
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';

const server = new McpServer({ name: 'json-schema-validate', version: '0.0.1' });

/** 解析 JSON 字符串;成功 {ok:true,data} / 失败 {ok:false,err} */
function tryParseJson(text) {
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

/** 按 schema 的 $schema 选方言:2020-12 用 Ajv2020,其余走默认 Ajv(draft-07/2019-09 元模式内置) */
function makeAjv(schema) {
  const is2020 = schema !== null && typeof schema === 'object'
    && typeof schema.$schema === 'string' && schema.$schema.includes('2020-12');
  const Ctor = is2020 ? Ajv2020 : Ajv;
  // allErrors: 一次报全所有错;strict: false 走标准 JSON Schema 语义(未知关键字忽略而非抛错)
  return { ajv: new Ctor({ allErrors: true, strict: false }), dialect: is2020 ? '2020-12' : 'draft-07(默认)' };
}

server.registerTool('validate', {
  description:
    '用 JSON Schema 校验一份 JSON 数据。输入:data(JSON 字符串)+ schema(JSON Schema,JSON 字符串)。'
    + '输出:{"valid":true} 或 {"valid":false,"errors":[{instancePath,keyword,message},...]}——'
    + '数据不合 schema 是正常返回的校验结论,不是 isError。'
    + '方言:schema 的 $schema 含 2020-12 时用 2020-12 方言,否则用默认 draft-07。'
    + '边界:data/schema 不是合法 JSON、或 schema 本身不是合法的 JSON Schema(编译失败),才返回 isError。',
  inputSchema: {
    data: z.string().describe('要校验的 JSON 数据(字符串形式)'),
    schema: z.string().describe('JSON Schema(字符串形式)'),
  },
}, async ({ data, schema }) => {
  const parsedData = tryParseJson(data);
  if (!parsedData.ok) {
    return { isError: true, content: [{ type: 'text', text: `validate: data 不是合法 JSON — ${parsedData.err}` }] };
  }
  const parsedSchema = tryParseJson(schema);
  if (!parsedSchema.ok) {
    return { isError: true, content: [{ type: 'text', text: `validate: schema 不是合法 JSON — ${parsedSchema.err}` }] };
  }
  let validateFn;
  try {
    validateFn = makeAjv(parsedSchema.data).ajv.compile(parsedSchema.data);
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `validate: schema 本身非法,编译失败 — ${e.message}` }] };
  }
  const valid = validateFn(parsedData.data);
  const report = valid
    ? { valid: true }
    : {
        valid: false,
        errors: (validateFn.errors ?? []).map((err) => ({
          instancePath: err.instancePath,
          keyword: err.keyword,
          message: err.message,
        })),
      };
  return { content: [{ type: 'text', text: JSON.stringify(report) }] };
});

server.registerTool('check-schema', {
  description:
    '只检查一份 JSON Schema 自身是否合法(能否通过所选方言的元模式校验并编译),不校验任何数据。'
    + '输入:schema(JSON 字符串)。输出:{"valid":true,"dialect":...} 或 {"valid":false,"reason":...}——'
    + 'schema 不合法是本工具的正常结论,不是 isError。'
    + '方言选择同 validate($schema 含 2020-12 走 2020-12,否则 draft-07)。'
    + '边界:输入不是合法 JSON 才返回 isError。',
  inputSchema: {
    schema: z.string().describe('要体检的 JSON Schema(字符串形式)'),
  },
}, async ({ schema }) => {
  const parsedSchema = tryParseJson(schema);
  if (!parsedSchema.ok) {
    return { isError: true, content: [{ type: 'text', text: `check-schema: 输入不是合法 JSON — ${parsedSchema.err}` }] };
  }
  const { ajv, dialect } = makeAjv(parsedSchema.data);
  try {
    ajv.compile(parsedSchema.data);
    return { content: [{ type: 'text', text: JSON.stringify({ valid: true, dialect }) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: JSON.stringify({ valid: false, dialect, reason: e.message }) }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
