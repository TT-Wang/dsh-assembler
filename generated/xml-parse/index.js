/**
 * @dsh-index/xml-parse — MCP stdio server wrapping fast-xml-parser@4.4.0.
 *
 * Tools (最终工具名 mcp__xml-parse__<tool>):
 *   - xml-validate : 校验 XML 语法，返回 {valid:true} 或 {valid:false, error:{code,msg,line,col}}
 *   - xml-parse    : 解析 XML 为 JSON（可先校验；支持常用解析选项），返回 {parsed}
 *   - xml-build    : 由 JSON 对象构建/序列化 XML（可格式化），返回 {xml, note?}
 *
 * 只读使用上游库（fast-xml-parser），不修改上游代码。实现为 ESM，stdio 通信。
 * 每个工具调用无跨调用状态；全部本地执行，无网络依赖。
 *
 * 上游默认行为提示（与工具描述一致）：
 *   - XMLParser 默认 ignoreAttributes:true（属性不进入解析结果），需要属性时传
 *     options.ignoreAttributes:false（属性键形如 "@_id"）
 *   - XMLBuilder 默认 ignoreAttributes:true（"@_" 前缀键按普通标签处理），构建含属性
 *     的 XML 需传 options.ignoreAttributes:false
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser';

const server = new McpServer({
  name: 'xml-parse',
  version: '0.0.1'
});

/** 把用户可读的异常转成 MCP 文本错误内容（isError=true 便于调用方识别失败） */
function errContent(label, err) {
  const msg = err && err.message ? err.message : String(err);
  return { content: [{ type: 'text', text: `${label}: ${msg}` }], isError: true };
}

/** 校验必填字符串参数：缺失、非字符串、空白串都视为非法 */
function requireString(args, key, label) {
  const v = args[key];
  if (v === undefined || v === null) {
    return `缺少必填参数 ${key}（${label}）`;
  }
  if (typeof v !== 'string') {
    return `参数 ${key}（${label}）类型错误：期望 string，实际为 ${typeof v}`;
  }
  if (!v.trim()) {
    return `参数 ${key}（${label}）为空字符串`;
  }
  return null;
}

/** 解析器选项白名单：仅把用户显式传入的键传给上游，未传的保持上游默认值 */
const PARSE_OPTION_KEYS = [
  'ignoreAttributes',
  'attributeNamePrefix',
  'parseTagValue',
  'trimValues',
  'removeNSPrefix',
  'preserveOrder',
  'textNodeName',
  'cdataPropName',
  'commentPropName',
  'unpairedTags',
  'allowBooleanAttributes',
  'processEntities',
  'htmlEntities'
];

/** 构建器选项白名单：仅把用户显式传入的键传给上游，未传的保持上游默认值 */
const BUILD_OPTION_KEYS = [
  'format',
  'indentBy',
  'ignoreAttributes',
  'attributeNamePrefix',
  'textNodeName',
  'cdataPropName',
  'commentPropName',
  'suppressEmptyNode',
  'suppressUnpairedNode',
  'suppressBooleanAttributes',
  'arrayNodeName',
  'processEntities',
  'unpairedTags'
];

/** 从用户传入的 options 对象中挑出白名单内的键（仅保留显式设置的，undefined 剔除） */
function pickOptions(userOptions, keys) {
  if (!userOptions || typeof userOptions !== 'object') return {};
  const out = {};
  for (const key of keys) {
    if (userOptions[key] !== undefined) out[key] = userOptions[key];
  }
  return out;
}

