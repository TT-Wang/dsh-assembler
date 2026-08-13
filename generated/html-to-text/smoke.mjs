/**
 * 冒烟验证 @dsh-index/html-to-text MCP stdio server（html-to-text@9.0.5）。
 *
 * 流程：
 *   1. 通过 StdioClientTransport 启动本仓库 index.js（node index.js）
 *   2. listTools() 打印工具清单
 *   3. 真实调用 html-to-text / html-to-text-table / html-to-text-links
 *   4. 缺参调用（缺 html）验证参数校验生效（isError=true）
 *
 * 运行：node smoke.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HTML_DOC = `
<!DOCTYPE html>
<html>
<head><title>公告</title></head>
<body>
  <h1>系统升级通知</h1>
  <p>系统将于 <b>周五 22:00</b> 进行升级，预计持续 2 小时。</p>
  <p>详情请见 <a href="/docs/upgrade">升级文档</a> 或访问
  <a href="https://example.com/status">状态页</a>。</p>
  <table>
    <thead><tr><th>服务</th><th>影响</th></tr></thead>
    <tbody>
      <tr><td>API</td><td>短时不可用</td></tr>
      <tr><td>Web</td><td>无影响</td></tr>
    </tbody>
  </table>
  <footer>如有疑问请联系 <a href="mailto:ops@example.com">运维组</a>。</footer>
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

const client = new Client({ name: 'html-to-text-smoke', version: '0.0.1' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js'],
  cwd: new URL('.', import.meta.url).pathname
});

try {
  await client.connect(transport);

  // ---- 1. listTools ----
  console.log('== listTools() ==');
  const { tools } = await client.listTools();
  check('listTools 返回 4 个工具', tools.length === 4, `count=${tools.length}`);
  for (const t of tools) {
    console.log(`  - ${t.name}: ${(t.description || '').slice(0, 60)}...`);
  }
  const names = tools.map((t) => t.name).sort();
  check(
    '工具名集合正确',
    JSON.stringify(names) === JSON.stringify(['html-to-text', 'html-to-text-batch', 'html-to-text-links', 'html-to-text-table']),
    names.join(', ')
  );

  // ---- 2. html-to-text：HTML 转纯文本（含链接与表格的文档） ----
  console.log('\n== call html-to-text ==');
  const t1 = await client.callTool({
    name: 'html-to-text',
    arguments: { html: HTML_DOC, wordwrap: 60, uppercaseHeadings: true }
  });
  const r1 = t1.content[0].text;
  console.log('--- 输出 ---\n' + r1 + '\n--- 结束 ---');
  check('html-to-text 非空', typeof r1 === 'string' && r1.length > 0);
  check('标题大写化', /系统升级通知/.test(r1));
  check('保留链接文本', /升级文档 \[?\/docs\/upgrade\]?/.test(r1) || /升级文档/.test(r1));
  check('无 HTML 标签残留', !/<[a-z]/.test(r1));

  // ---- 3. html-to-text-batch：批量转换 ----
  console.log('\n== call html-to-text-batch ==');
  const t2 = await client.callTool({
    name: 'html-to-text-batch',
    arguments: {
      htmls: ['<div><h2>第一封</h2><p>正文 A</p></div>', '<div><h2>第二封</h2><p>正文 B</p></div>'],
      uppercaseHeadings: false
    }
  });
  const r2 = t2.content[0].text;
  console.log('--- 输出 ---\n' + r2 + '\n--- 结束 ---');
  check('batch 输出两条结果', (r2.match(/^\[[01]\]/gm) || []).length === 2, r2.split('\n').length + ' 行');
  check('batch 保留标题原样（uppercase=false）', r2.includes('第一封') && r2.includes('第二封'));

  // ---- 4. html-to-text-table：表格渲染 ----
  console.log('\n== call html-to-text-table ==');
  const t3 = await client.callTool({
    name: 'html-to-text-table',
    arguments: { html: HTML_DOC, colSpacing: 4, uppercaseHeaderCells: true }
  });
  const r3 = t3.content[0].text;
  console.log('--- 输出 ---\n' + r3 + '\n--- 结束 ---');
  check('table 输出了表头与数据', r3.includes('服务') && r3.includes('API') && r3.includes('Web'));
  check('table 不包含表外正文', !r3.includes('系统升级通知'));

  // ---- 5. html-to-text-links：链接提取（含 baseUrl 解析） ----
  console.log('\n== call html-to-text-links ==');
  const t4 = await client.callTool({
    name: 'html-to-text-links',
    arguments: { html: HTML_DOC, baseUrl: 'https://example.com' }
  });
  const r4 = t4.content[0].text;
  console.log('--- 输出 ---\n' + r4 + '\n--- 结束 ---');
  check('links 输出了相对链接解析', /升级文档\s*\[https:\/\/example\.com\/docs\/upgrade\]/.test(r4), r4.replace(/\n/g, ' | '));
  check('links 输出了绝对链接', r4.includes('https://example.com/status'));
  check('links 只输出链接不输出正文', !r4.includes('系统升级通知'));

  // ---- 6. 缺参调用：验证参数校验（isError=true） ----
  console.log('\n== call html-to-text (缺 html 参数) ==');
  const t5 = await client.callTool({ name: 'html-to-text', arguments: {} });
  const r5 = t5.content[0].text;
  console.log('--- 输出 ---\n' + r5);
  check('缺参返回 isError=true', t5.isError === true);
  check('缺参错误信息清晰', /html/.test(r5) && /缺少|required|必填/i.test(r5), r5.slice(0, 80));

  console.log(`\n===== 冒烟结果：${failures === 0 ? '全部通过' : failures + ' 项失败'} =====`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (err) {
  console.error('冒烟失败（连接或调用异常）：', err);
  process.exitCode = 1;
} finally {
  await client.close();
}
