/**
 * 冒烟验证 @dsh-index/pdf-generate MCP stdio server（pdf-lib@1.17.1）。
 *
 * 流程：
 *   1. 通过 StdioClientTransport 启动本仓库 index.js（node index.js）
 *   2. listTools() 打印工具清单
 *   3. 真实调用 create-pdf 生成一页 PDF（检查 %PDF 字节头）
 *   4. 用生成的 PDF 调 pdf-info 验证页数/尺寸；调 extract-pages 抽取；用两页拼 merge-pdfs
 *   5. 用缺参调用（缺 pdfBase64）验证参数校验生效（isError=true）
 *   6. 用非法 base64 验证错误路径返回 isError
 *
 * 运行：node smoke.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync, readFileSync } from 'node:fs';

let failures = 0;
function check(label, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`);
  } else {
    failures += 1;
    console.error(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

const client = new Client({ name: 'pdf-generate-smoke', version: '0.0.1' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js'],
  cwd: new URL('.', import.meta.url).pathname
});

let createdPdf = null; // 由 create-pdf 生成，供后续工具复用

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
  check('工具清单包含 4 个工具', tools.tools.length === 4, JSON.stringify(names));
  check('含 create-pdf', names.includes('create-pdf'));
  check('含 merge-pdfs', names.includes('merge-pdfs'));
  check('含 extract-pages', names.includes('extract-pages'));
  check('含 pdf-info', names.includes('pdf-info'));

  // 2. create-pdf：两页文档（第 1 页自动排版，第 2 页指定尺寸与颜色）
  //    注意：pdf-lib 标准字体仅支持 Latin-1/WinAnsi，文本须用英文/西文
  console.log('\n== create-pdf ==');
  let res = await client.callTool({
    name: 'create-pdf',
    arguments: {
      pages: [
        {
          size: 'A4',
          fontSize: 14,
          lines: [
            { text: 'SALES CONTRACT', size: 22, font: 'HelveticaBold', color: '#003366' },
            { text: 'Party A: Example Tech Co., Ltd.', color: 'blue' },
            { text: 'Party B: Example Trading Co., Ltd.' },
            { text: 'This agreement takes effect upon signing.' }
          ]
        },
        {
          size: 'Letter',
          font: 'TimesRoman',
          fontSize: 11,
          lines: [
            { text: 'Appendix A: Delivery Checklist', size: 16, font: 'TimesRomanBold' },
            { text: '1. Product manual x1' },
            { text: '2. Warranty card x1' }
          ]
        }
      ]
    }
  });
  const createPayload = JSON.parse(res.content[0].text);
  console.log(`  生成结果: pageCount=${createPayload.pageCount}, byteLength=${createPayload.byteLength}`);
  check('create-pdf 生成 2 页', createPayload.pageCount === 2, `pageCount=${createPayload.pageCount}`);
  check('create-pdf 返回 Base64 且以 %PDF 开头', typeof createPayload.pdfBase64 === 'string' && Buffer.from(createPayload.pdfBase64, 'base64').subarray(0, 5).toString() === '%PDF-', Buffer.from(createPayload.pdfBase64, 'base64').subarray(0, 8).toString());
  check('create-pdf 无跳过行提示', !createPayload.note);
  createdPdf = createPayload.pdfBase64;

  // 3. pdf-info：检查生成的 PDF
  console.log('\n== pdf-info ==');
  res = await client.callTool({
    name: 'pdf-info',
    arguments: { pdfBase64: createdPdf }
  });
  const info = JSON.parse(res.content[0].text);
  console.log(`  元信息: ${JSON.stringify(info)}`);
  check('pdf-info 页数=2', info.pageCount === 2);
  check('pdf-info 第 1 页为 A4(595.28x841.89)', Math.abs(info.pageSizes[0].width - 595.28) < 0.5 && Math.abs(info.pageSizes[0].height - 841.89) < 0.5, JSON.stringify(info.pageSizes[0]));
  check('pdf-info 第 2 页为 Letter(612x792)', Math.abs(info.pageSizes[1].width - 612) < 0.5 && Math.abs(info.pageSizes[1].height - 792) < 0.5, JSON.stringify(info.pageSizes[1]));
  check('pdf-info 未加密', info.encrypted === false);

  // 4. extract-pages：从两页中抽取第 2 页
  console.log('\n== extract-pages ==');
  res = await client.callTool({
    name: 'extract-pages',
    arguments: { pdfBase64: createdPdf, pages: [1] }
  });
  const ext = JSON.parse(res.content[0].text);
  console.log(`  抽取结果: pageCount=${ext.pageCount}, sourcePageCount=${ext.sourcePageCount}`);
  check('extract-pages 抽得 1 页', ext.pageCount === 1 && ext.sourcePageCount === 2);
  check('extract-pages 输出也是合法 PDF', Buffer.from(ext.pdfBase64, 'base64').subarray(0, 5).toString() === '%PDF-');
  const extInfo = JSON.parse(
    (await client.callTool({ name: 'pdf-info', arguments: { pdfBase64: ext.pdfBase64 } })).content[0].text
  );
  check('extract-pages 抽取的是 Letter 页', Math.abs(extInfo.pageSizes[0].width - 612) < 0.5, JSON.stringify(extInfo.pageSizes[0]));

  // 5. merge-pdfs：把抽取出的单页再与原两页合并（顺序：抽取页 + 原文档全部页 = 3 页）
  console.log('\n== merge-pdfs ==');
  res = await client.callTool({
    name: 'merge-pdfs',
    arguments: {
      pdfs: [
        { base64: ext.pdfBase64 },
        { base64: createdPdf, pages: [0, 1] }
      ]
    }
  });
  const merged = JSON.parse(res.content[0].text);
  console.log(`  合并结果: ${JSON.stringify(merged.sourceDocs)}`);
  check('merge-pdfs 合并出 3 页', merged.pageCount === 3);
  check('merge-pdfs 记录各源页数', merged.sourceDocs.length === 2 && merged.sourceDocs[0].pagesTaken === 1 && merged.sourceDocs[1].pagesTaken === 2);
  check('merge-pdfs 输出合法 PDF', Buffer.from(merged.pdfBase64, 'base64').subarray(0, 5).toString() === '%PDF-');

  // 6. 参数校验：缺 pdfBase64
  console.log('\n== 参数校验（缺 pdfBase64）==');
  res = await client.callTool({
    name: 'pdf-info',
    arguments: {}
  });
  const isError = res.isError === true || /缺少必填参数 pdfBase64|Invalid arguments|expected string/i.test(res.content[0]?.text ?? '');
  console.log(`  缺参调用返回: isError=${res.isError} text=${JSON.stringify(res.content[0]?.text)}`);
  check('缺 pdfBase64 触发校验错误', isError);

  // 7. 错误路径：非法 base64
  console.log('\n== 错误路径（非法 base64）==');
  res = await client.callTool({
    name: 'pdf-info',
    arguments: { pdfBase64: 'not-a-real-base64!!' }
  });
  const badErr = res.isError === true || /base64|执行失败/i.test(res.content[0]?.text ?? '');
  console.log(`  非法 base64 返回: isError=${res.isError} text=${JSON.stringify(res.content[0]?.text)}`);
  check('非法 base64 返回错误', badErr);

  // 8. 错误路径：未知页面尺寸
  console.log('\n== 错误路径（未知纸张）==');
  res = await client.callTool({
    name: 'create-pdf',
    arguments: { pages: [{ size: 'NOPE' }] }
  });
  const badSize = res.isError === true || /未知页面尺寸|执行失败/i.test(res.content[0]?.text ?? '');
  console.log(`  未知尺寸返回: isError=${res.isError} text=${JSON.stringify(res.content[0]?.text)}`);
  check('未知页面尺寸返回错误', badSize);

  // 9. 错误路径：中文文本触发 WinAnsi 编码预检（清晰错误而非晦涩底层异常）
  console.log('\n== 错误路径（中文文本/WinAnsi 预检）==');
  res = await client.callTool({
    name: 'create-pdf',
    arguments: { pages: [{ lines: [{ text: '销售合同' }] }] }
  });
  const cjkErr = res.isError === true && /WinAnsi|非拉丁|无法编码/i.test(res.content[0]?.text ?? '');
  console.log(`  中文文本返回: isError=${res.isError} text=${JSON.stringify(res.content[0]?.text?.slice(0, 120))}`);
  check('中文文本触发 WinAnsi 预检错误', cjkErr);

  // 10. 落盘：把生成的 PDF 写到临时文件检查字节头
  console.log('\n== 落盘检查 ==');
  const tmpPath = `/tmp/pdf-generate-smoke-${Date.now()}.pdf`;
  writeFileSync(tmpPath, Buffer.from(createdPdf, 'base64'));
  const header = readFileSync(tmpPath).subarray(0, 8).toString();
  console.log(`  ${tmpPath} 字节头: ${JSON.stringify(header)}`);
  check('临时文件以 %PDF- 开头', header.startsWith('%PDF-'), header);
} catch (err) {
  failures += 1;
  console.error('冒烟流程异常:', err);
} finally {
  await client.close().catch(() => {});
}

console.log(`\n==== 冒烟结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`);
process.exit(failures === 0 ? 0 : 1);
