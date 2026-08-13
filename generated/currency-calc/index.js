/**
 * @dsh-index/currency-calc — MCP stdio server 基于 currency.js v2.0.4 (MIT)。
 *
 * Tools（在 dsh mcp-client 下的最终名称为 mcp__currency-calc__<tool>）:
 *   currency-calc       — 精度安全的货币四则运算（add/subtract/multiply/divide）
 *   currency-format     — 按符号/千分位/小数位/模式等选项格式化金额
 *   currency-distribute — 将金额均分为 N 份（余数依次堆到前面的份上）
 *   currency-parse      — 解析金额字符串/数值为结构化字段并校验
 *
 * currency.js 内部以整数（分）运算，规避 JS 浮点误差（如 2.51 + 0.01 === 2.52）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import currency from 'currency.js'

const server = new McpServer({ name: 'currency-calc', version: '0.0.1' })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 统一成功文本消息。 */
function okText(text) {
  return { content: [{ type: 'text', text }] }
}

/** 统一错误文本消息（工具不抛异常，由 SDK 返回错误内容）。 */
function errText(error) {
  const msg = error && error.message ? error.message : String(error)
  return { content: [{ type: 'text', text: `错误: ${msg}` }] }
}

/**
 * 校验金额输入：数字必须有限，字符串必须至少含一个数字（否则库会静默解析为 0）。
 * @param {string|number} value
 * @param {string} label 参数名，用于错误提示
 */
