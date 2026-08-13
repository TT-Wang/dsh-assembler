#!/usr/bin/env node
// @dsh-index/template-render — MCP stdio server wrapping handlebars.js v4.7.8
//
// Tools:
//   render-template     编译并渲染模板（变量/循环/条件/partials）-> 文本
//   precompile-template 预编译模板 -> TemplateSpecification 源码字符串
//   render-precompiled  用预编译 spec 渲染（省去重复编译）
//   validate-template   语法+编译校验 -> {valid, errors[]}
//
// 每个调用使用 Handlebars.create() 的隔离环境，避免跨调用全局污染（partials 注册等）。
import Handlebars from 'handlebars';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'template-render',
  version: '0.0.1'
});

// 任意 JSON 对象（渲染上下文）
const jsonObject = z.record(z.string(), z.unknown());

// 通用编译选项（render / validate 共用；precompile 另有扩展选项）
const compileOptions = z
  .object({
    noEscape: z
      .boolean()
      .optional()
      .describe('设为 true 时输出不做 HTML 转义（默认会转义 & < > 双引号、单引号、反引号与 =）'),
    strict: z
      .boolean()
      .optional()
      .describe('设为 true 时，引用不存在的字段/helper 会抛错而不是静默输出空串'),
    compat: z
      .boolean()
      .optional()
      .describe('启用 Mustache 兼容的递归向上查找（默认只查当前上下文）'),
    preventIndent: z
      .boolean()
      .optional()
      .describe('渲染 partial 时禁止自动缩进处理（仅与 partial 相关）'),
    assumeObjects: z
      .boolean()
      .optional()
      .describe('假设上下文路径均为对象，跳过属性存在性检查（性能优化，慎用）'),
    knownHelpersOnly: z
      .boolean()
      .optional()
      .describe('仅允许使用声明过的 helper（配合 knownHelpers 使用）')
  })
  .optional()
  .describe('Handlebars 编译选项');

