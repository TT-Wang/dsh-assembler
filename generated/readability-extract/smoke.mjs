#!/usr/bin/env node
/**
 * 冒烟验证 @dsh-index/readability-extract MCP stdio server（@mozilla/readability + jsdom）。
 *
 * 流程：
 *   1. listTools() 打印工具清单
 *   2. extract-article：中文文章页 HTML（含导航/广告/页脚噪音）→ 验证标题与正文提取
 *   3. extract-article：英文页面 → 验证提取
 *   4. extract-article：导航页（噪音页）→ 验证 isError
 *   5. extract-batch：两篇混合 → 验证 per-item 结果
 *   6. 缺参调用 → 验证参数校验
 *
 * 运行：node smoke.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
function check(label, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`);
  } else {
    failures += 1;
    console.error(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

const client = new Client({ name: 'readability-smoke', version: '0.0.1' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js'],
  cwd: new URL('.', import.meta.url).pathname
});

// 一篇足够长的中文文章页：含导航、广告、脚注噪音
const articleBody = Array.from({ length: 30 }, (_, i) =>
  `<p>这是正文第${i + 1}段。网页研究助手需要从抓取的 HTML 中提取正文内容，剥离导航、广告和页脚等噪音，保留文章主体。Readability 算法会自动识别候选正文块并打分。这一段用于让正文长度超过字符阈值，确保提取流程覆盖真实场景。</p>`
).join('\n');
const zhHtml = `<!DOCTYPE html><html lang="zh-CN"><head><title>人工智能与网页研究综述 - 示例站点</title><meta name="author" content="张三"></head><body>
<nav><a href="/">首页</a><a href="/news">新闻</a><a href="/about">关于</a></nav>
<header><h1>人工智能与网页研究综述</h1></header>
<div class="ad">限时促销！点击购买！</div>
<main><article>
${articleBody}
</article></main>
<footer>版权所有 2026 示例站点 | 友情链接 | 隐私政策</footer>
<script>console.log('noise');</script>
</body></html>`;

const enBody = Array.from({ length: 25 }, (_, i) =>
  `<p>This is paragraph ${i + 1} of the article. Web research assistants fetch pages, extract readable content, generate reports, and store results in a database for later retrieval and analysis.</p>`
).join('\n');
const enHtml = `<!DOCTYPE html><html lang="en"><head><title>Web Research in Practice</title></head><body>
<div class="nav">Home About Contact</div>
<div class="banner">Buy now! Special offer!</div>
<article><h1>Web Research in Practice</h1>${enBody}</article>
<div class="related">Other articles you may like</div>
</body></html>`;

const noiseHtml = `<!DOCTYPE html><html><head><title>Portal</title></head><body>
<nav><a>One</a><a>Two</a><a>Three</a></nav><div>Welcome to our portal</div></body></html>`;

try {
  await client.connect(transport);
  console.log('== 已连接 stdio server ==');

  // 1. listTools
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  console.log(`\n== listTools（${tools.tools.length} 个工具）==`);
  for (const t of tools.tools) console.log(`  - ${t.name}`);
  check('含 extract-article', names.includes('extract-article'));
  check('含 extract-batch', names.includes('extract-batch'));

  // 2. 中文文章
  console.log('\n== extract-article（中文）==');
  let res = await client.callTool({ name: 'extract-article', arguments: { html: zhHtml, url: 'https://example.com/ai-review' } });
  const zh = JSON.parse(res.content[0].text);
  console.log(`  title=${zh.title} byline=${zh.byline} length=${zh.length}`);
  check('中文标题来自文档 <title>', zh.title === '人工智能与网页研究综述 - 示例站点', zh.title);
  check('中文 byline 提取', zh.byline === '张三', zh.byline);
  check('中文正文含内容且不含广告', zh.textContent.includes('正文第15段') && !zh.textContent.includes('限时促销'), `len=${zh.textContent.length}`);
  check('中文正文不含页脚', !zh.textContent.includes('版权所有'), '');

  // 3. 英文文章
  console.log('\n== extract-article（英文）==');
  res = await client.callTool({ name: 'extract-article', arguments: { html: enHtml, url: 'https://example.com/en' } });
  const en = JSON.parse(res.content[0].text);
  check('英文标题提取', en.title === 'Web Research in Practice', en.title);
  check('英文正文含内容且不含广告', en.textContent.includes('paragraph 20') && !en.textContent.includes('Buy now'), `len=${en.textContent.length}`);
  check('英文 lang 检测', en.lang === 'en', en.lang);

  // 4. 噪音页 → isError
  console.log('\n== extract-article（导航页，应失败）==');
  res = await client.callTool({ name: 'extract-article', arguments: { html: noiseHtml } });
  const noiseIsError = res.isError === true || /未能识别正文|阈值/i.test(res.content[0]?.text ?? '');
  console.log(`  isError=${res.isError} text=${JSON.stringify(res.content[0]?.text ?? '').slice(0, 120)}`);
  check('噪音页返回错误', noiseIsError);

  // 5. extract-batch 混合
  console.log('\n== extract-batch ==');
  res = await client.callTool({
    name: 'extract-batch',
    arguments: { items: [{ html: zhHtml, url: 'https://a.example/x' }, { html: noiseHtml }] }
  });
  const batch = JSON.parse(res.content[0].text);
  check('批量 2 项返回', batch.results.length === 2, JSON.stringify(batch.results.map((r) => [r.index, r.ok])));
  check('第 1 项成功', batch.results[0].ok === true && batch.results[0].index === 0);
  check('第 2 项失败但不影响第 1 项', batch.results[1].ok === false && batch.results[1].index === 1);

  // 6. 缺参
  console.log('\n== 参数校验（缺 html）==');
  res = await client.callTool({ name: 'extract-article', arguments: {} });
  const missingErr = res.isError === true || /缺少必填参数 html|Invalid arguments|expected string/i.test(res.content[0]?.text ?? '');
  check('缺 html 触发校验错误', missingErr);
} catch (err) {
  failures += 1;
  console.error('冒烟流程异常:', err);
} finally {
  await client.close().catch(() => {});
}

console.log(`\n==== 冒烟结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`);
process.exit(failures === 0 ? 0 : 1);
