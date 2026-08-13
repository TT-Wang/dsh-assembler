/**
 * @dsh-index/date-format — MCP stdio server exposing dayjs (v1.11.11) as tools.
 *
 * Tools (final names under dsh mcp-client: mcp__date-format__<tool>):
 *   format-date     — 按自定义模板格式化日期时间
 *   parse-date      — 解析日期字符串为结构化字段
 *   date-diff       — 计算两个日期之间的差值
 *   date-manipulate — 对日期做 add/subtract/startOf/endOf 操作
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import utc from 'dayjs/plugin/utc.js'
import quarterOfYear from 'dayjs/plugin/quarterOfYear.js'

dayjs.extend(customParseFormat)
dayjs.extend(utc)
dayjs.extend(quarterOfYear)

const server = new McpServer({ name: 'date-format', version: '0.0.1' })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 解析用户输入为一个 dayjs 实例。
 * @param {string|number} [input] 日期字符串（ISO 8601 / RFC 2822 / 自然语言见 dayjs 文档）
 *                                或 Unix 毫秒时间戳数字；缺省/空串 = 当前时间
 * @param {string} [inputFormat] 非 ISO 输入时的解析模板（customParseFormat），如 'DD/MM/YYYY'
 * @param {boolean} [useUtc] 是否按 UTC 解析与取值
 * @returns {import('dayjs').Dayjs}
 * @throws {Error} 参数类型错误或解析失败
 */
function toDayjs(input, inputFormat, useUtc) {
  let d
  const isEmpty = input === undefined || input === null || input === ''
  if (isEmpty) {
    d = useUtc ? dayjs.utc() : dayjs()
    return d
  }
  if (typeof input !== 'string' && typeof input !== 'number') {
    throw new Error(`参数 input 必须是字符串或数字时间戳，收到: ${typeof input}`)
  }
  if (typeof input === 'number' && !Number.isFinite(input)) {
    throw new Error(`参数 input 不是有效数字: ${input}`)
  }
  if (inputFormat) {
    if (typeof inputFormat !== 'string' || !inputFormat.trim()) {
      throw new Error(`参数 inputFormat 必须是合法模板字符串，收到: ${JSON.stringify(inputFormat)}`)
    }
    d = dayjs(input, inputFormat)
  } else {
    d = dayjs(input)
  }
  if (!d.isValid()) {
    throw new Error(
      `无法解析日期输入 "${input}"${inputFormat ? `（模板 "${inputFormat}"）` : ''}。` +
      '请输入 ISO 8601 字符串（如 "2024-05-06T10:30:00Z" 或 "2024-05-06"）、RFC 2822、' +
      'Unix 毫秒时间戳数字，或提供 inputFormat 指定解析模板。'
    )
  }
  return useUtc ? d.utc() : d
}

/** 将 dayjs 实例格式化为字符串；失败时抛出清晰错误。 */
function formatWith(d, format) {
  if (format !== undefined && format !== null && format !== '') {
    if (typeof format !== 'string') {
      throw new Error(`参数 format 必须是字符串，收到: ${typeof format}`)
    }
    return d.format(format)
  }
  return d.format('YYYY-MM-DD HH:mm:ss')
}

/** 统一的成功文本消息。 */
function okText(text) {
  return { content: [{ type: 'text', text }] }
}

/** 统一的错误文本消息（工具不抛异常，由 SDK 返回错误内容）。 */
function errText(error) {
  const msg = error && error.message ? error.message : String(error)
  return { content: [{ type: 'text', text: `错误: ${msg}` }] }
}

