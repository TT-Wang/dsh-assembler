#!/usr/bin/env node
/**
 * MCP stdio server: 数字与中文数字互转,基于 nzh@1(简体 nzh/cn)。
 * 能力点:阿拉伯数字 → 中文小写(一二三)/大写(壹贰叁)/人民币金额大写,
 * 以及中文数字 → 阿拉伯数字——agent 开票据、写合同金额、读中文数字,一轮内完成。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import nzhcn from 'nzh/cn';

const server = new McpServer({ name: 'num-to-chinese', version: '0.0.1' });

// 合法数字字符串(nzh 对非法输入原样返回,故先自行把关);支持科学记数法
const NUM_RE = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;
// decode 可识别的字符集(cn_s + cn_b 的数字/单位/负/点)
const CN_RE = /^[零一二三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟负点]+$/;
const UPPER_RE = /[壹贰叁肆伍陆柒捌玖拾佰仟]/;

server.registerTool('to-chinese', {
  description:
    '阿拉伯数字转中文。mode 取 lower(小写,如 10203 → 一万零二百零三)/ '
    + 'upper(大写,如 1234 → 壹仟贰佰叁拾肆)/ money(人民币金额大写,如 1234.5 → '
    + '人民币壹仟贰佰叁拾肆元伍角,整数补"整",角分以下截断),默认 lower。'
    + 'value 接受数字或数字字符串(含科学记数法);以字符串方式转换,超大数不失真。'
    + '非数字输入返回错误。',
  inputSchema: {
    value: z.union([z.string(), z.number()]).describe('要转换的数字或数字字符串,如 1234.5 或 "1.2e10"'),
    mode: z.enum(['lower', 'upper', 'money']).optional().describe('转换模式,默认 lower'),
  },
}, async ({ value, mode }) => {
  const num = String(value).trim();
  if (!NUM_RE.test(num)) {
    return { isError: true, content: [{ type: 'text', text: `to-chinese: "${num}" 不是合法数字` }] };
  }
  const m = mode ?? 'lower';
  const out = m === 'money' ? nzhcn.toMoney(num)
    : m === 'upper' ? nzhcn.encodeB(num)
    : nzhcn.encodeS(num);
  return { content: [{ type: 'text', text: out }] };
});

server.registerTool('from-chinese', {
  description:
    '中文数字转阿拉伯数字,返回数字字符串(超大数不走科学记数法)。支持小写(一万零二百零三 → 10203)'
    + '与大写(壹仟贰佰叁拾肆 → 1234),含"负"与小数"点"。mode 取 auto(默认,按是否出现壹贰叁等'
    + '大写字符自动选择)/ lower / upper。含无法识别字符(如"两"、非数字汉字)时返回错误。',
  inputSchema: {
    text: z.string().describe('中文数字字符串,如 "一万零二百零三" 或 "壹仟贰佰叁拾肆"'),
    mode: z.enum(['auto', 'lower', 'upper']).optional().describe('小写/大写体系,默认 auto 自动判断'),
  },
}, async ({ text, mode }) => {
  const s = text.trim();
  if (s.length === 0 || !CN_RE.test(s)) {
    return {
      isError: true,
      content: [{ type: 'text', text: `from-chinese: "${text}" 含无法识别的字符,仅支持零一二三四五六七八九十百千万亿/壹贰叁肆伍陆柒捌玖拾佰仟/负/点` }],
    };
  }
  const m = mode ?? 'auto';
  const useUpper = m === 'upper' || (m === 'auto' && UPPER_RE.test(s));
  const out = useUpper ? nzhcn.decodeB(s, { outputString: true }) : nzhcn.decodeS(s, { outputString: true });
  return { content: [{ type: 'text', text: String(out) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
