#!/usr/bin/env node
/**
 * 冒烟验证 @dsh-index/pdf-report MCP stdio server（pdf-lib + @pdf-lib/fontkit + Noto Sans CJK SC）。
 *
 * 流程：
 *   1. listTools() 打印工具清单
 *   2. create-report-pdf：中文报告（标题/元信息/多章节/长段落）→ 验证 PDF 字节头、页数 > 1（自动分页）
 *   3. 用 pdf-extract 侧验证中文字形确实被渲染（pdf-parse 提取文本含中文）
 *   4. outputPath 落盘 → 验证文件存在且为 %PDF 头
 *   5. 缺参调用 → 验证参数校验
 *
 * 运行：node smoke.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
function check(label, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`);
  } else {
    failures += 1;
    console.error(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

const client = new Client({ name: 'pdf-report-smoke', version: '0.0.1' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js'],
  cwd: new URL('.', import.meta.url).pathname
});

// 长段落正文（强制自动换行 + 分页）
const longParagraph = Array.from({ length: 60 }, (_, i) =>
  `这是报告正文第${i + 1}句：网页研究助手抓取页面后提取正文并生成 PDF 报告。`
).join('');

let createdPdf = null;

try {
  await client.connect(transport);
  console.log('== 已连接 stdio server ==');

  // 1. listTools
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  console.log(`\n== listTools（${tools.tools.length} 个工具）==`);
  for (const t of tools.tools) console.log(`  - ${t.name}`);
  check('含 create-report-pdf', names.includes('create-report-pdf'));

  // 2. 中文报告生成
  console.log('\n== create-report-pdf（中文报告）==');
  let res = await client.callTool({
    name: 'create-report-pdf',
    arguments: {
      title: '人工智能与网页研究综述报告',
      metaLines: ['来源：https://example.com/ai-review', '抓取时间：2026-08-13 10:30', '作者：张三'],
      sections: [
        { heading: '一、研究背景', paragraphs: ['人工智能技术正在快速改变信息获取方式。' + longParagraph] },
        { heading: '二、核心发现', paragraphs: ['正文提取算法在中文页面上的准确率显著提升。', '自动分页与换行功能验证通过。'] },
        { heading: '三、结论', paragraphs: ['网页研究助手具备完整的抓取、提取、报告与入库能力。'] }
      ]
    }
  });
  if (res.isError) {
    console.error('  server 返回错误:', res.content[0]?.text);
    check('中文报告生成成功', false);
  } else {
    const payload = JSON.parse(res.content[0].text);
    createdPdf = payload.pdfBase64;
    console.log(`  生成结果: pageCount=${payload.pageCount}, byteLength=${payload.byteLength}`);
    check('返回 Base64 且以 %PDF 开头', typeof createdPdf === 'string' && Buffer.from(createdPdf, 'base64').subarray(0, 5).toString() === '%PDF-');
    check('长报告自动分页（pageCount >= 2）', payload.pageCount >= 2, `pageCount=${payload.pageCount}`);
  }

  // 3. 用 pdf-extract（pdf-parse）验证中文字形渲染进文本层
  console.log('\n== 交叉验证（pdf-parse 提取文本）==');
  const xpath = join('/tmp', `pdf-report-xcheck-${Date.now()}.pdf`);
  writeFileSync(xpath, Buffer.from(createdPdf, 'base64'));
  const pdfParseDir = '/Users/tongtao/code/dsh-assembler/generated/pdf-extract';
  let extracted = null;
  try {
    const client2 = new Client({ name: 'pdf-extract-crosscheck', version: '0.0.1' });
    const transport2 = new StdioClientTransport({
      command: 'node',
      args: ['index.js'],
      cwd: pdfParseDir
    });
    await client2.connect(transport2);
    const r2 = await client2.callTool({
      name: 'get-pdf-text',
      arguments: { path: xpath }
    });
    extracted = r2.content[0]?.text ?? '';
    await client2.close().catch(() => {});
  } catch (e) {
    console.error('  交叉验证失败（跳过）:', e.message);
  }
  rmSync(xpath, { force: true });
  if (extracted !== null) {
    check('渲染文本包含中文标题', /人工智能与网页研究综述报告/.test(extracted), extracted.slice(0, 80));
    check('渲染文本包含英文 URL', /example\.com/.test(extracted));
    check('渲染文本包含正文中文', /研究背景/.test(extracted) && /核心发现/.test(extracted));
  } else {
    check('交叉验证可执行', false, 'pdf-parse 不可用');
  }

  // 4. outputPath 落盘
  console.log('\n== outputPath 落盘 ==');
  const outPath = join('/tmp', `pdf-report-smoke-${Date.now()}.pdf`);
  res = await client.callTool({
    name: 'create-report-pdf',
    arguments: {
      title: '落盘测试报告',
      sections: [{ paragraphs: ['验证 outputPath 参数可以把 PDF 直接写入磁盘。'] }],
      outputPath: outPath
    }
  });
  const outPayload = JSON.parse(res.content[0].text);
  const fileHeader = readFileSync(outPath).subarray(0, 5).toString();
  console.log(`  ${outPath} 字节头: ${JSON.stringify(fileHeader)}`);
  check('outputPath 返回值正确', outPayload.outputPath === outPath);
  check('落盘文件以 %PDF- 开头', fileHeader === '%PDF-');
  rmSync(outPath, { force: true });

  // 5. 缺参
  console.log('\n== 参数校验（缺 title/sections）==');
  res = await client.callTool({ name: 'create-report-pdf', arguments: {} });
  const missingErr = res.isError === true || /Invalid arguments|expected string|至少/i.test(res.content[0]?.text ?? '');
  console.log(`  isError=${res.isError} text=${JSON.stringify(res.content[0]?.text ?? '').slice(0, 100)}`);
  check('缺参触发校验错误', missingErr);
} catch (err) {
  failures += 1;
  console.error('冒烟流程异常:', err);
} finally {
  await client.close().catch(() => {});
}

console.log(`\n==== 冒烟结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`);
process.exit(failures === 0 ? 0 : 1);
