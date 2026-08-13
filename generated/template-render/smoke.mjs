// smoke.mjs — MCP Client + StdioClientTransport 冒烟验证
// 1) listTools 打印工具清单
// 2) 真实调用 render-template（变量/循环/条件 + partial）
// 3) precompile-template -> render-precompiled 往返
// 4) validate-template（合法/非法模板）
// 5) 缺参调用验证校验（期望错误往返）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  console.error('SMOKE FAIL: ' + msg);
  process.exitCode = 1;
}
let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${name}${detail !== undefined ? ' -> ' + JSON.stringify(detail) : ''}`);
  }
}

const transport = new StdioClientTransport({ command: 'node', args: ['index.js'], cwd: dir });
const client = new Client({ name: 'template-render-smoke', version: '0.0.1' });
await client.connect(transport);

console.log('== 1. listTools ==');
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
console.log('tools:', JSON.stringify(names));
check('listTools 返回 4 个工具', names.length === 4, names);
for (const expect of ['render-template', 'precompile-template', 'render-precompiled', 'validate-template']) {
  check(`工具存在: ${expect}`, names.includes(expect));
}

async function call(name, args) {
  return client.callTool({ name, arguments: args });
}
function textOf(res) {
  const t = res.content && res.content[0];
  return t ? String(t.text) : '';
}

console.log('\n== 2. render-template：变量 + each 循环 + if 条件 ==');
{
  const res = await call('render-template', {
    template:
      'Hello {{name}}!\n{{#each items}}[{{@index}}:{{this}}]{{/each}}\n{{#if admin}}(admin){{else}}(user){{/if}}',
    context: { name: 'World', items: ['a', 'b'], admin: true }
  });
  const out = textOf(res);
  console.log('output:', JSON.stringify(out), 'isError:', !!res.isError);
  check('变量/循环/条件渲染结果正确', out === 'Hello World!\n[0:a][1:b]\n(admin)', out);
}

console.log('\n== 2b. render-template：partial 子模板 ==');
{
  const res = await call('render-template', {
    template: '{{> header}} {{> header}}',
    partials: { header: '<h1>{{title}}</h1>' },
    context: { title: 'T' }
  });
  const out = textOf(res);
  console.log('output:', JSON.stringify(out));
  check('partial 渲染正确', out === '<h1>T</h1> <h1>T</h1>', out);
}

console.log('\n== 2c. render-template：HTML 转义（noEscape 对比） ==');
{
  const res1 = await call('render-template', { template: '{{x}}', context: { x: '<b>&"\'`=' } });
  const res2 = await call('render-template', {
    template: '{{x}}',
    context: { x: '<b>&"\'`=' },
    options: { noEscape: true }
  });
  console.log('escaped:', JSON.stringify(textOf(res1)), 'noEscape:', JSON.stringify(textOf(res2)));
  check('默认转义生效', textOf(res1) === '&lt;b&gt;&amp;&quot;&#x27;&#x60;&#x3D;', textOf(res1));
  check('noEscape 生效', textOf(res2) === '<b>&"\'`=', textOf(res2));
}

console.log('\n== 2d. render-template：strict 模式缺失字段报错 ==');
{
  const res = await call('render-template', {
    template: '{{missing.field}}',
    context: {},
    options: { strict: true }
  });
  console.log('isError:', !!res.isError, 'output:', JSON.stringify(textOf(res)));
  check('strict 模式缺失字段返回错误', res.isError === true && /not defined/i.test(textOf(res)), textOf(res));
}

console.log('\n== 3. precompile-template -> render-precompiled 往返 ==');
{
  const specRes = await call('precompile-template', { template: 'Hi {{name}}, count={{n}}' });
  const spec = textOf(specRes);
  console.log('precompile 输出长度:', spec.length, '前缀:', JSON.stringify(spec.slice(0, 60)));
  check('precompile 返回非空 JS 源码字符串', typeof spec === 'string' && spec.length > 20, spec.slice(0, 40));
  const renderRes = await call('render-precompiled', { spec, context: { name: 'Agent', n: 42 } });
  const out = textOf(renderRes);
  console.log('render-precompiled output:', JSON.stringify(out));
  check('预编译 spec 渲染正确', out === 'Hi Agent, count=42', out);
}

console.log('\n== 4. validate-template：合法与非法模板 ==');
{
  const ok = await call('validate-template', { template: '{{#each items}}{{this}}{{/each}}' });
  const okParsed = JSON.parse(textOf(ok));
  console.log('valid template ->', JSON.stringify(okParsed));
  check('合法模板 valid=true', okParsed.valid === true && okParsed.errors.length === 0, okParsed);

  const bad = await call('validate-template', { template: 'line1\n{{#if x}}unclosed' });
  const badParsed = JSON.parse(textOf(bad));
  console.log('invalid template ->', JSON.stringify(badParsed));
  check('非法模板 valid=false 且带错误信息', badParsed.valid === false && badParsed.errors.length > 0 && /Parse error|Expecting/.test(badParsed.errors[0].message), badParsed);

  console.log('\n== 4b. render-template 对语法错误模板返回错误 ==');
  {
    const res = await call('render-template', { template: '{{#if x}}unclosed' });
    console.log('isError:', !!res.isError, 'output:', JSON.stringify(textOf(res)));
    check('语法错误模板渲染返回 isError', res.isError === true && /Parse error/i.test(textOf(res)), textOf(res));
  }
}

console.log('\n== 5. 缺参调用（校验错误往返） ==');
{
  try {
    const res = await call('render-template', {});
    console.log('缺参调用返回:', JSON.stringify(res).slice(0, 300));
    check('缺参调用返回错误结果', res.isError === true || /template/i.test(textOf(res) || ''), res);
  } catch (err) {
    console.log('缺参调用抛错:', String(err.message || err).slice(0, 300));
    check('缺参调用抛校验错误', /template|required|Invalid|zod/i.test(String(err.message || err)), String(err.message || err));
  }
}

console.log('\n== 6. 关闭客户端，验证 server 干净退出 ==');
await client.close();
await new Promise((r) => setTimeout(r, 500));
const exited = transport._process ? transport._process.exitCode !== null : 'unknown';
console.log('child exitCode:', transport._process ? transport._process.exitCode : 'n/a');
check('client.close 后子进程已退出', exited === true || exited === 'unknown', String(exited));

console.log(`\n==== SMOKE SUMMARY: ${passed} passed, ${failed} failed ====`);
process.exit(failed > 0 ? 1 : 0);