/** 把异常转成带行列信息的清晰错误文本 */
function errorText(err) {
  const message = err && err.message ? err.message : String(err);
  const loc = [];
  if (err && typeof err.lineNumber === 'number') loc.push(`line ${err.lineNumber}`);
  if (err && typeof err.column === 'number') loc.push(`column ${err.column}`);
  return `Handlebars error: ${message}${loc.length ? ` (${loc.join(', ')})` : ''}`;
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

// ---------------------------------------------------------------------------
// 1. render-template —— 核心：编译 + 渲染
// ---------------------------------------------------------------------------
server.tool(
  'render-template',
  '编译并渲染一个 Handlebars 模板字符串，返回渲染后的文本。支持 {{变量}} 插值、{{#each}} 循环（含 @index/@key/@first/@last 等元数据）、{{#if}}/{{#unless}}/{{#with}} 条件与作用域块、内建 helpers（lookup、log 等），以及通过 partials 参数传入的命名子模板（模板中用 {{> name}} 引用）。context 为渲染数据（JSON 对象，键对应模板变量名）。options 可控制 HTML 转义（noEscape）、严格模式（strict）等编译行为。适用于把模板+数据渲染成 HTML 或文本，例如生成邮件、报表、代码片段。',
  {
    template: z.string().min(1).describe('Handlebars 模板源码，如 "Hello {{name}}!"；循环/条件示例：{{#each items}}<li>{{this}}</li>{{/each}}'),
    context: jsonObject
      .optional()
      .describe('渲染上下文：模板变量对应的数据对象，如 {"name":"World","items":["a","b"]}；缺省为 {}'),
    partials: z
      .record(z.string(), z.string())
      .optional()
      .describe('命名 partial 表：name → partial 模板源码字符串；渲染时注册为全局 partial，模板内用 {{> name}} 引用'),
    options: compileOptions
  },
  async ({ template, context, partials, options }) => {
    try {
      const hb = Handlebars.create();
      if (partials) {
        for (const [name, src] of Object.entries(partials)) {
          hb.registerPartial(name, src);
        }
      }
      const tpl = hb.compile(template, options);
      const out = tpl(context ?? {});
      return { content: [{ type: 'text', text: String(out) }] };
    } catch (err) {
      return toolError(errorText(err));
    }
  }
);

// ---------------------------------------------------------------------------
// 2. precompile-template —— 预编译
// ---------------------------------------------------------------------------
server.tool(
  'precompile-template',
  '将 Handlebars 模板预编译为 TemplateSpecification 的 JavaScript 源码字符串（对象字面量，内含 main 编译函数），可在渲染前离线完成编译。输出可缓存、存储或写入文件，之后原样传给 render-precompiled 工具即可渲染，避免每次重复编译，适合热路径渲染、启动提速或模板分发。注意：输出是 JS 源码字符串，不是渲染结果。',
  {
    template: z.string().min(1).describe('Handlebars 模板源码，如 "Hello {{name}}!"'),
    options: z
      .object({
        data: z.boolean().optional().describe('是否生成依赖运行时 data 的编译结果（默认 true）'),
        srcName: z.string().optional().describe('模板源文件名，用于 source map'),
        destName: z.string().optional().describe('目标文件名，与 srcName 配合生成 source map'),
        knownHelpers: z
          .record(z.string(), z.boolean())
          .optional()
          .describe('声明模板中用到的 helper 名（值为 true），供编译器优化'),
        knownHelpersOnly: z.boolean().optional().describe('仅允许使用 knownHelpers 中声明的 helper'),
        strict: z.boolean().optional().describe('严格模式：引用缺失字段抛错'),
        compat: z.boolean().optional().describe('Mustache 兼容的递归向上查找'),
        noEscape: z.boolean().optional().describe('输出不做 HTML 转义'),
        preventIndent: z.boolean().optional().describe('渲染 partial 时禁止自动缩进')
      })
      .optional()
      .describe('预编译选项')
  },
  async ({ template, options }) => {
    try {
      const hb = Handlebars.create();
      const spec = hb.precompile(template, options);
      return { content: [{ type: 'text', text: String(spec) }] };
    } catch (err) {
      return toolError(errorText(err));
    }
  }
);

// ---------------------------------------------------------------------------
// 3. render-precompiled —— 用预编译 spec 渲染
// ---------------------------------------------------------------------------
server.tool(
  'render-precompiled',
  '用预编译的模板 spec 渲染输出文本。spec 是 precompile-template 工具的输出（JS 对象字面量源码字符串），或任何包含 main 编译函数的等价预编译模板 spec。与直接渲染相比省去每次编译的开销。注意：预编译模板 spec 本质上是可执行的 JavaScript 代码，请只传入由可信来源（如 precompile-template）生成的 spec，不要传入不可信内容。',
  {
    spec: z.string().min(1).describe('预编译模板 spec 源码字符串（precompile-template 的输出，形如 {"compiler":[8,...],"main":function(...){...}}）'),
    context: jsonObject.optional().describe('渲染上下文数据对象；缺省为 {}')
  },
  async ({ spec, context }) => {
    try {
      const hb = Handlebars.create();
      // eslint-disable-next-line no-new-func
      const specObj = Function('return (' + spec + ')')();
      const tpl = hb.template(specObj);
      const out = tpl(context ?? {});
      return { content: [{ type: 'text', text: String(out) }] };
    } catch (err) {
      return toolError(errorText(err));
    }
  }
);

// ---------------------------------------------------------------------------
// 4. validate-template —— 语法/编译校验
// ---------------------------------------------------------------------------
server.tool(
  'validate-template',
  '校验 Handlebars 模板的语法与编译是否通过，不执行渲染。返回 JSON 文本：{"valid": true|false, "errors": [{"message": string, "line": number|null, "column": number|null}]}。模板含语法错误（如未闭合的 {{#if}}、非法表达式、bad partial 语法）时 valid 为 false 并给出错误信息与行列位置。适合在渲染前对模板做门禁校验，或让 LLM 先自查生成的模板再渲染。',
  {
    template: z.string().describe('待校验的 Handlebars 模板源码'),
    options: compileOptions
  },
  async ({ template, options }) => {
    try {
      const hb = Handlebars.create();
      // 4.7.8 的 compile() 是懒编译（首次 render 才 parse），这里用 _setup({}) 强制
      // 触发编译，使语法错误（如未闭合的 {{#if}}）与编译期错误能立即抛出。
      const tpl = hb.compile(template, options);
      tpl._setup({});
      return {
        content: [{ type: 'text', text: JSON.stringify({ valid: true, errors: [] }) }]
      };
    } catch (err) {
      const errors = [
        {
          message: err && err.message ? err.message : String(err),
          line: err && typeof err.lineNumber === 'number' ? err.lineNumber : null,
          column: err && typeof err.column === 'number' ? err.column : null
        }
      ];
      return {
        content: [{ type: 'text', text: JSON.stringify({ valid: false, errors }) }]
      };
    }
  }
);

// ---------------------------------------------------------------------------
// 启动 stdio 传输；stdin 关闭（客户端断开/EOF）后干净退出
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);

process.stdin.on('end', () => {
  // 给在途响应留出极短收尾时间，随后确保进程退出（不悬挂）
  setTimeout(() => process.exit(0), 200);
});