// ---------------------------------------------------------------------------
// 工具 1: format-date
// ---------------------------------------------------------------------------
server.tool(
  'format-date',
  '将日期时间按自定义模板格式化为字符串（基于 dayjs.format）。' +
    '输入可为 ISO 8601 字符串（如 "2024-05-06T10:30:00Z"）、RFC 2822、Unix 毫秒时间戳数字，或省略以使用当前时间。' +
    '支持模板 token：YYYY/YY=年，MM/M=月，DD/D=日，HH/H=24小时，hh/h=12小时，mm=分，ss=秒，SSS=毫秒，' +
    'A/a=上午下午，ddd/dddd=星期缩写/全称，DDD=年内第几天，Z/ZZ=时区偏移，X=Unix秒，x=Unix毫秒，[文字]=原样输出。',
  {
    input: z
      .union([z.string(), z.number()])
      .optional()
      .describe('待格式化的日期（字符串或数字 Unix 毫秒时间戳）。缺省或空串表示当前时间。'),
    format: z
      .string()
      .optional()
      .describe('输出模板，默认 "YYYY-MM-DD HH:mm:ss"。例："YYYY年MM月DD日 HH:mm"、"ddd, DD MMM YYYY"、"x"。'),
    inputFormat: z
      .string()
      .optional()
      .describe('可选。input 不是标准格式时的解析模板，如 "DD/MM/YYYY"。'),
    utc: z
      .boolean()
      .optional()
      .describe('可选。true 时按 UTC 解析并输出，默认 false（本地时区）。'),
  },
  async (args) => {
    try {
      const { input, format, inputFormat, utc } = args
      const d = toDayjs(input, inputFormat, utc === true)
      return okText(formatWith(d, format))
    } catch (e) {
      return errText(e)
    }
  }
)

// ---------------------------------------------------------------------------
// 工具 2: parse-date
// ---------------------------------------------------------------------------
server.tool(
  'parse-date',
  '解析日期字符串/时间戳为结构化字段（年、月、日、时分秒、星期、时区、Unix 时间等），并校验有效性。' +
    '输入不合法（如 "2024-13-45"、"abc"）时返回明确错误。适用于日期校验、提取日期组成部分、转换时区表示。',
  {
    input: z
      .union([z.string(), z.number()])
      .describe('必填。要解析的日期字符串或 Unix 毫秒时间戳数字。'),
    inputFormat: z
      .string()
      .optional()
      .describe('可选。非标准输入（如 "31/12/2024"）的解析模板，如 "DD/MM/YYYY"。'),
    utc: z
      .boolean()
      .optional()
      .describe('可选。true 时按 UTC 取值（各字段为 UTC 时间），默认 false（本地时区）。'),
  },
  async (args) => {
    try {
      const { input, inputFormat, utc } = args
      if (input === undefined || input === null || input === '') {
        return errText(new Error('缺少必填参数 input：请输入要解析的日期字符串或时间戳。'))
      }
      const d = toDayjs(input, inputFormat, utc === true)
      const result = {
        input: String(input),
        valid: true,
        iso: d.toISOString(),
        unix: d.unix(),
        timestampMs: d.valueOf(),
        year: d.year(),
        month: d.month() + 1, // 1-12
        day: d.date(),
        dayOfWeek: d.day(), // 0=周日
        hour: d.hour(),
        minute: d.minute(),
        second: d.second(),
        millisecond: d.millisecond(),
        utcOffsetMinutes: d.utcOffset(),
        isUtc: utc === true,
      }
      return okText(JSON.stringify(result, null, 2))
    } catch (e) {
      return errText(e)
    }
  }
)

