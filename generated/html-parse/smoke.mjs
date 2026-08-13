/**
 * 冒烟验证 @dsh-index/html-parse MCP stdio server（cheerio@1.0.0-rc.12）。
 *
 * 流程：
 *   1. 通过 StdioClientTransport 启动本仓库 index.js（node index.js）
 *   2. listTools() 打印工具清单
 *   3. 真实调用 extract-text / extract-attributes / query-elements / serialize-html
 *   4. 用缺参调用（缺 html）验证参数校验生效（isError=true）
 *
 * 运行：node smoke.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HTML_DOC = `
<!DOCTYPE html>
<html lang="zh">
<head><title>水果铺</title></head>
<body>
  <h1 class="title">水果铺</h1>
  <ul id="fruits">
    <li class="apple" data-price="5">Apple 苹果</li>
    <li class="orange" data-price="4">Orange 橙子</li>
    <li class="pear" data-price="6">Pear 梨</li>
  </ul>
  <p><a href="https://example.com/apple" title="苹果详情">苹果详情</a></p>
  <img src="/img/logo.png" alt="logo">
</body>
</html>
`;

let failures = 0;
function check(label, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`);
  } else {
    failures += 1;
    console.error(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

const client = new Client({ name: 'html-parse-smoke', version: '0.0.1' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js'],
  cwd: new URL('.', import.meta.url).pathname
});

try {
  await client.connect(transport);
  console.log('== 已连接 stdio server ==');

  // 1. listTools
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  console.log(`\n== listTools（${tools.tools.length} 个工具）==`);
  for (const t of tools.tools) {
    console.log(`  - ${t.name}: ${String(t.description).slice(0, 80)}…`);
  }
  check('工具清单包含 4 个工具', tools.tools.length === 4, JSON.stringify(names));
  check('含 extract-text', names.includes('extract-text'));
  check('含 extract-attributes', names.includes('extract-attributes'));
  check('含 query-elements', names.includes('query-elements'));
  check('含 serialize-html', names.includes('serialize-html'));

  // 2. extract-text：整篇文档文本 + 选择器
  console.log('\n== extract-text ==');
  let res = await client.callTool({
    name: 'extract-text',
    arguments: { html: HTML_DOC }
  });
  const fullText = JSON.parse(res.content[0].text).text;
  console.log(`  全文文本(${fullText.length} 字符): ${fullText.slice(0, 80).replace(/\n/g, '⏎')}…`);
  check('extract-text 全文包含 "水果铺"', fullText.includes('水果铺'));
  check('extract-text 全文包含 "Pear 梨"', fullText.includes('Pear 梨'));

  res = await client.callTool({
    name: 'extract-text',
    arguments: {
      html: HTML_DOC,
      selector: 'li',
      collapseWhitespace: true
    }
  });
  const liText = JSON.parse(res.content[0].text).text;
  console.log(`  li 文本: ${liText}`);
  check('extract-text(selector=li) 拼接三行文本', liText.includes('Apple') && liText.includes('Orange') && liText.includes('Pear'));
  check('collapseWhitespace 生效（无多余空白）', !/\n/.test(liText));

  // 3. extract-attributes：链接/图片
  console.log('\n== extract-attributes ==');
  res = await client.callTool({
    name: 'extract-attributes',
    arguments: { html: HTML_DOC, selector: 'a[href]', attributes: ['href', 'title'] }
  });
  const linkPayload = JSON.parse(res.content[0].text);
  console.log(`  链接结果: ${JSON.stringify(linkPayload)}`);
  check('extract-attributes 命中 1 个 a[href]', linkPayload.matched === 1);
  check(
    'href 提取正确',
    linkPayload.results[0]?.attrs?.href === 'https://example.com/apple'
  );

  res = await client.callTool({
    name: 'extract-attributes',
    arguments: { html: HTML_DOC, selector: 'img' }
  });
  const imgPayload = JSON.parse(res.content[0].text);
  console.log(`  img 全属性: ${JSON.stringify(imgPayload.results[0]?.attrs)}`);
  check('extract-attributes 缺省返回全部属性', imgPayload.results[0]?.attrs?.src === '/img/logo.png' && imgPayload.results[0]?.attrs?.alt === 'logo');

  // 4. query-elements：结构探查
  console.log('\n== query-elements ==');
  res = await client.callTool({
    name: 'query-elements',
    arguments: { html: HTML_DOC, selector: 'li.apple' }
  });
  const qPayload = JSON.parse(res.content[0].text);
  console.log(`  查询结果: ${JSON.stringify(qPayload)}`);
  check('query-elements 命中 1 个 li.apple', qPayload.matched === 1);
  check('query-elements 解析出 class 列表', Array.isArray(qPayload.results[0]?.classes) && qPayload.results[0].classes.includes('apple'));
  check('query-elements 带 data-price 属性', qPayload.results[0]?.attrs?.['data-price'] === '5');
  check('query-elements 文本片段正确', qPayload.results[0]?.text === 'Apple 苹果');

  // 5. serialize-html：规范化输出
  console.log('\n== serialize-html ==');
  res = await client.callTool({
    name: 'serialize-html',
    arguments: { html: '<ul><li>a<li>b</ul>', fragment: true }
  });
  const serPayload = JSON.parse(res.content[0].text);
  console.log(`  片段序列化: ${serPayload.serialized}`);
  check('serialize-html 片段模式补全闭合标签', serPayload.serialized === '<ul><li>a</li><li>b</li></ul>');

  res = await client.callTool({
    name: 'serialize-html',
    arguments: { html: '<root><item id="1"/></root>', xml: true }
  });
  const xmlPayload = JSON.parse(res.content[0].text);
  console.log(`  XML 序列化: ${xmlPayload.serialized}`);
  check('serialize-html xml 模式保留自闭合', xmlPayload.serialized.includes('<item id="1"/>') || xmlPayload.serialized.includes('<item id="1" />'));

  // 6. 参数校验：缺 html
  console.log('\n== 参数校验（缺 html）==');
  res = await client.callTool({
    name: 'extract-text',
    arguments: { selector: 'p' }
  });
  const isError = res.isError === true || (res.content && res.content[0] && /缺少必填参数 html|Invalid arguments|expected string/i.test(res.content[0].text));
  console.log(`  缺参调用返回: isError=${res.isError} text=${JSON.stringify(res.content[0]?.text)}`);
  check('缺 html 触发校验错误', isError);

  // 7. 类型错误：html 传数字
  console.log('\n== 参数校验（html 类型错误）==');
  res = await client.callTool({
    name: 'serialize-html',
    arguments: { html: 12345 }
  });
  const typeErr = res.isError === true || /expected string|类型错误|Invalid arguments/i.test(res.content[0]?.text ?? '');
  console.log(`  类型错误调用返回: isError=${res.isError} text=${JSON.stringify(res.content[0]?.text)}`);
  check('html 传数字触发校验错误', typeErr);

  // 8. 选择器未匹配：干净返回 matched=0
  console.log('\n== 选择器未匹配 ==');
  res = await client.callTool({
    name: 'extract-attributes',
    arguments: { html: HTML_DOC, selector: 'table' }
  });
  const noMatch = JSON.parse(res.content[0].text);
  console.log(`  未匹配结果: ${JSON.stringify(noMatch)}`);
  check('未匹配选择器返回 matched=0', noMatch.matched === 0 && noMatch.results.length === 0);
} catch (err) {
  failures += 1;
  console.error('冒烟流程异常:', err);
} finally {
  await client.close().catch(() => {});
}

console.log(`\n==== 冒烟结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`);
process.exit(failures === 0 ? 0 : 1);
