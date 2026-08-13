/**
 * 冒烟验证 @dsh-index/xml-parse MCP stdio server（fast-xml-parser@4.4.0）。
 *
 * 流程：
 *   1. 通过 StdioClientTransport 启动本仓库 index.js（node index.js）
 *   2. listTools() 打印工具清单
 *   3. 真实调用 xml-validate / xml-parse / xml-build：
 *      - 校验良构与非法 XML
 *      - 解析 XML（含属性、数字、重复标签）为 JSON
 *      - 往返：解析 → 构建 → 再解析，断言 JSON 一致
 *      - 构建：格式化输出、顶层数组自动包装、JSON 字符串入参
 *   4. 用缺参调用（缺 xml / 缺 json）验证参数校验生效（isError=true）
 *
 * 运行：node smoke.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const XML_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<book id="1" lang="zh">
  <title>XML 指南</title>
  <price currency="USD">39.99</price>
  <tags>
    <tag>xml</tag>
    <tag>parser</tag>
  </tags>
</book>`;

const INVALID_XML = '<book><title>未闭合</book>';

let failures = 0;
function check(label, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`);
  } else {
    failures += 1;
    console.error(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

const client = new Client({ name: 'xml-parse-smoke', version: '0.0.1' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js'],
  cwd: new URL('.', import.meta.url).pathname
});

let roundtripOk = false;

try {
  await client.connect(transport);
  console.log('== 已连接 stdio server ==');

  // 1. listTools
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  console.log(`\n== listTools（${tools.tools.length} 个工具）==`);
  for (const t of tools.tools) {
    console.log(`  - ${t.name}: ${String(t.description).slice(0, 90)}…`);
  }
  check('工具清单包含 3 个工具', tools.tools.length === 3, JSON.stringify(names));
  check('含 xml-validate', names.includes('xml-validate'));
  check('含 xml-parse', names.includes('xml-parse'));
  check('含 xml-build', names.includes('xml-build'));

  // 2. xml-validate：良构
  console.log('\n== xml-validate（良构）==');
  let res = await client.callTool({ name: 'xml-validate', arguments: { xml: XML_DOC } });
  const vOk = JSON.parse(res.content[0].text);
  console.log(`  结果: ${JSON.stringify(vOk)}`);
  check('xml-validate 良构返回 valid:true', vOk.valid === true);

  // 3. xml-validate：非法
  console.log('\n== xml-validate（非法）==');
  res = await client.callTool({ name: 'xml-validate', arguments: { xml: INVALID_XML } });
  const vBad = JSON.parse(res.content[0].text);
  console.log(`  结果: ${JSON.stringify(vBad)}（isError=${res.isError}）`);
  check('xml-validate 非法返回 valid:false', vBad.valid === false);
  check('xml-validate 带错误码/行列', typeof vBad.error?.code === 'string' && typeof vBad.error?.line === 'number');

  // 4. xml-parse：保留属性 + 数字解析 + 重复标签成数组
  console.log('\n== xml-parse（ignoreAttributes:false）==');
  res = await client.callTool({
    name: 'xml-parse',
    arguments: { xml: XML_DOC, options: { ignoreAttributes: false } }
  });
  const p1 = JSON.parse(res.content[0].text).parsed;
  console.log(`  解析结果: ${JSON.stringify(p1)}`);
  check('xml-parse 解析出 id 属性', p1.book?.['@_id'] === '1');
  check('xml-parse 解析出 title 文本', p1.book?.title === 'XML 指南');
  check('xml-parse 数字自动转换 price=39.99', p1.book?.price?.['#text'] === 39.99);
  check('xml-parse 保留属性 currency', p1.book?.price?.['@_currency'] === 'USD');
  check('xml-parse 重复标签成数组', Array.isArray(p1.book?.tags?.tag) && p1.book.tags.tag.length === 2);

  // 5. xml-parse：非法 XML 默认校验报错
  console.log('\n== xml-parse（非法 XML，validate 默认 true）==');
  res = await client.callTool({ name: 'xml-parse', arguments: { xml: INVALID_XML } });
  const pBad = JSON.parse(res.content[0].text);
  console.log(`  结果: ${JSON.stringify(pBad)}（isError=${res.isError}）`);
  check('xml-parse 非法输入返回校验错误', res.isError === true && typeof pBad.code === 'string');

  // 6. xml-build：格式化输出 + 往返一致性
  console.log('\n== xml-build（format:true）==');
  res = await client.callTool({
    name: 'xml-build',
    arguments: {
      json: p1,
      options: { format: true, ignoreAttributes: false }
    }
  });
  const b1 = JSON.parse(res.content[0].text);
  console.log(`  构建 XML:\n${b1.xml}`);
  check('xml-build 返回 xml 字符串', typeof b1.xml === 'string' && b1.xml.length > 0);
  check('xml-build format 输出多行缩进', b1.xml.includes('\n') && b1.xml.includes('  <title>'));

  console.log('\n== 往返：解析 → 构建 → 再解析 ==');
  res = await client.callTool({
    name: 'xml-parse',
    arguments: { xml: b1.xml, options: { ignoreAttributes: false } }
  });
  const p2 = JSON.parse(res.content[0].text).parsed;
  const same = JSON.stringify(p1) === JSON.stringify(p2);
  console.log(`  再解析: ${JSON.stringify(p2)}`);
  console.log(`  与首次解析一致: ${same}`);
  check('往返后 JSON 一致', same);
  roundtripOk = same;

  // 7. xml-build：顶层数组自动包装
  console.log('\n== xml-build（顶层数组自动包装）==');
  res = await client.callTool({
    name: 'xml-build',
    arguments: { json: [{ item: 'a' }, { item: 'b' }] }
  });
  const bArr = JSON.parse(res.content[0].text);
  console.log(`  结果: ${JSON.stringify(bArr)}`);
  check('xml-build 顶层数组以 root 包装', bArr.xml.startsWith('<root>') && bArr.xml.includes('<item>a</item>'));
  check('xml-build 自动包装带 note 说明', typeof bArr.note === 'string');

  // 8. xml-build：JSON 字符串入参
  console.log('\n== xml-build（JSON 字符串入参）==');
  res = await client.callTool({
    name: 'xml-build',
    arguments: { json: '{"user":{"name":"张三","age":30}}', options: { format: true } }
  });
  const bStr = JSON.parse(res.content[0].text);
  console.log(`  结果: ${JSON.stringify(bStr)}`);
  check('xml-build JSON 字符串入参成功', bStr.xml.includes('<name>张三</name>'));

  // 9. 参数校验：缺参
  console.log('\n== 参数校验（缺参）==');
  res = await client.callTool({ name: 'xml-parse', arguments: {} });
  console.log(`  xml-parse 缺 xml: isError=${res.isError} text=${JSON.stringify(res.content[0]?.text)}`);
  check('xml-parse 缺 xml 触发校验错误', res.isError === true || /缺少必填参数|Invalid arguments|expected string/i.test(res.content[0]?.text ?? ''));

  res = await client.callTool({ name: 'xml-validate', arguments: {} });
  console.log(`  xml-validate 缺 xml: isError=${res.isError} text=${JSON.stringify(res.content[0]?.text)}`);
  check('xml-validate 缺 xml 触发校验错误', res.isError === true || /缺少必填参数|Invalid arguments|expected string/i.test(res.content[0]?.text ?? ''));

  res = await client.callTool({ name: 'xml-build', arguments: {} });
  console.log(`  xml-build 缺 json: isError=${res.isError} text=${JSON.stringify(res.content[0]?.text)}`);
  check('xml-build 缺 json 触发校验错误', res.isError === true || /缺少必填参数|Invalid arguments|expected string/i.test(res.content[0]?.text ?? ''));

  // 10. xml-build：非法 JSON 字符串
  console.log('\n== xml-build（非法 JSON 字符串）==');
  res = await client.callTool({ name: 'xml-build', arguments: { json: '{not json' } });
  console.log(`  结果: isError=${res.isError} text=${JSON.stringify(res.content[0]?.text)}`);
  check('xml-build 非法 JSON 字符串返回清晰错误', res.isError === true && /不是合法 JSON 字符串/.test(res.content[0]?.text ?? ''));
} catch (err) {
  failures += 1;
  console.error('冒烟流程异常:', err);
} finally {
  await client.close().catch(() => {});
}

console.log(`\n==== 冒烟结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`);
process.exit(failures === 0 ? 0 : 1);