// ---------------------------------------------------------------------------
// 工具 3: date-diff
// ---------------------------------------------------------------------------
server.tool(
  'date-diff',
  '计算两个日期之间的差值（基于 dayjs.diff）。dateA 减去 dateB，结果可为正（dateA 更晚）或负（dateA 更早）。' +
    '支持毫秒/秒/分/时/天/周/月/季度/年。适合计算年龄、倒计时、时间间隔、时长等场景。',
  {
    dateA: z
      .union([z.string(), z.number()])
      .describe('必填。被减日期（ISO 8601 字符串、Unix 毫秒时间戳数字或带 inputFormat 的非标准串）。'),
    dateB: z
      .union([z.string(), z.number()])
      .optional()
      .describe('可选。减去的日期，缺省为当前时间。'),
    unit: z
      .enum(['millisecond', 'second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'])
      .optional()
      .describe('差值单位，默认 "day"。注意 month/quarter/year 为按自然月/季度折算（非固定 30 天）。'),
    inputFormat: z
      .string()
      .optional()
      .describe('可选。dateA/dateB 均非标准格式时使用的解析模板，如 "DD/MM/YYYY"。'),
    utc: z
      .boolean()
      .optional()
      .describe('可选。true 时按 UTC 解析，默认 false。'),
  },
  async (args) => {
    try {
      const { dateA, dateB, unit, inputFormat, utc } = args
      if (dateA === undefined || dateA === null || dateA === '') {
        return errText(new Error('缺少必填参数 dateA。'))
      }
      const u = unit || 'day'
      const a = toDayjs(dateA, inputFormat, utc === true)
      const b = toDayjs(dateB, inputFormat, utc === true)
      const diff = a.diff(b, u)
      const abs = Math.abs(diff)
      const text =
        diff === 0
          ? `${a.format('YYYY-MM-DD HH:mm:ss')} 与 ${b.format('YYYY-MM-DD HH:mm:ss')} 相同（差值 0 ${u}）`
          : `${a.format('YYYY-MM-DD HH:mm:ss')} 比 ${b.format('YYYY-MM-DD HH:mm:ss')} ${diff > 0 ? '晚' : '早'} ${abs} ${u}（有符号差值 ${diff}）`
      return okText(text)
    } catch (e) {
      return errText(e)
    }
  }
)

// ---------------------------------------------------------------------------
// 工具 4: date-manipulate
// ---------------------------------------------------------------------------
server.tool(
  'date-manipulate',
  '对日期做加法/减法/取区间起点/取区间终点（基于 dayjs add/subtract/startOf/endOf，不可变链式）。' +
    '如：加 3 天、减 1 个月、取本月第一天、取当天 23:59:59.999。返回格式化结果、ISO 与 Unix 时间戳。',
  {
    operation: z
      .enum(['add', 'subtract', 'startOf', 'endOf'])
      .describe('必填。add=加，subtract=减，startOf=取该单位区间起点（忽略 amount），endOf=取该单位区间终点（忽略 amount）。'),
    input: z
      .union([z.string(), z.number()])
      .optional()
      .describe('可选。操作对象日期（ISO 8601 / Unix 毫秒时间戳 / inputFormat 模板），缺省为当前时间。'),
    amount: z
      .number()
      .optional()
      .describe('可选。add/subtract 的数量，默认 1；startOf/endOf 忽略此参数。'),
    unit: z
      .enum(['year', 'month', 'week', 'day', 'hour', 'minute', 'second', 'millisecond'])
      .optional()
      .describe('可选。操作单位，默认 "day"。'),
    format: z
      .string()
      .optional()
      .describe('可选。结果输出模板，默认 "YYYY-MM-DD HH:mm:ss"。'),
    inputFormat: z
      .string()
      .optional()
      .describe('可选。input 非标准格式时的解析模板，如 "DD/MM/YYYY"。'),
    utc: z
      .boolean()
      .optional()
      .describe('可选。true 时按 UTC 解析并输出，默认 false。'),
  },
  async (args) => {
    try {
      const { operation, input, amount, unit, format, inputFormat, utc } = args
      if (!operation) {
        return errText(new Error('缺少必填参数 operation（add/subtract/startOf/endOf）。'))
      }
      const u = unit || 'day'
      let d = toDayjs(input, inputFormat, utc === true)
      if (operation === 'add' || operation === 'subtract') {
        const n = amount === undefined || amount === null ? 1 : Number(amount)
        if (!Number.isFinite(n)) {
          return errText(new Error(`amount 必须是数字，收到: ${JSON.stringify(amount)}`))
        }
        d = operation === 'add' ? d.add(n, u) : d.subtract(n, u)
      } else {
        d = operation === 'startOf' ? d.startOf(u) : d.endOf(u)
      }
      const result = {
        operation,
        unit: u,
        amount: operation === 'add' || operation === 'subtract' ? Number(amount ?? 1) : undefined,
        formatted: formatWith(d, format),
        iso: d.toISOString(),
        unix: d.unix(),
        timestampMs: d.valueOf(),
      }
      return okText(JSON.stringify(result, null, 2))
    } catch (e) {
      return errText(e)
    }
  }
)

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
await server.connect(new StdioServerTransport())
