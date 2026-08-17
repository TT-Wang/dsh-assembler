#!/usr/bin/env node
/**
 * MCP stdio server: 电话号码解析与格式化,基于 libphonenumber-js@1(/max 元数据,含号码类型)。
 * 能力点:agent 拿到用户或数据里的电话号码时,一轮内判国家、验有效性、
 * 转成 E.164/国际/国内标准格式。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import parsePhoneNumber from 'libphonenumber-js/max';

const server = new McpServer({ name: 'phone-parse', version: '0.0.1' });

/** 统一解析入口:成功返回 PhoneNumber,失败返回 null(调用方决定报错文案)。 */
function tryParse(number, defaultCountry) {
  try {
    return parsePhoneNumber(number, defaultCountry ? defaultCountry.toUpperCase() : undefined) ?? null;
  } catch {
    return null;
  }
}

server.registerTool('parse-phone', {
  description:
    '解析电话号码,返回结构化 JSON:country(ISO 两位国家码,判不出为 null)、countryCallingCode(国家区号)、'
    + 'e164(标准 +区号号码)、valid(严格校验是否有效)、possible(仅长度校验)、'
    + 'type(号码类型如 MOBILE/FIXED_LINE/TOLL_FREE,判不出为 null)、national(国内书写格式)。'
    + '号码不带 + 前缀时必须给 defaultCountry;号码过短或国家无法确定时返回错误。'
    + '注意:号码解析得出但校验不过时不报错,返回 valid:false 的结构化结果。',
  inputSchema: {
    number: z.string().describe('电话号码,如 +8613800138000 或 (213) 373-4253'),
    defaultCountry: z.string().optional().describe('默认国家的两位 ISO 码,如 CN/US;号码不带 + 前缀时必需'),
  },
}, async ({ number, defaultCountry }) => {
  const parsed = tryParse(number, defaultCountry);
  if (!parsed) {
    return { isError: true, content: [{ type: 'text', text: `parse-phone: 无法解析「${number}」——号码过短、国家无法确定或不含有效号码` }] };
  }
  const result = {
    input: number,
    country: parsed.country ?? null,
    countryCallingCode: parsed.countryCallingCode,
    e164: parsed.number,
    valid: parsed.isValid(),
    possible: parsed.isPossible(),
    type: parsed.getType() ?? null,
    national: parsed.formatNational(),
  };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

server.registerTool('format-phone', {
  description:
    '把电话号码一次转成四种标准写法,返回 JSON:e164(+8613800138000)、international(+86 138 0013 8000)、'
    + 'national(138 0013 8000)、uri(tel: 链接),并附 valid 标志供调用方判断是否可信。'
    + '号码不带 + 前缀时必须给 defaultCountry;完全无法解析时返回错误。',
  inputSchema: {
    number: z.string().describe('电话号码,如 +8613800138000 或 13800138000'),
    defaultCountry: z.string().optional().describe('默认国家的两位 ISO 码,如 CN/US;号码不带 + 前缀时必需'),
  },
}, async ({ number, defaultCountry }) => {
  const parsed = tryParse(number, defaultCountry);
  if (!parsed) {
    return { isError: true, content: [{ type: 'text', text: `format-phone: 无法解析「${number}」——号码过短、国家无法确定或不含有效号码` }] };
  }
  const result = {
    e164: parsed.number,
    international: parsed.formatInternational(),
    national: parsed.formatNational(),
    uri: parsed.getURI(),
    valid: parsed.isValid(),
  };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
