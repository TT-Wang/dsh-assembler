#!/usr/bin/env node
/**
 * MCP stdio server: 字符串校验/清洗工具,基于 validator@13。
 * 能力点:常见格式校验(email/url/uuid/信用卡/ip/isbn/json/base64/hex 颜色/jwt,
 * 返回 valid 判定与规范化建议)与字符串清洗(HTML 转义/反转义/去空白/邮箱规范化)——
 * agent 校验用户输入、清洗一段文本,一轮内完成。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import validator from 'validator';

const server = new McpServer({ name: 'string-validate', version: '0.0.1' });

// 支持的校验类型 → validator 函数(全部单参调用,选项走库默认值)
const VALIDATORS = {
  email: (s) => validator.isEmail(s),
  url: (s) => validator.isURL(s),
  uuid: (s) => validator.isUUID(s),
  'credit-card': (s) => validator.isCreditCard(s),
  ip: (s) => validator.isIP(s),
  isbn: (s) => validator.isISBN(s),
  json: (s) => validator.isJSON(s),
  base64: (s) => validator.isBase64(s),
  'hex-color': (s) => validator.isHexColor(s),
  jwt: (s) => validator.isJWT(s),
};
const TYPE_LIST = Object.keys(VALIDATORS).join(' / ');

server.registerTool('validate-string', {
  description:
    `校验一段文本是否符合指定格式,返回 JSON:{ type, input, valid }。支持的 type:${TYPE_LIST}。`
    + '仅校验不改写;email 校验通过时额外返回 normalized 字段(normalizeEmail 规范化建议,'
    + '如去 gmail 点号与 +tag 子地址、小写化)。不认识的 type 返回错误并列出支持的类型。',
  inputSchema: {
    text: z.string().describe('待校验的文本(仅接受字符串)'),
    type: z.string().describe(`校验类型,取值:${TYPE_LIST}`),
  },
}, async ({ text, type }) => {
  const fn = VALIDATORS[type];
  if (!fn) {
    return {
      isError: true,
      content: [{ type: 'text', text: `validate-string: 不认识的校验类型 "${type}",支持:${TYPE_LIST}` }],
    };
  }
  const result = { type, input: text, valid: fn(text) };
  if (type === 'email' && result.valid) {
    const normalized = validator.normalizeEmail(text);
    if (normalized && normalized !== text) result.normalized = normalized;
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

// 清洗操作 → validator 清洗函数(trim 族支持自定义字符集)
const SANITIZERS = {
  escape: (s) => validator.escape(s),
  unescape: (s) => validator.unescape(s),
  trim: (s, chars) => validator.trim(s, chars),
  ltrim: (s, chars) => validator.ltrim(s, chars),
  rtrim: (s, chars) => validator.rtrim(s, chars),
  'normalize-email': (s) => (validator.isEmail(s) ? validator.normalizeEmail(s) : false),  // normalizeEmail 自身不校验格式,先 isEmail 闸住坏输入
};
const OP_LIST = Object.keys(SANITIZERS).join(' / ');

server.registerTool('sanitize-string', {
  description:
    `对文本执行一种清洗操作,返回清洗后的字符串。支持的 op:${OP_LIST}。`
    + 'escape/unescape 做 HTML 实体转义与还原;trim/ltrim/rtrim 默认去空白,可用 chars 指定要去除的字符集;'
    + 'normalize-email 规范化邮箱(输入不是合法邮箱时返回错误)。不认识的 op 返回错误。',
  inputSchema: {
    text: z.string().describe('待清洗的文本'),
    op: z.string().describe(`清洗操作,取值:${OP_LIST}`),
    chars: z.string().optional().describe('trim/ltrim/rtrim 专用:要去除的字符集(默认空白)'),
  },
}, async ({ text, op, chars }) => {
  const fn = SANITIZERS[op];
  if (!fn) {
    return {
      isError: true,
      content: [{ type: 'text', text: `sanitize-string: 不认识的清洗操作 "${op}",支持:${OP_LIST}` }],
    };
  }
  const result = fn(text, chars);
  if (op === 'normalize-email' && result === false) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'sanitize-string: normalize-email 失败,输入不是合法邮箱地址' }],
    };
  }
  return { content: [{ type: 'text', text: String(result) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