/** 校验器选项（validate 用）：allowBooleanAttributes / unpairedTags */
function pickValidateOptions(userOptions) {
  const out = {};
  if (userOptions && typeof userOptions === 'object') {
    if (userOptions.allowBooleanAttributes !== undefined) out.allowBooleanAttributes = userOptions.allowBooleanAttributes;
    if (userOptions.unpairedTags !== undefined) out.unpairedTags = userOptions.unpairedTags;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 工具 1：xml-validate — XML 语法校验                                  */
/* ------------------------------------------------------------------ */
server.tool(
  'xml-validate',
  '校验一段 XML/HTML 标记的语法是否正确（是否良构 well-formed）。' +
    '参数：xml（必填，待校验的 XML 字符串）、allowBooleanAttributes（可选，默认 false，true 时允许无值的布尔属性如 <input disabled>）、' +
    'unpairedTags（可选，无闭合标签的标签名数组，如 ["br","hr"]，用于 HTML 片段校验）。' +
    '返回：{valid:true} 表示语法合法；{valid:false, error:{code,msg,line,col}} 给出错误码、错误信息与出错位置（1 起始行/列）。' +
    '典型用途：在解析/转换前先确认 XML 是否良构，定位格式错误的具体行列。',
  {
    xml: z.string().min(1, 'xml 不能为空'),
    allowBooleanAttributes: z.boolean().optional(),
    unpairedTags: z.array(z.string().min(1)).optional()
  },
  async (args) => {
    const missing = requireString(args, 'xml', '待校验的 XML 字符串');
    if (missing) return errContent('xml-validate 参数错误', new Error(missing));

    try {
      const opts = {};
      if (args.allowBooleanAttributes !== undefined) opts.allowBooleanAttributes = args.allowBooleanAttributes;
      if (args.unpairedTags !== undefined && args.unpairedTags.length > 0) opts.unpairedTags = args.unpairedTags;
      const result = XMLValidator.validate(args.xml, opts);
      if (result === true) {
        return { content: [{ type: 'text', text: JSON.stringify({ valid: true }) }] };
      }
      const payload = { valid: false, error: result.err };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: true
      };
    } catch (err) {
      return errContent('xml-validate 执行失败', err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* 工具 2：xml-parse — 解析 XML 为 JSON                                 */
/* ------------------------------------------------------------------ */
server.tool(
  'xml-parse',
  '把 XML 字符串解析为 JSON 对象（fast-xml-parser v4 语义）。' +
    '参数：xml（必填，待解析的 XML 字符串）、validate（可选，默认 true，解析前先做语法校验，XML 非法时直接返回带行列的校验错误而不是产出畸形结果；' +
    '对非良构但需尽力解析的场景可设 false）、pretty（可选，默认 true，JSON 输出是否缩进美化）、' +
    'options（可选，解析选项对象，仅传入的键生效，未传保持上游默认）：' +
    'ignoreAttributes（默认 true，注意：true 时属性不会出现在结果里；要保留属性必须设 false，属性键形如 "@_id"）、' +
    'attributeNamePrefix（默认 "@_"，属性键前缀）、parseTagValue（默认 true，标签文本自动转数字/布尔）、' +
    'trimValues（默认 true，去除文本首尾空白）、removeNSPrefix（默认 false，去掉标签/属性名的命名空间前缀）、' +
    'preserveOrder（默认 false，true 时返回保留标签顺序的数组结构）、textNodeName（默认 "#text"）、' +
    'cdataPropName（可选，设置后 CDATA 存到该属性名下，如 "cdata"）、commentPropName（可选，设置后注释存到该属性名下）、' +
    'unpairedTags（无闭合标签的标签名数组）、allowBooleanAttributes（默认 false，配合 validate 使用）、' +
    'processEntities（默认 true，处理默认与 DOCTYPE 实体）、htmlEntities（默认 false，true 时处理 HTML 实体）。' +
    '返回：{parsed: <解析后的 JSON>}。' +
    '典型用途：把 XML/配置文件/接口响应解析成 JSON 供后续处理；大文档输出可能较大。',
  {
    xml: z.string().min(1, 'xml 不能为空'),
    validate: z.boolean().optional(),
    pretty: z.boolean().optional(),
    options: z
      .object({
        ignoreAttributes: z.boolean().optional(),
        attributeNamePrefix: z.string().optional(),
        parseTagValue: z.boolean().optional(),
        trimValues: z.boolean().optional(),
        removeNSPrefix: z.boolean().optional(),
        preserveOrder: z.boolean().optional(),
        textNodeName: z.string().optional(),
        cdataPropName: z.union([z.string(), z.boolean()]).optional(),
        commentPropName: z.union([z.string(), z.boolean()]).optional(),
        unpairedTags: z.array(z.string().min(1)).optional(),
        allowBooleanAttributes: z.boolean().optional(),
        processEntities: z.boolean().optional(),
        htmlEntities: z.boolean().optional()
      })
      .optional()
  },
  async (args) => {
    const missing = requireString(args, 'xml', '待解析的 XML 字符串');
    if (missing) return errContent('xml-parse 参数错误', new Error(missing));

    try {
      const opts = pickOptions(args.options, PARSE_OPTION_KEYS);

      // 默认先校验：XML 非法时返回结构化校验错误（code/msg/line/col）
      const doValidate = args.validate !== false;
      if (doValidate) {
        const vResult = XMLValidator.validate(args.xml, pickValidateOptions(args.options));
        if (vResult !== true) {
          const err = vResult.err;
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'XML 语法校验未通过',
                  code: err.code,
                  msg: err.msg,
                  line: err.line,
                  col: err.col,
                  hint: '如确需尽力解析非法 XML，请设 validate:false'
                })
              }
            ],
            isError: true
          };
        }
      }

      const parser = new XMLParser(opts);
      const parsed = parser.parse(args.xml);
      const text = JSON.stringify(parsed, null, args.pretty === false ? 0 : 2);
      return { content: [{ type: 'text', text: JSON.stringify({ parsed: JSON.parse(text) }) }] };
    } catch (err) {
      return errContent('xml-parse 执行失败', err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* 工具 3：xml-build — 由 JSON 构建 XML                                 */
/* ------------------------------------------------------------------ */
server.tool(
  'xml-build',
  '把 JSON 对象序列化为 XML 字符串（fast-xml-parser v4 XMLBuilder 语义），可配合 xml-parse 做 XML↔JSON 往返。' +
    '参数：json（必填，JSON 对象/数组，或 JSON 字符串；属性键用 "@_" 前缀表示，文本值用 textNodeName（默认 "#text"）键表示）、' +
    'options（可选，构建选项对象，仅传入的键生效，未传保持上游默认）：' +
    'format（默认 false，true 时输出带缩进的多行 XML）、indentBy（默认 "  "，format=true 时的缩进串）、' +
    'ignoreAttributes（默认 true，注意：true 时 "@_" 前缀键会被当作普通标签名输出；要用属性必须设 false）、' +
    'attributeNamePrefix（默认 "@_"）、textNodeName（默认 "#text"）、' +
    'cdataPropName（可选，对应解析时的 cdataPropName，CDATA 节点键名）、commentPropName（可选，注释节点键名）、' +
    'suppressEmptyNode（默认 false，true 时空节点输出为 <tag/>）、suppressUnpairedNode（默认 true）、' +
    'suppressBooleanAttributes（默认 true，true 时布尔属性输出为无值形式）、' +
    'arrayNodeName（可选，顶层为数组时的包装根标签名，如 "root"；顶层数组未提供该选项时自动以 "root" 包装并在 note 中说明）、' +
    'processEntities（默认 true）、unpairedTags（无闭合标签的标签名数组）。' +
    '返回：{xml: <构建出的 XML 字符串>, note?: 自动处理说明}。' +
    '典型用途：把 JSON 数据/配置序列化为 XML 报文或文档；与 xml-parse 组合实现 XML 改写（解析→改 JSON→重建）。',
  {
    json: z.union([z.record(z.unknown()), z.array(z.unknown()), z.string().min(1, 'json 不能为空')]),
    options: z
      .object({
        format: z.boolean().optional(),
        indentBy: z.string().optional(),
        ignoreAttributes: z.boolean().optional(),
        attributeNamePrefix: z.string().optional(),
        textNodeName: z.string().optional(),
        cdataPropName: z.union([z.string(), z.boolean()]).optional(),
        commentPropName: z.union([z.string(), z.boolean()]).optional(),
        suppressEmptyNode: z.boolean().optional(),
        suppressUnpairedNode: z.boolean().optional(),
        suppressBooleanAttributes: z.boolean().optional(),
        arrayNodeName: z.string().optional(),
        processEntities: z.boolean().optional(),
        unpairedTags: z.array(z.string().min(1)).optional()
      })
      .optional()
  },
  async (args) => {
    try {
      let jObj = args.json;
      // 兼容 JSON 字符串入参
      if (typeof jObj === 'string') {
        try {
          jObj = JSON.parse(jObj);
        } catch (e) {
          return errContent('xml-build 参数错误', new Error(`json 不是合法 JSON 字符串: ${e.message}`));
        }
      }
      if (jObj === null || typeof jObj !== 'object') {
        return errContent('xml-build 参数错误', new Error('json 必须是对象、数组或 JSON 字符串'));
      }

      const opts = pickOptions(args.options, BUILD_OPTION_KEYS);
      const notes = [];

      // 顶层数组：XML 需要单一根节点，未指定 arrayNodeName 时自动以 root 包装
      if (Array.isArray(jObj) && !opts.arrayNodeName) {
        opts.arrayNodeName = 'root';
        notes.push('顶层为数组，已自动以 arrayNodeName="root" 包装（fast-xml-parser 上游语义：每个数组元素各生成一个 <root> 根节点，注意多根输出非良构 XML；可用 options.arrayNodeName 自定义）');
      }

      const builder = new XMLBuilder(opts);
      const xml = builder.build(jObj);
      const payload = { xml, ...(notes.length > 0 ? { note: notes.join('；') } : {}) };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    } catch (err) {
      return errContent('xml-build 执行失败', err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* 启动 stdio 服务器                                                    */
/* ------------------------------------------------------------------ */
const transport = new StdioServerTransport();
await server.connect(transport);