function assertAmount(value, label) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} 必须是有限数字，收到: ${value}`)
    }
    return
  }
  if (typeof value === 'string') {
    if (!/\d/.test(value)) {
      throw new Error(`${label} 必须是可解析的金额字符串（需包含至少一个数字），收到: ${JSON.stringify(value)}`)
    }
    return
  }
  throw new Error(`${label} 必须是数字或金额字符串，收到类型: ${typeof value}`)
}

/** 校验 precision 取值范围（0-12，避免 10^p 溢出）。 */
function assertPrecision(precision) {
  if (precision !== undefined && precision !== null) {
    if (!Number.isInteger(precision) || precision < 0 || precision > 12) {
      throw new Error(`precision 必须是 0-12 的整数，收到: ${JSON.stringify(precision)}`)
    }
  }
}

/**
 * 从工具参数中提取 currency.js 选项。
 * symbol 允许传空字符串（表示去掉货币符号）；其余字符串选项忽略空串。
 */
function buildFormatOpts(args) {
  const opts = {}
  if (args.symbol !== undefined && args.symbol !== null) opts.symbol = args.symbol
  for (const k of ['separator', 'decimal', 'pattern', 'negativePattern']) {
    if (args[k] !== undefined && args[k] !== null && args[k] !== '') opts[k] = args[k]
  }
  if (args.increment !== undefined && args.increment !== null) opts.increment = args.increment
  if (args.precision !== undefined && args.precision !== null) opts.precision = args.precision
  if (args.fromCents === true) opts.fromCents = true
  if (args.useVedic === true) opts.useVedic = true
  return opts
}

/** 创建 currency 实例，异常统一转成清晰错误。 */
function makeCurrency(value, opts) {
  assertPrecision(opts.precision)
  try {
    return currency(value, opts)
  } catch (e) {
    throw new Error(`无法创建金额对象（${e.message}）`)
  }
}

/** 提取金额对象的数值/整数分/格式化信息。 */
function moneyInfo(c) {
  return {
    value: c.value,
    intValue: c.intValue,
    dollars: c.dollars(),
    cents: c.cents(),
    formatted: c.format(),
  }
}

// ---------------------------------------------------------------------------
// 工具 1: currency-calc
// ---------------------------------------------------------------------------
server.tool(
  'currency-calc',
  '精度安全的货币四则运算（基于 currency.js，内部按整数分运算，规避 JS 浮点误差，如 2.51+0.01=2.52）。' +
    'op=add/subtract/multiply/divide；value 为基础金额、operand 为运算数，两者均可为数字或含货币符号/千分位的字符串（如 "$12.30"、"1,234.56"，"(2.5)" 表示负数）。' +
    'multiply 时 operand 为倍数，divide 时 operand 为除数（不能为 0）。' +
    '可指定 precision（小数位，默认 2）、fromCents（输入按最小货币单位如“分”解析）、increment（结果舍入增量，如 0.05 舍入到 5 分）、' +
    'symbol/separator/decimal（结果格式化样式）。返回结果数值、整数分、格式化字符串与精度信息。',
  {
    op: z
      .enum(['add', 'subtract', 'multiply', 'divide'])
      .describe('必填。运算类型：add=加，subtract=减，multiply=乘，divide=除。'),
    value: z
      .union([z.string(), z.number()])
      .describe('必填。基础金额：数字或金额字符串（自动剥离货币符号与千分位），如 1.23、"$12.30"、"1,234.56"。"(2.5)" 表示 -2.5。'),
    operand: z
      .union([z.string(), z.number()])
      .describe('必填。运算数：add/subtract 时为加数/减数，multiply 时为倍数，divide 时为除数（不能为 0）。可为数字或金额字符串。'),
    precision: z
      .number()
      .int()
      .min(0)
      .max(12)
      .optional()
      .describe('可选。小数位数（存储精度），默认 2。JPY 等无小数货币用 0，GAS 可用 3。'),
    fromCents: z
      .boolean()
      .optional()
      .describe('可选。true 时 value/operand 按最小货币单位（分）解析，如 123 → 1.23。默认 false。'),
    increment: z
      .number()
      .positive()
      .optional()
      .describe('可选。结果四舍五入到的增量（如 0.05 表示舍入到 5 分）。默认按 precision 精确值。'),
    symbol: z
      .string()
      .optional()
      .describe('可选。格式化时的货币符号，默认 "$"；传空字符串 "" 表示不带符号。仅影响输出中的 formatted 字段。'),
    separator: z
      .string()
      .optional()
      .describe('可选。千分位分隔符，默认 ","（欧元区常用 "."）。'),
    decimal: z
      .string()
      .optional()
      .describe('可选。小数分隔符，默认 "."（欧元区常用 ","）。'),
  },
  async (args) => {
    try {
      const { op, value, operand } = args
      if (value === undefined || value === null || value === '') {
        return errText(new Error('缺少必填参数 value（基础金额）。'))
      }
      if (operand === undefined || operand === null || operand === '') {
        return errText(new Error('缺少必填参数 operand（运算数）。'))
      }
      assertAmount(value, 'value')
      assertAmount(operand, 'operand')

      const opts = buildFormatOpts(args)
      const base = makeCurrency(value, opts)
      let result
      switch (op) {
        case 'add':
          result = base.add(operand)
          break
        case 'subtract':
          result = base.subtract(operand)
          break
        case 'multiply': {
          const m = typeof operand === 'number' ? operand : Number(String(operand).replace(/[^-\d.]/g, ''))
          if (!Number.isFinite(m)) {
            return errText(new Error(`multiply 的 operand 无法解析为数字: ${JSON.stringify(operand)}`))
          }
          result = base.multiply(m)
          break
        }
        case 'divide': {
          const d = typeof operand === 'number' ? operand : Number(String(operand).replace(/[^-\d.]/g, ''))
          if (!Number.isFinite(d) || d === 0) {
            return errText(new Error(`divide 的 operand（除数）不能为 0: ${JSON.stringify(operand)}`))
          }
          result = base.divide(d)
          break
        }
        default:
          return errText(new Error(`不支持的运算类型: ${op}`))
      }
      const out = moneyInfo(result)
      out.op = op
      out.valueInput = value
      out.operandInput = operand
      out.precision = args.precision ?? 2
      out.fromCents = args.fromCents === true
      return okText(JSON.stringify(out, null, 2))
    } catch (e) {
      return errText(e)
    }
  }
)

// ---------------------------------------------------------------------------
// 工具 2: currency-format
// ---------------------------------------------------------------------------
server.tool(
  'currency-format',
  '按货币选项把金额格式化为字符串（基于 currency.js.format，自动放置千分位与货币符号）。' +
    'value 可为数字或字符串（自动解析符号、千分位与括号负数 "(2.5)"→-2.5）。' +
    '支持 symbol（货币符号，空串去掉符号）、separator（千分位）、decimal（小数分隔符）、precision（小数位）、' +
    'pattern/negativePattern（格式模板，! 为符号占位、# 为金额占位，如 negativePattern="(!#)" 输出括号负数）、' +
    'useVedic（印度编号系统分组，如 10,00,000.00）、increment（显示舍入增量，如 1.48+increment .05 → 1.50）、fromCents（输入为分）。' +
    '返回格式化字符串、解析后的数值与整数分。',
  {
    value: z
      .union([z.string(), z.number()])
      .describe('必填。要格式化的金额：数字或字符串，如 1234.56、"$1,234.56"、"(2.5)"。'),
    symbol: z
      .string()
      .optional()
      .describe('可选。货币符号，默认 "$"；传空字符串 "" 表示不带符号。'),
    separator: z
      .string()
      .optional()
      .describe('可选。千分位分隔符，默认 ","；传空字符串可禁用千分位。'),
    decimal: z
      .string()
      .optional()
      .describe('可选。小数分隔符，默认 "."。'),
    precision: z
      .number()
      .int()
      .min(0)
      .max(12)
      .optional()
      .describe('可选。小数位数，默认 2。'),
    pattern: z
      .string()
      .optional()
      .describe('可选。正数格式模板：! 为符号占位、# 为金额占位，默认 "!#"。'),
    negativePattern: z
      .string()
      .optional()
      .describe('可选。负数格式模板，默认 "-!#"，如 "(!#)" 表示括号负数。'),
    useVedic: z
      .boolean()
      .optional()
      .describe('可选。true 时使用印度编号系统分组（如 10,00,000.00），默认 false。'),
    increment: z
      .number()
      .positive()
      .optional()
      .describe('可选。显示舍入增量，如 value=1.48、increment=0.05 → "1.50"。'),
    fromCents: z
      .boolean()
      .optional()
      .describe('可选。true 时 value 按最小货币单位（分）解析，如 123 → "1.23"。默认 false。'),
  },
  async (args) => {
    try {
      if (args.value === undefined || args.value === null || args.value === '') {
        return errText(new Error('缺少必填参数 value（要格式化的金额）。'))
      }
      assertAmount(args.value, 'value')
      const opts = buildFormatOpts(args)
      const c = makeCurrency(args.value, opts)
      const out = {
        input: args.value,
        formatted: c.format(),
        value: c.value,
        intValue: c.intValue,
      }
      return okText(JSON.stringify(out, null, 2))
    } catch (e) {
      return errText(e)
    }
  }
)

// ---------------------------------------------------------------------------
// 工具 3: currency-distribute
// ---------------------------------------------------------------------------
server.tool(
  'currency-distribute',
  '将金额均分为 count 份（基于 currency.js.distribute：先整除，余下的最小货币单位依次堆到前面的份上，保证各份总和不变）。' +
    '如 currency(1.12).distribute(5) → [0.23, 0.23, 0.22, 0.22, 0.22]。' +
    '适合分摊账单、拆分订单金额等场景。返回每份的数值与格式化结果，并校验各份之和等于原金额。',
  {
    value: z
      .union([z.string(), z.number()])
      .describe('必填。要均分的总金额：数字或金额字符串，如 1.12、"$1.12"。'),
    count: z
      .number()
      .int()
      .min(1)
      .max(100000)
      .describe('必填。份数，正整数（上限 100000）。'),
    precision: z
      .number()
      .int()
      .min(0)
      .max(12)
      .optional()
      .describe('可选。小数位数，默认 2。'),
    fromCents: z
      .boolean()
      .optional()
      .describe('可选。true 时 value 按最小货币单位（分）解析。默认 false。'),
    symbol: z
      .string()
      .optional()
      .describe('可选。格式化货币符号，默认 "$"。'),
    separator: z
      .string()
      .optional()
      .describe('可选。千分位分隔符，默认 ","。'),
    decimal: z
      .string()
      .optional()
      .describe('可选。小数分隔符，默认 "."。'),
  },
  async (args) => {
    try {
      const { value, count } = args
      if (value === undefined || value === null || value === '') {
        return errText(new Error('缺少必填参数 value（要均分的总金额）。'))
      }
      if (count === undefined || count === null) {
        return errText(new Error('缺少必填参数 count（份数）。'))
      }
      assertAmount(value, 'value')
      const opts = buildFormatOpts(args)
      const c = makeCurrency(value, opts)
      const parts = c.distribute(count)
      const list = parts.map((p) => ({ value: p.value, formatted: p.format() }))
      const sum = parts.reduce((s, p) => s + p.value, 0)
      const out = {
        input: value,
        count,
        total: c.value,
        parts: list,
        sum,
        sumMatchesTotal: Math.abs(sum - c.value) < 1e-9,
      }
      return okText(JSON.stringify(out, null, 2))
    } catch (e) {
      return errText(e)
    }
  }
)

// ---------------------------------------------------------------------------
// 工具 4: currency-parse
// ---------------------------------------------------------------------------
server.tool(
  'currency-parse',
  '解析并校验金额输入（基于 currency.js 的解析规则：自动剥离货币符号与千分位、支持括号负数 "(1.99)"→-1.99、' +
    '可通过 decimal 指定非 "." 的小数分隔符以解析欧元格式如 "€2.573.693,75"）。' +
    '返回解析后的数值（value）、整数分（intValue）、整数元（dollars）与分位（cents），支持 fromCents（输入为最小货币单位）与 precision。' +
    '默认 errorOnInvalid=true：输入不含数字或类型非法时返回明确错误，避免静默解析为 0。',
  {
    value: z
      .union([z.string(), z.number()])
      .describe('必填。要解析的金额：数字或字符串，如 "1,234.56"、"$12.30"、"€2.573.693,75"、"(2.5)"、123。'),
    fromCents: z
      .boolean()
      .optional()
      .describe('可选。true 时按最小货币单位（分）解析，如 123 → 1.23。默认 false。'),
    precision: z
      .number()
      .int()
      .min(0)
      .max(12)
      .optional()
      .describe('可选。小数位数，默认 2。'),
    decimal: z
      .string()
      .optional()
      .describe('可选。字符串输入中的小数分隔符（如欧元区 ","），默认 "."。'),
    errorOnInvalid: z
      .boolean()
      .optional()
      .describe('可选。true（默认）时非法输入返回错误；false 时按 0 处理。'),
  },
  async (args) => {
    try {
      const { value } = args
      if (value === undefined || value === null || value === '') {
        return errText(new Error('缺少必填参数 value（要解析的金额）。'))
      }
      assertAmount(value, 'value')
      const opts = buildFormatOpts(args)
      if (args.errorOnInvalid === true) opts.errorOnInvalid = true
      const c = makeCurrency(value, opts)
      const out = {
        input: value,
        parsed: c.value,
        intValue: c.intValue,
        dollars: c.dollars(),
        cents: c.cents(),
        precision: args.precision ?? 2,
        fromCents: args.fromCents === true,
      }
      return okText(JSON.stringify(out, null, 2))
    } catch (e) {
      return errText(e)
    }
  }
)

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
await server.connect(new StdioServerTransport())
